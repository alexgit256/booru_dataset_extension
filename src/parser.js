/**
 * Abstract parser for a supported post page.
 * Concrete implementations should return normalized post data.
 */
export class Parser {
  /** @param {URL} url */
  canHandle(url) {
    throw new Error("Parser.canHandle must be implemented by subclasses.");
  }

  /**
   * @param {Document} document
   * @param {URL} url
   * @returns {{
   *   sourceSite: string,
   *   postUrl: string,
   *   imageUrl: string,
   *   imageExtension?: string,
   *   tags: string[],
   *   rawTagString?: string,
   *   rating?: string,
   *   md5?: string,
   *   postId?: string
   * }}
   */
  parse(document, url) {
    throw new Error("Parser.parse must be implemented by subclasses.");
  }
}
