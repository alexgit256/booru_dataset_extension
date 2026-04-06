import { DEFAULT_SETTINGS, MESSAGE_TYPES, STORAGE_KEYS } from "./config.js";
import { TagFormatter } from "./formatter.js";
import { FileManager } from "./fileManager.js";
import { formatTagsFileContent, formatDebugTagsFileContent } from "./formatter.js";

const DEBUGGER_VERSION = "1.3";

function isLikelyImageMime(mime) {
  return typeof mime === "string" && mime.toLowerCase().startsWith("image/");
}

function mimeToExtension(mime) {
  switch ((mime || "").toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    case "image/bmp":
      return "bmp";
    default:
      return null;
  }
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

// const RULE34US_CACHE_PREFIX = "rule34usImageCache:";
// const RULE34US_PAGE_CACHE_PREFIX = "rule34usPageCache:";

function getRule34UsCacheKey(postId) {
  return `${RULE34US_CACHE_PREFIX}${postId}`;
}

function getRule34UsPageCacheKey(pageUrl) {
  return `${RULE34US_PAGE_CACHE_PREFIX}${pageUrl}`;
}

async function captureImageBodyViaDebugger(tabId, expectedImageUrl, timeoutMs = 15000) {
  const debuggee = { tabId };

  await debuggerAttach(debuggee);

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

    const normalizeUrl = (value) => {
      try {
        return new URL(value).href;
      } catch {
        return value || "";
      }
    };

    const expected = normalizeUrl(expectedImageUrl);

    const tokenize = (url) => {
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
    };

    const expectedTokens = tokenize(expected);

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

      // Prefer likely full/sample images over tiny icons.
      const lower = url.toLowerCase();
      if (/\b(sample|images|img)\b/.test(lower)) score += 25;
      if (/\b(jpe?g|png|webp|gif|avif)\b/.test(lower)) score += 10;
      if (/\b(avatar|logo|icon|banner|sprite)\b/.test(lower)) score -= 80;

      return score;
    };

    const candidates = new Map();

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
            score: scoreCandidate(response)
          });
        }

        if (method === "Network.loadingFinished") {
          const requestId = params?.requestId;
          const candidate = requestId ? candidates.get(requestId) : null;
          if (!candidate) return;

          candidate.encodedDataLength = Number(params?.encodedDataLength || 0);

          // Prefer substantial image bodies.
          const finalScore = candidate.score + Math.min(candidate.encodedDataLength / 5000, 200);
          candidate.finalScore = finalScore;

          // Try exact/high-confidence matches immediately.
          if (finalScore >= 250) {
            const bodyResult = await debuggerSend(debuggee, "Network.getResponseBody", { requestId });
            const mimeType = candidate.mimeType || "application/octet-stream";
            const body = bodyResult?.body || "";
            const base64Encoded = !!bodyResult?.base64Encoded;

            const dataUrl = base64Encoded
              ? `data:${mimeType};base64,${body}`
              : `data:${mimeType};base64,${btoa(unescape(encodeURIComponent(body)))}`;

            await finishResolve({
              ok: true,
              url: candidate.url,
              mimeType,
              status: candidate.status,
              dataUrl
            });
            return;
          }
        }

        if (method === "Page.loadEventFired") {
          if (!candidates.size) return;

          const ranked = Array.from(candidates.values())
            .map((c) => ({
              ...c,
              finalScore: c.finalScore ?? (c.score + Math.min(c.encodedDataLength / 5000, 200))
            }))
            .sort((a, b) => b.finalScore - a.finalScore);

          const best = ranked[0];
          if (!best) return;

          const bodyResult = await debuggerSend(debuggee, "Network.getResponseBody", {
            requestId: best.requestId
          });

          const mimeType = best.mimeType || "application/octet-stream";
          const body = bodyResult?.body || "";
          const base64Encoded = !!bodyResult?.base64Encoded;

          const dataUrl = base64Encoded
            ? `data:${mimeType};base64,${body}`
            : `data:${mimeType};base64,${btoa(unescape(encodeURIComponent(body)))}`;

          await finishResolve({
            ok: true,
            url: best.url,
            mimeType,
            status: best.status,
            dataUrl
          });
        }

        if (method === "Network.loadingFailed") {
          const requestId = params?.requestId;
          if (!requestId || !candidates.has(requestId)) return;

          const candidate = candidates.get(requestId);
          candidate.failed = true;
        }
      } catch (error) {
        await finishReject(error);
      }
    };

    chrome.debugger.onEvent.addListener(onEvent);
    chrome.debugger.onDetach.addListener(onDetach);

    const timer = setTimeout(() => {
      void finishReject(
        new Error("Timed out while waiting for the image response body.")
      );
    }, timeoutMs);

    try {
      await debuggerSend(debuggee, "Network.enable");
      await debuggerSend(debuggee, "Page.enable");
      await debuggerSend(debuggee, "Network.setCacheDisabled", { cacheDisabled: true });
      await debuggerSend(debuggee, "Page.reload", { ignoreCache: true });
    } catch (error) {
      await finishReject(error);
    }
  });
}

