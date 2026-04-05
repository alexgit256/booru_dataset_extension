function getPostId() {
  const url = new URL(window.location.href);
  return url.searchParams.get("id") || null;
}

function getDisplayedImage() {
  return document.querySelector("#image");
}

function imageToDataUrl(img) {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Could not create 2D canvas context.");
  }

  ctx.drawImage(img, 0, 0);

  // Prefer PNG here for reliability; the original format can still be guessed separately.
  return canvas.toDataURL("image/png");
}

async function sendWarmCache(img) {
  const postId = getPostId();
  const imageUrl = img.currentSrc || img.src || null;

  if (!postId || !imageUrl) {
    return;
  }

  if (!img.complete || !img.naturalWidth || !img.naturalHeight) {
    return;
  }

  let dataUrl;
  try {
    dataUrl = imageToDataUrl(img);
  } catch (error) {
    // Canvas taint or draw failure; give up silently.
    return;
  }

  await chrome.runtime.sendMessage({
    type: "CACHE_RULE34US_IMAGE",
    payload: {
      postId,
      pageUrl: window.location.href,
      imageUrl,
      dataUrl
    }
  });
}

function attachToImage(img) {
  if (!img || img.dataset.booruWarmCacheAttached === "1") {
    return;
  }

  img.dataset.booruWarmCacheAttached = "1";

  img.addEventListener("load", () => {
    void sendWarmCache(img);
  });

  if (img.complete && img.naturalWidth > 0) {
    void sendWarmCache(img);
  }
}

function boot() {
  const existing = getDisplayedImage();
  if (existing) {
    attachToImage(existing);
  }

  const observer = new MutationObserver(() => {
    const img = getDisplayedImage();
    if (img) {
      attachToImage(img);
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
}

boot();