import { Parser } from "./parser.js";

export class DanbooruParser extends Parser {
  /** @param {URL} url */
  canHandle(url) {
    return url.hostname === "danbooru.donmai.us" && /^\/posts\/\d+/.test(url.pathname);
  }

  /**
   * @param {Document} document
   * @param {URL} url
   */
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