import { Parser } from "./parser.js";

export class Rule34XxxParser extends Parser {
  /** @param {URL} url */
  canHandle(url) {
    return (
      url.hostname === "rule34.xxx" &&
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