const formatter = new TagFormatter();
const fileManager = new FileManager();
let captureInProgress = false;

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(STORAGE_KEYS.settings);
  if (!existing[STORAGE_KEYS.settings]) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: DEFAULT_SETTINGS
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case MESSAGE_TYPES.GET_SETTINGS:
      return await getSettingsResponse();

    case MESSAGE_TYPES.SAVE_SETTINGS:
      return await saveSettingsResponse(message.payload);

    case MESSAGE_TYPES.CACHE_RULE34US_IMAGE:
      return await cacheRule34UsImageResponse(message.payload);

    case MESSAGE_TYPES.CAPTURE_CURRENT_POST:
      if (captureInProgress) {
        return {
          ok: false,
          error: "Capture already in progress."
        };
      }

      captureInProgress = true;

      try {
        return await captureCurrentPostResponse();
      } finally {
        captureInProgress = false;
      }

    default:
      return {
        ok: false,
        error: `Unknown message type: ${message?.type ?? "<missing>"}`
      };
  }
}

async function cacheRule34UsImageResponse(payload) {
  const postId = String(payload?.postId || "").trim();
  const pageUrl = String(payload?.pageUrl || "").trim();
  const imageUrl = String(payload?.imageUrl || "").trim();
  const dataUrl = String(payload?.dataUrl || "").trim();

  if (!postId || !pageUrl || !imageUrl || !dataUrl) {
    return { ok: false, error: "Incomplete rule34.us cache payload." };
  }

  await chrome.storage.local.set({
    [getRule34UsCacheKey(postId)]: {
      postId,
      pageUrl,
      imageUrl,
      dataUrl,
      cachedAt: Date.now()
    },
    [getRule34UsPageCacheKey(pageUrl)]: postId
  });

  return { ok: true };
}

async function getSettingsResponse() {
  const settings = await readSettings();
  return { ok: true, settings };
}

async function saveSettingsResponse(partial) {
  const current = await readSettings();
  const next = {
    ...current,
    ...normalizeSettings(partial)
  };

  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  return { ok: true, settings: next };
}

