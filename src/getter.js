import { findParser } from "./parsers.js";

/**
 * Runs in the page context via chrome.scripting.executeScript.
 * It discovers the parser for the current page and extracts post data.
 */
export function extractCurrentPost() {
  const url = new URL(window.location.href);

  // This function body is serialized into the target tab, so it must stay self-contained.
  function createFallbackError(message) {
    return {
      ok: false,
      error: message,
      pageUrl: window.location.href,
      title: document.title
    };
  }

  // Placeholder contract until concrete parsers are injected later.
  // For now we do not implement specific site logic.
  const unsupportedHosts = ["danbooru.donmai.us", "rule34.xxx", "rule34.us"];
  if (unsupportedHosts.includes(url.hostname)) {
    return createFallbackError(
      "A parser for this host has not been implemented yet. Add a concrete parser derived from Parser and register it in src/parsers.js."
    );
  }

  return createFallbackError("No parser is available for this page.");
}

/**
 * Not used directly inside the tab injection yet, but kept as the background-side contract.
 */
export function getParserForUrl(pageUrl) {
  return findParser(new URL(pageUrl));
}
