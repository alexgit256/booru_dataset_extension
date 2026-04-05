import { DEFAULT_SETTINGS, MESSAGE_TYPES, STORAGE_KEYS } from "./config.js";
import { TagFormatter } from "./formatter.js";
import { FileManager } from "./fileManager.js";
import { formatTagsFileContent, formatDebugTagsFileContent } from "./formatter.js";

const formatter = new TagFormatter();
const fileManager = new FileManager();

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

    case MESSAGE_TYPES.CAPTURE_CURRENT_POST:
      return await captureCurrentPostResponse();

    default:
      return {
        ok: false,
        error: `Unknown message type: ${message?.type ?? "<missing>"}`
      };
  }
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

          const originalImageLink = Array.from(document.querySelectorAll("a")).find((a) =>
            a.textContent?.trim().toLowerCase() === "original image"
          );

          const imageUrl = originalImageLink?.href || null;
          if (!imageUrl) {
            throw new Error("Rule34.xxx parser: original image URL not found.");
          }

          const ratingText = extractStatsValue(document, "Rating") || undefined;
          const rating = normalizeRule34Rating(ratingText);

          const tags = [
            ...extractTypedTags(document, "general"),
            ...extractTypedTags(document, "metadata")
          ];

          const rawTagString = tags.join(" ");

          let imageExtension;
          try {
            const pathname = new URL(imageUrl, url.href).pathname;
            imageExtension = pathname.split(".").pop()?.toLowerCase() || undefined;
          } catch {
            imageExtension = undefined;
          }

          return {
            sourceSite: "rule34.xxx",
            postUrl: url.href,
            imageUrl,
            imageExtension,
            tags,
            rawTagString,
            rating,
            postId
          };
        }
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
        new Rule34XxxParser()
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

  const settings = await readSettings();
  const index = await fileManager.findNextFreeIndex(settings.workingDirectory);

  const imageExtension =
    pageResult.imageExtension || guessExtensionFromUrl(pageResult.imageUrl) || "jpg";

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

  const metadataBanner = [
    `# source_site: ${pageResult.sourceSite ?? "unknown"}`,
    `# post_url: ${pageResult.postUrl ?? pageResult.pageUrl ?? ""}`,
    `# image_url: ${pageResult.imageUrl ?? ""}`,
    pageResult.rating ? `# rating: ${pageResult.rating}` : null,
    pageResult.postId ? `# post_id: ${pageResult.postId}` : null,
    pageResult.md5 ? `# md5: ${pageResult.md5}` : null,
    ""
  ]
    .filter(Boolean)
    .join("\n");

  // const textContent = `${metadataBanner}${formatted.output}\n`;
  const textContent = formatTagsFileContent(pageResult, formatter);

  let imageDownloadId;
  let textDownloadId;

  try {
    imageDownloadId = await fileManager.downloadImageFile(
      settings.workingDirectory,
      imageFilename,
      pageResult.imageUrl
    );
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
      `Text save failed: ${error instanceof Error ? error.message : String(error)}`
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