async function captureCurrentPostResponse() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab is available.");
  }

  const injection = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const url = new URL(window.location.href);

      class Parser {
        canHandle(_url) {
          throw new Error("Parser.canHandle must be implemented by subclasses.");
        }
        parse(_document, _url) {
          throw new Error("Parser.parse must be implemented by subclasses.");
        }
      }

      class DanbooruParser extends Parser {
        canHandle(url) {
          return url.hostname === "danbooru.donmai.us" && /^\/posts\/\d+/.test(url.pathname);
        }

        parse(document, url) {
          const imageContainer = document.querySelector("section.image-container");

          if (!imageContainer) {
            throw new Error("Danbooru parser: image container not found.");
          }

          let imageUrl = imageContainer.dataset.fileUrl || null;

          if (!imageUrl) {
            imageUrl =
              document.querySelector("#post-option-view-original a")?.href ||
              document.querySelector("a.image-view-original-link")?.href ||
              null;
          }

          if (!imageUrl) {
            throw new Error("Danbooru parser: original image URL not found.");
          }

          const rawTagString = (imageContainer.dataset.tags || "").trim();
          const tags = rawTagString ? rawTagString.split(/\s+/).filter(Boolean) : [];

          const postId =
            url.pathname.match(/^\/posts\/(\d+)/)?.[1] ||
            document.body?.dataset?.postId ||
            document.querySelector('meta[name="post-id"]')?.content ||
            undefined;

          const rating = imageContainer.dataset.rating || undefined;
          const md5 = imageContainer.dataset.md5 || undefined;

          let imageExtension;
          try {
            const pathname = new URL(imageUrl, url.href).pathname;
            imageExtension = pathname.split(".").pop()?.toLowerCase() || undefined;
          } catch {
            imageExtension = undefined;
          }

          return {
            sourceSite: "danbooru",
            postUrl: url.href,
            imageUrl,
            imageExtension,
            tags,
            rawTagString,
            rating,
            md5,
            postId
          };
        }
      }

      class Rule34XxxParser extends Parser {
        canHandle(url) {
          return (
            url.hostname === "rule34.xxx" &&
            url.pathname.endsWith("/index.php") &&
            url.searchParams.get("page") === "post" &&
            url.searchParams.get("s") === "view" &&
            !!url.searchParams.get("id")
          );
        }

        parse(document, url) {
          const postId =
            url.searchParams.get("id") ||
            extractStatsValue(document, "Id") ||
            undefined;

          const pageImage =
            document.querySelector("#image") ||
            document.querySelector("img#main-image") ||
            document.querySelector("section.image-container img") ||
            document.querySelector("img");

          const pageImageUrl =
            pageImage?.currentSrc ||
            pageImage?.getAttribute("src") ||
            null;

          const originalImageLink = Array.from(document.querySelectorAll("a")).find(
            (a) => a.textContent?.trim().toLowerCase() === "original image"
          );

          const imageUrl = pageImageUrl || originalImageLink?.href || null;

          if (!imageUrl) {
            throw new Error("Gelbooru parser: image URL not found.");
          }

          const ratingText = extractStatsValue(document, "Rating") || undefined;
          const rating = normalizeRule34Rating(ratingText);

          const tags = [
            ...extractTypedTags(document, "general"),
            ...extractTypedTags(document, "metadata")
          ];

          const rawTagString = tags.join(" ");

          let resolvedImageUrl = imageUrl;
          let imageExtension;

          try {
            const resolved = new URL(imageUrl, url.href);
            resolvedImageUrl = resolved.href;
            const pathname = resolved.pathname;
            imageExtension = pathname.split(".").pop()?.toLowerCase() || undefined;
          } catch {
            imageExtension = undefined;
          }

          return {
            sourceSite: "rule34.xxx",
            postUrl: url.href,
            imageUrl: resolvedImageUrl,
            imageExtension,
            tags,
            rawTagString,
            rating,
            postId
          };
        }
      }

      class Rule34UsParser extends Parser {
        canHandle(url) {
          return (
            url.hostname === "rule34.us" &&
            url.pathname.endsWith("/index.php") &&
            url.searchParams.get("r") === "posts/view" &&
            !!url.searchParams.get("id")
          );
        }

        parse(document, url) {
          const postId =
            url.searchParams.get("id") ||
            extractStatsValueUs(document, "Id") ||
            undefined;

          const pageImage = document.querySelector("#image");
          const pageImageUrl =
            pageImage?.currentSrc ||
            pageImage?.getAttribute("src") ||
            null;

          const originalLink = findOriginalLinkUs(document);

          const imageUrl = pageImageUrl || originalLink?.href || null;

          if (!imageUrl) {
            throw new Error("Rule34.us parser: image URL not found.");
          }

          const tags = [
            ...extractTagGroupUs(document, "artist-tag"),
            ...extractTagGroupUs(document, "character-tag"),
            ...extractTagGroupUs(document, "general-tag"),
            ...extractTagGroupUs(document, "metadata-tag")
          ];

          const rawTagString = tags.join(" ");

          let resolvedImageUrl = imageUrl;
          let imageExtension;
          try {
            const resolved = new URL(imageUrl, url.href);
            resolvedImageUrl = resolved.href;
            imageExtension = resolved.pathname.split(".").pop()?.toLowerCase() || undefined;
          } catch {
            imageExtension = undefined;
          }

          return {
            sourceSite: "rule34.us",
            postUrl: url.href,
            imageUrl: resolvedImageUrl,
            imageExtension,
            tags,
            rawTagString,
            postId
          };
        }
      }

      class GelbooruParser extends Parser {
        canHandle(url) {
          return (
            url.hostname === "gelbooru.com" &&
            url.pathname.endsWith("/index.php") &&
            url.searchParams.get("page") === "post" &&
            url.searchParams.get("s") === "view" &&
            !!url.searchParams.get("id")
          );
        }

        parse(document, url) {
          const postId =
            url.searchParams.get("id") ||
            extractStatsValueGelbooru(document, "Id") ||
            document.querySelector("section.image-container")?.dataset?.id ||
            undefined;

          const originalImageLink = Array.from(document.querySelectorAll("a")).find(
            (a) => a.textContent?.trim().toLowerCase() === "original image"
          );

          const imageUrl = originalImageLink?.href || null;
          if (!imageUrl) {
            throw new Error("Gelbooru parser: original image URL not found.");
          }

          const ratingText =
            extractStatsValueGelbooru(document, "Rating") ||
            document.querySelector('meta[name="rating"]')?.content ||
            undefined;

          const rating = normalizeGelbooruRating(ratingText);

          const tags = [
            ...extractTagGroupGelbooru(document, "artist"),
            ...extractTagGroupGelbooru(document, "character"),
            ...extractTagGroupGelbooru(document, "general"),
            ...extractTagGroupGelbooru(document, "metadata")
          ];

          const rawTagString = tags.join(" ");

          const md5 =
            document.querySelector("section.image-container")?.dataset?.md5 ||
            undefined;

          let imageExtension;
          try {
            const pathname = new URL(imageUrl, url.href).pathname;
            imageExtension = pathname.split(".").pop()?.toLowerCase() || undefined;
          } catch {
            imageExtension = undefined;
          }

          return {
            sourceSite: "gelbooru",
            postUrl: url.href,
            imageUrl,
            imageExtension,
            tags,
            rawTagString,
            rating,
            md5,
            postId
          };
        }
      }

      function extractStatsValueGelbooru(document, label) {
        const items = Array.from(document.querySelectorAll("li"));
        const match = items.find((li) =>
          li.textContent?.trim().toLowerCase().startsWith(`${label.toLowerCase()}:`)
        );

        if (!match) {
          return null;
        }

        const text = match.textContent.trim();
        return text.slice(label.length + 1).trim() || null;
      }

      function extractTagGroupGelbooru(document, type) {
        return Array.from(document.querySelectorAll(`li.tag-type-${type} > a`))
          .map((a) => a.textContent?.trim())
          .filter(Boolean);
      }

      function normalizeGelbooruRating(ratingText) {
        if (!ratingText) return undefined;

        switch (ratingText.trim().toLowerCase()) {
          case "general":
            return "g";
          case "sensitive":
            return "s";
          case "questionable":
            return "q";
          case "explicit":
            return "e";
          default:
            return ratingText.trim().toLowerCase();
        }
      }

      function findOriginalLinkUs(document) {
        return (
          Array.from(document.querySelectorAll("a")).find((a) => {
            const text = a.textContent?.trim().toLowerCase();
            return text === "original";
          }) || null
        );
      }

      function extractStatsValueUs(document, label) {
        const items = Array.from(document.querySelectorAll("li"));
        const match = items.find((li) =>
          li.textContent?.trim().toLowerCase().startsWith(`${label.toLowerCase()}:`)
        );

        if (!match) {
          return null;
        }

        const text = match.textContent.trim();
        return text.slice(label.length + 1).trim() || null;
      }

      function extractTagGroupUs(document, className) {
        return Array.from(document.querySelectorAll(`li.${className} > a`))
          .map((a) => a.textContent?.trim())
          .filter(Boolean);
      }

      function extractStatsValue(document, label) {
        const stats = document.querySelector("#stats");
        if (!stats) return null;

        const items = Array.from(stats.querySelectorAll("li"));
        const match = items.find((li) =>
          li.textContent?.trim().toLowerCase().startsWith(`${label.toLowerCase()}:`)
        );

        if (!match) return null;

        const text = match.textContent.trim();
        return text.slice(label.length + 1).trim() || null;
      }

      function extractTypedTags(document, type) {
        const selector = `li.tag-type-${type}.tag`;
        const items = Array.from(document.querySelectorAll(selector));

        return items
          .map((li) => {
            const links = li.querySelectorAll('a[href*="page=post"][href*="tags="]');
            const tagLink = links[links.length - 1];
            if (!tagLink) return null;

            const href = tagLink.getAttribute("href") || "";
            try {
              const resolved = new URL(href, document.baseURI);
              const value = resolved.searchParams.get("tags");
              return value ? value.trim() : null;
            } catch {
              return null;
            }
          })
          .filter(Boolean);
      }

      function normalizeRule34Rating(ratingText) {
        if (!ratingText) return undefined;

        switch (ratingText.trim().toLowerCase()) {
          case "safe":
            return "s";
          case "questionable":
            return "q";
          case "explicit":
            return "e";
          default:
            return ratingText.trim().toLowerCase();
        }
      }

      const parserRegistry = [
        new DanbooruParser(),
        new Rule34XxxParser(),
        new Rule34UsParser(),
        new GelbooruParser()
      ];
      const parser = parserRegistry.find((p) => p.canHandle(url)) ?? null;

      if (!parser) {
        return {
          ok: false,
          error: `Unsupported host or page shape: ${url.hostname}`,
          pageUrl: window.location.href,
          title: document.title
        };
      }

      try {
        return {
          ok: true,
          ...parser.parse(document, url)
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          pageUrl: window.location.href,
          title: document.title
        };
      }
    }
  });

  const pageResult = injection?.[0]?.result;
  if (!pageResult?.ok) {
    return pageResult ?? {
      ok: false,
      error: "Could not extract data from the current page."
    };
  }

  let capturedRule34UsDataUrl = null;
  let capturedRule34UsImageUrl = null;
  let capturedRule34UsMimeType = null;

  let capturedSpecialSiteDataUrl = null;
  let capturedSpecialSiteImageUrl = null;
  let capturedSpecialSiteMimeType = null;

  if (
    pageResult.sourceSite === "rule34.us" ||
    pageResult.sourceSite === "gelbooru"
  ) {
    const captureResult = await captureImageBodyViaDebugger(tab.id, pageResult.imageUrl);

    capturedSpecialSiteDataUrl = captureResult.dataUrl;
    capturedSpecialSiteImageUrl = captureResult.url || pageResult.imageUrl || null;
    capturedSpecialSiteMimeType = captureResult.mimeType || null;
  }

  const settings = await readSettings();
  const index = await reserveNextIndex(settings.workingDirectory);

  const imageExtension =
  (
    pageResult.sourceSite === "rule34.us" ||
    pageResult.sourceSite === "gelbooru"
  ? mimeToExtension(capturedSpecialSiteMimeType) ||
    guessExtensionFromDataUrl(capturedSpecialSiteDataUrl) ||
    guessExtensionFromUrl(capturedSpecialSiteImageUrl)
  : null
  ) ||
  pageResult.imageExtension ||
  guessExtensionFromUrl(pageResult.imageUrl) ||
  "jpg";

  const imageFilename = fileManager.makeFilename(
    index,
    settings.digits,
    imageExtension,
    settings.imagePrefix
  );

  const textFilename = fileManager.makeFilename(
    index,
    settings.digits,
    settings.tagFileExtension,
    settings.imagePrefix
  );

  const formatted = formatter.format(pageResult.tags ?? pageResult.rawTagString ?? []);
  const textContent = formatTagsFileContent(pageResult, formatter);

  let imageDownloadId;
  let textDownloadId;

  try {
    if (
      pageResult.sourceSite === "rule34.us" ||
      pageResult.sourceSite === "gelbooru"
    ) {
      if (!capturedSpecialSiteDataUrl) {
        throw new Error(`${pageResult.sourceSite} debugger capture returned no data.`);
      }

      imageDownloadId = await fileManager.downloadDataUrlFile(
        settings.workingDirectory,
        imageFilename,
        capturedSpecialSiteDataUrl
      );
    } else {
      imageDownloadId = await fileManager.downloadImageFile(
        settings.workingDirectory,
        imageFilename,
        pageResult.imageUrl
      );
    }
  } catch (error) {
    throw new Error(
      `Image save failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    textDownloadId = await fileManager.downloadTextFile(
      settings.workingDirectory,
      textFilename,
      textContent
    );
  } catch (error) {
    throw new Error(
      `Tag save failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }


  return {
    ok: true,
    saved: {
      index,
      imageFilename,
      textFilename,
      imageDownloadId,
      textDownloadId,
      workingDirectory: settings.workingDirectory
    },
    formatted
  };
}

