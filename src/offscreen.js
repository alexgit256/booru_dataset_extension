const objectUrls = new Set();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CREATE_OBJECT_URL") {
    const { content, mimeType } = message.payload;
    const blob = new Blob([content], { type: mimeType || "text/plain;charset=utf-8" });
    const objectUrl = URL.createObjectURL(blob);
    objectUrls.add(objectUrl);
    sendResponse({ ok: true, objectUrl });
    return true;
  }

  if (message?.type === "REVOKE_OBJECT_URL") {
    const { objectUrl } = message.payload || {};
    if (objectUrl && objectUrls.has(objectUrl)) {
      URL.revokeObjectURL(objectUrl);
      objectUrls.delete(objectUrl);
    }
    sendResponse({ ok: true });
    return true;
  }
});