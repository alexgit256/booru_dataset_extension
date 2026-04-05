import { Parser } from "./parser.js";

export class GelbooruParser extends Parser {
  /** @param {URL} url */
  canHandle(url) {
    return (
      url.hostname === "gelbooru.com" &&
      url.pathname.endsWith("/index.php") &&
      url.searchParams.get("page") === "post" &&
      url.searchParams.get("s") === "view" &&
      !!url.searchParams.get("id")
    );
  }

  /**
   * @param {Document} document
   * @param {URL} url
   */
  parse(document, url) {
    const postId =
      url.searchParams.get("id") ||
      extractStatsValue(document, "Id") ||
      document.querySelector("section.image-container")?.dataset?.id ||
      undefined;

    const pageImage = document.querySelector("#image");

    const pageImageUrl =
      pageImage?.currentSrc ||
      pageImage?.getAttribute("src") ||
      null;

    const originalImageLink = Array.from(document.querySelectorAll("a")).find(
      (a) => a.textContent?.trim().toLowerCase() === "original image"
    );

    // Prefer the rendered page image on Gelbooru because the original link
    // often returns HTML / anti-hotlink content when fetched by the extension.
    const imageUrl = pageImageUrl || originalImageLink?.href || null;

    if (!imageUrl) {
      throw new Error("Gelbooru parser: image URL not found.");
    }

    const ratingText =
      extractStatsValue(document, "Rating") ||
      document.querySelector('meta[name="rating"]')?.content ||
      undefined;

    const rating = normalizeGelbooruRating(ratingText);

    const tags = [
      ...extractTagGroup(document, "artist"),
      ...extractTagGroup(document, "character"),
      ...extractTagGroup(document, "general"),
      ...extractTagGroup(document, "metadata")
    ];

    const rawTagString = tags.join(" ");

    const md5 =
      document.querySelector("section.image-container")?.dataset?.md5 ||
      undefined;

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
      sourceSite: "gelbooru",
      postUrl: url.href,
      imageUrl: resolvedImageUrl,
      imageExtension,
      tags,
      rawTagString,
      rating,
      md5,
      postId
    };
  }
}

function extractStatsValue(document, label) {
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

function extractTagGroup(document, type) {
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