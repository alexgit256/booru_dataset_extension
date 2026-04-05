import { DEFAULT_SETTINGS, MESSAGE_TYPES, STORAGE_KEYS } from "./config.js";
import { TagFormatter } from "./formatter.js";
import { FileManager } from "./fileManager.js";
import { formatTagsFileContent, formatDebugTagsFileContent } from "./formatter.js";

const RULE34US_CACHE_PREFIX = "rule34usImageCache:";
const RULE34US_PAGE_CACHE_PREFIX = "rule34usPageCache:";

function getRule34UsCacheKey(postId) {
  return `${RULE34US_CACHE_PREFIX}${postId}`;
}

function getRule34UsPageCacheKey(pageUrl) {
  return `${RULE34US_PAGE_CACHE_PREFIX}${pageUrl}`;
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

          const pageImage = document.querySelector("#image");
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

  const settings = await readSettings();
  const index = await reserveNextIndex(settings.workingDirectory);

  let cachedRule34UsImage = null;

  if (pageResult.sourceSite === "rule34.us" && pageResult.postId) {
    const cacheStore = await chrome.storage.local.get(getRule34UsCacheKey(pageResult.postId));
    cachedRule34UsImage = cacheStore[getRule34UsCacheKey(pageResult.postId)] || null;
  }

  const imageExtension =
    pageResult.imageExtension ||
    guessExtensionFromUrl(pageResult.imageUrl) ||
    guessExtensionFromDataUrl(cachedRule34UsImage?.dataUrl) ||
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
    if (pageResult.sourceSite === "rule34.us") {
      if (!cachedRule34UsImage?.dataUrl) {
        throw new Error(
          "Rule34.us warm cache missing. Reload the post page, wait for the image to fully appear, then capture again."
        );
      }

      imageDownloadId = await fileManager.downloadDataUrlFile(
        settings.workingDirectory,
        imageFilename,
        cachedRule34UsImage.dataUrl
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

  if (pageResult.sourceSite === "rule34.us" && pageResult.postId) {
    const cacheStore = await chrome.storage.local.get(getRule34UsCacheKey(pageResult.postId));
    cachedRule34UsImage = cacheStore[getRule34UsCacheKey(pageResult.postId)] || null;

    console.log("rule34.us cache", {
      postId: pageResult.postId,
      hasCache: !!cachedRule34UsImage,
      hasDataUrl: !!cachedRule34UsImage?.dataUrl,
      dataUrlPrefix: cachedRule34UsImage?.dataUrl?.slice(0, 40) || null,
      imageUrl: pageResult.imageUrl
    });
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

  let next = map[dir];

  if (!Number.isInteger(next)) {
    const scanned = await fileManager.findNextFreeIndex(dir);
    next = scanned;
  }

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