async function readSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return {
    ...DEFAULT_SETTINGS,
    ...(result[STORAGE_KEYS.settings] || {})
  };
}

function normalizeSettings(partial = {}) {
  const digitsRaw = Number(partial.digits);
  const digits = Number.isFinite(digitsRaw) ? Math.max(1, Math.floor(digitsRaw)) : DEFAULT_SETTINGS.digits;

  return {
    workingDirectory: String(partial.workingDirectory ?? DEFAULT_SETTINGS.workingDirectory).trim() || DEFAULT_SETTINGS.workingDirectory,
    digits,
    imagePrefix: String(partial.imagePrefix ?? ""),
    tagFileExtension:
      String(partial.tagFileExtension ?? DEFAULT_SETTINGS.tagFileExtension)
        .trim()
        .replace(/[^a-zA-Z0-9]/g, "")
        .toLowerCase() || DEFAULT_SETTINGS.tagFileExtension
  };
}

async function reserveNextIndex(directory) {
  const dir = fileManager.sanitizeDirectoryName(directory);
  const store = await chrome.storage.local.get(STORAGE_KEYS.nextIndexByDirectory);

  const map = { ...(store[STORAGE_KEYS.nextIndexByDirectory] || {}) };

  // Always rescan the actual folder contents.
  // This makes the index reset correctly after files were deleted,
  // and also notices files added manually.
  const next = await fileManager.findNextFreeIndex(dir);

  map[dir] = next + 1;

  await chrome.storage.local.set({
    [STORAGE_KEYS.nextIndexByDirectory]: map
  });

  return next;
}

async function syncNextIndexFloor(directory, usedIndex) {
  const dir = fileManager.sanitizeDirectoryName(directory);
  const store = await chrome.storage.local.get(STORAGE_KEYS.nextIndexByDirectory);
  const map = { ...(store[STORAGE_KEYS.nextIndexByDirectory] || {}) };
  const current = map[dir];

  if (!Number.isInteger(current) || current <= usedIndex) {
    map[dir] = usedIndex + 1;
    await chrome.storage.local.set({
      [STORAGE_KEYS.nextIndexByDirectory]: map
    });
  }
}

function guessExtensionFromDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") {
    return null;
  }

  const match = dataUrl.match(/^data:([^;,]+)[;,]/i);
  const mime = match?.[1]?.toLowerCase();

  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    default:
      return null;
  }
}

function guessExtensionFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split(".").pop()?.toLowerCase();
    if (!ext) return null;
    if (/^[a-z0-9]{2,5}$/.test(ext)) {
      return ext;
    }
    return null;
  } catch {
    return null;
  }
}
