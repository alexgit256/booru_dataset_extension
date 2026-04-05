/**
 * Rewrites your old Python-side formatting into JavaScript-side formatting.
 * This is intentionally lightweight and easy to customize later.
 */
export class TagFormatter {
  /**
   * @param {string[] | string} input
   * @returns {{ raw: string[], normalized: string[], output: string }}
   */
  format(input) {
    const rawTags = Array.isArray(input)
      ? input
      : String(input)
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean);

    const normalized = rawTags
      .map((tag) => tag.trim())
      .filter(Boolean)
      .map((tag) => tag.replace(/\s+/g, "_"))
      .map((tag) => tag.replace(/^_+|_+$/g, ""))
      .filter(Boolean);

    const unique = [...new Set(normalized)];
    const output = unique.join(", ");

    return {
      raw: rawTags,
      normalized: unique,
      output
    };
  }
}

export function formatDebugTagsFileContent(pageResult, formatter) {
  const formatted = formatter.format(pageResult.tags ?? pageResult.rawTagString ?? []);
  const metadataBanner = [
    pageResult.postId ? `# post_id: ${pageResult.postId}` : null,
  ].filter(Boolean).join("\n");

  return `${metadataBanner}\n${formatted.output}\n`;
}

export function formatTagsFileContent(pageResult, _formatter) {
  return `${(pageResult.tags ?? []).join(", ")}\n`;
}
