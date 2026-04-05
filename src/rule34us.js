import { Parser } from "./parser.js";

export class Rule34UsParser extends Parser {
  /** @param {URL} url */
  canHandle(url) {
    return (
      url.hostname === "rule34.us" &&
      url.pathname.endsWith("/index.php") &&
      url.searchParams.get("r") === "posts/view" &&
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

    const originalLink = findOriginalLink(document);
    const imageUrl = originalLink?.href || null;

    if (!imageUrl) {
      throw new Error("Rule34.us parser: original image URL not found.");
    }

    const tags = [
      ...extractTagGroup(document, "artist-tag"),
      ...extractTagGroup(document, "character-tag"),
      ...extractTagGroup(document, "general-tag"),
      ...extractTagGroup(document, "metadata-tag")
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
      sourceSite: "rule34.us",
      postUrl: url.href,
      imageUrl,
      imageExtension,
      tags,
      rawTagString,
      postId
    };
  }
}

function findOriginalLink(document) {
  return Array.from(document.querySelectorAll("a")).find((a) => {
    const text = a.textContent?.trim().toLowerCase();
    return text === "original";
  }) || null;
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

function extractTagGroup(document, className) {
  return Array.from(document.querySelectorAll(`li.${className} > a`))
    .map((a) => a.textContent?.trim())
    .filter(Boolean);
}