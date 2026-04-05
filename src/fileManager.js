/**
 * A lightweight file manager built around chrome.downloads.
 * It writes into a subdirectory under the browser's Downloads directory.
 */
export class FileManager {
  constructor(downloadsApi = chrome.downloads) {
    this.downloadsApi = downloadsApi;
  }

  sanitizeDirectoryName(name) {
    const cleaned = String(name || "")
      .trim()
      .replace(/[<>:"\\|?*\x00-\x1F]/g, "_")
      .replace(/\.+$/g, "")
      .replace(/^\/+|\/+$/g, "")
      .replace(/\s+/g, " ");

    return cleaned || "booru_dataset";
  }

  sanitizeExtension(ext) {
    const cleaned = String(ext || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    return cleaned || "jpg";
  }

  makeFilename(index, digits, extension, prefix = "") {
    const effectiveDigits = Math.max(String(index).length, Number(digits) || 1);
    const basename = `${prefix}${String(index).padStart(effectiveDigits, "0")}`;
    return `${basename}.${this.sanitizeExtension(extension)}`;
  }

  async searchExistingFiles(directory) {
    const dir = this.sanitizeDirectoryName(directory);
    const items = await this.downloadsApi.search({
      filenameRegex: `(^|[\\/])${escapeRegex(dir)}[\\/][^\\/]+\\.[A-Za-z0-9]+$`,
      limit: 10000
    });
    return items;
  }

  extractUsedIndices(items) {
    const used = new Set();

    for (const item of items) {
      const filename = item.filename || "";
      const base = filename.split(/[\\/]/).pop() || "";
      const match = base.match(/^(\D*)(\d+)\.[A-Za-z0-9]+$/);
      if (!match) continue;
      used.add(Number(match[2]));
    }

    return used;
  }

  async findNextFreeIndex(directory) {
    const items = await this.searchExistingFiles(directory);
    const used = this.extractUsedIndices(items);
    let candidate = 0;
    while (used.has(candidate)) {
      candidate += 1;
    }
    return candidate;
  }

async downloadTextFile(directory, filename, content) {
  const dir = this.sanitizeDirectoryName(directory);
  const objectUrl = await this.createObjectUrlFromText(content);

  try {
    return await this.downloadsApi.download({
      url: objectUrl,
      filename: `${dir}/${filename}`,
      conflictAction: "uniquify",
      saveAs: false
    });
  } finally {
    setTimeout(() => {
      void this.revokeObjectUrl(objectUrl);
    }, 10000);
  }
}

async downloadDataUrlFile(directory, filename, dataUrl) {
  const dir = this.sanitizeDirectoryName(directory);

  return await this.downloadsApi.download({
    url: dataUrl,
    filename: `${dir}/${filename}`,
    conflictAction: "uniquify",
    saveAs: false
  });
}

async downloadImageFile(directory, filename, imageUrl) {
  const dir = this.sanitizeDirectoryName(directory);

  try {
    const response = await fetch(imageUrl, {
      credentials: "include"
    });

    if (!response.ok) {
      throw new Error(`Image fetch failed: ${response.status} ${response.statusText}`);
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const blob = await response.blob();
    const blobType = (blob.type || "").toLowerCase();

    const looksLikeImage =
      contentType.startsWith("image/") || blobType.startsWith("image/");

    if (!looksLikeImage) {
      throw new Error(
        `Fetched non-image content instead: content-type="${contentType}", blob.type="${blobType}"`
      );
    }

    const dataUrl = await this.blobToDataUrl(blob);

    return await this.downloadsApi.download({
      url: dataUrl,
      filename: `${dir}/${filename}`,
      conflictAction: "uniquify",
      saveAs: false
    });
  } catch (_fetchError) {
    // Fallback for hosts that dislike extension fetches / return HTML interstitials.
    return await this.downloadsApi.download({
      url: imageUrl,
      filename: `${dir}/${filename}`,
      conflictAction: "uniquify",
      saveAs: false
    });
  }
}

  async blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();

  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  const base64 = btoa(binary);
  const mime = blob.type || "application/octet-stream";
  return `data:${mime};base64,${base64}`;
}

async ensureOffscreenDocument() {
  const url = chrome.runtime.getURL("src/offscreen.html");

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [url]
    });

    if (contexts.length > 0) {
      return;
    }
  }

  await chrome.offscreen.createDocument({
    url: "src/offscreen.html",
    reasons: ["BLOBS"],
    justification: "Create Blob URLs for downloadable text files."
  });
}

async createObjectUrlFromText(content, mimeType = "text/plain;charset=utf-8") {
  await this.ensureOffscreenDocument();

  const response = await chrome.runtime.sendMessage({
    type: "CREATE_OBJECT_URL",
    payload: { content, mimeType }
  });

  if (!response?.ok || !response.objectUrl) {
    throw new Error("Could not create object URL for text download.");
  }

  return response.objectUrl;
}

async revokeObjectUrl(objectUrl) {
  if (!objectUrl) return;

  try {
    await chrome.runtime.sendMessage({
      type: "REVOKE_OBJECT_URL",
      payload: { objectUrl }
    });
  } catch {
    // Ignore cleanup failures
  }
}

}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
