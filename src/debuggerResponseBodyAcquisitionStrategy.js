import { ImageAcquisitionStrategy } from "./imageAcquisitionStrategy.js";

const DEBUGGER_VERSION = "1.3";

function isLikelyImageMime(mime) {
  return typeof mime === "string" && mime.toLowerCase().startsWith("image/");
}

function debuggerAttach(debuggee) {
  return chrome.debugger.attach(debuggee, DEBUGGER_VERSION);
}

function debuggerDetach(debuggee) {
  return chrome.debugger.detach(debuggee).catch(() => {});
}

function debuggerSend(debuggee, method, commandParams = {}) {
  return chrome.debugger.sendCommand(debuggee, method, commandParams);
}

function normalizeUrl(value) {
  try {
    return new URL(value).href;
  } catch {
    return value || "";
  }
}

function tokenize(url) {
  try {
    const u = new URL(url);
    return new Set(
      `${u.hostname} ${u.pathname}`
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
    );
  } catch {
    return new Set(String(url).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  }
}

function makeDataUrl(mimeType, body, base64Encoded) {
  if (base64Encoded) {
    return `data:${mimeType};base64,${body}`;
  }

  const utf8Bytes = new TextEncoder().encode(body);
  let binary = "";
  for (const byte of utf8Bytes) {
    binary += String.fromCharCode(byte);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

export class DebuggerResponseBodyAcquisitionStrategy extends ImageAcquisitionStrategy {
  constructor({ timeoutMs = 15000 } = {}) {
    super();
    this.timeoutMs = timeoutMs;
  }

  async acquire({ tabId, pageResult }) {
    const expectedImageUrl = pageResult.imageUrl;
    const captureResult = await this.captureImageBodyViaDebugger(
      tabId,
      expectedImageUrl,
      this.timeoutMs
    );

    return {
      mode: "data-url",
      dataUrl: captureResult.dataUrl,
      imageUrl: captureResult.url || pageResult.imageUrl || null,
      mimeType: captureResult.mimeType || null,
    };
  }

  async captureImageBodyViaDebugger(tabId, expectedImageUrl, timeoutMs = 15000) {
    const debuggee = { tabId };
    await debuggerAttach(debuggee);

    const expected = normalizeUrl(expectedImageUrl);
    const expectedTokens = tokenize(expected);
    const candidates = new Map();

    let settled = false;

    return await new Promise(async (resolve, reject) => {
      const cleanup = async () => {
        chrome.debugger.onEvent.removeListener(onEvent);
        chrome.debugger.onDetach.removeListener(onDetach);
        clearTimeout(timer);
        await debuggerDetach(debuggee);
      };

      const finishResolve = async (value) => {
        if (settled) return;
        settled = true;
        await cleanup();
        resolve(value);
      };

      const finishReject = async (error) => {
        if (settled) return;
        settled = true;
        await cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const scoreCandidate = (response) => {
        const url = normalizeUrl(response?.url || "");
        const mimeType = (response?.mimeType || "").toLowerCase();
        const status = Number(response?.status || 0);

        let score = 0;

        if (mimeType.startsWith("image/")) score += 100;
        if (status >= 200 && status < 300) score += 20;

        if (expected) {
          if (url === expected) score += 300;
          if (url.includes(expected) || expected.includes(url)) score += 120;

          const urlTokens = tokenize(url);
          let overlap = 0;
          for (const token of expectedTokens) {
            if (urlTokens.has(token)) overlap += 1;
          }
          score += overlap * 15;
        }

        const lower = url.toLowerCase();
        if (/\b(sample|images|img)\b/.test(lower)) score += 25;
        if (/\b(jpe?g|png|webp|gif|avif)\b/.test(lower)) score += 10;
        if (/\b(avatar|logo|icon|banner|sprite)\b/.test(lower)) score -= 80;

        return score;
      };

      const tryGetBody = async (candidate) => {
        if (!candidate?.requestId) return false;

        try {
          const responseBody = await debuggerSend(debuggee, "Network.getResponseBody", {
            requestId: candidate.requestId,
          });

          const body = responseBody?.body;
          if (!body) return false;

          const mimeType = candidate.mimeType || "image/jpeg";
          const dataUrl = makeDataUrl(mimeType, body, Boolean(responseBody?.base64Encoded));

          await finishResolve({
            dataUrl,
            url: candidate.url || expected || null,
            mimeType,
          });
          return true;
        } catch {
          return false;
        }
      };

      const onDetach = async (_source, reason) => {
        await finishReject(new Error(`Debugger detached: ${reason}`));
      };

      const onEvent = async (source, method, params) => {
        if (source.tabId !== tabId) return;

        try {
          if (method === "Network.responseReceived") {
            const requestId = params?.requestId;
            const response = params?.response;
            if (!requestId || !response) return;
            if (!isLikelyImageMime(response.mimeType)) return;

            candidates.set(requestId, {
              requestId,
              url: response.url || "",
              mimeType: response.mimeType || "",
              status: response.status,
              encodedDataLength: 0,
              score: scoreCandidate(response),
            });
            return;
          }

          if (method === "Network.loadingFinished") {
            const requestId = params?.requestId;
            const candidate = requestId ? candidates.get(requestId) : null;
            if (!candidate) return;

            candidate.encodedDataLength = Number(params?.encodedDataLength || 0);
            candidate.finalScore =
              candidate.score + Math.min(candidate.encodedDataLength / 5000, 200);

            if (candidate.finalScore >= 380) {
              await tryGetBody(candidate);
            }
          }
        } catch (error) {
          await finishReject(error);
        }
      };

      chrome.debugger.onEvent.addListener(onEvent);
      chrome.debugger.onDetach.addListener(onDetach);

      try {
        await debuggerSend(debuggee, "Network.enable");
        await debuggerSend(debuggee, "Network.setCacheDisabled", { cacheDisabled: true });

        // Re-trigger only the image request, not the whole page reload.
        const bustUrl = (() => {
          try {
            const u = new URL(expectedImageUrl);
            u.searchParams.set("_bde_cdp", String(Date.now()));
            return u.href;
          } catch {
            const sep = String(expectedImageUrl).includes("?") ? "&" : "?";
            return `${expectedImageUrl}${sep}_bde_cdp=${Date.now()}`;
          }
        })();

        await chrome.scripting.executeScript({
          target: { tabId },
          func: (url) => {
            const img = new Image();

            // Keep a reference so it is not garbage-collected immediately.
            window.__bdeProbeImages = window.__bdeProbeImages || [];
            window.__bdeProbeImages.push(img);

            img.decoding = "async";
            img.loading = "eager";
            img.referrerPolicy = "no-referrer-when-downgrade";

            img.onload = () => {
              setTimeout(() => {
                const arr = window.__bdeProbeImages || [];
                const idx = arr.indexOf(img);
                if (idx >= 0) arr.splice(idx, 1);
              }, 3000);
            };

            img.onerror = () => {
              setTimeout(() => {
                const arr = window.__bdeProbeImages || [];
                const idx = arr.indexOf(img);
                if (idx >= 0) arr.splice(idx, 1);
              }, 3000);
            };

            img.src = url;
          },
          args: [bustUrl],
        });
      } catch (error) {
        await finishReject(error);
        return;
      }

      const timer = setTimeout(async () => {
        try {
          const bestCandidate = [...candidates.values()]
            .sort((a, b) => (b.finalScore || b.score || 0) - (a.finalScore || a.score || 0))[0];

          if (!bestCandidate) {
            await finishReject(
              new Error("Timed out while waiting for a matching image response body.")
            );
            return;
          }

          const ok = await tryGetBody(bestCandidate);
          if (!ok) {
            await finishReject(
              new Error("Timed out while waiting for the image response body.")
            );
          }
        } catch (error) {
          await finishReject(error);
        }
      }, timeoutMs);
    });
  }
}