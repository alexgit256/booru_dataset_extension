export class ImageAcquisitionStrategy {
  /**
   * @param {object} _context
   * @returns {Promise<{
   *   mode: "remote-url" | "data-url",
   *   imageUrl?: string | null,
   *   dataUrl?: string | null,
   *   mimeType?: string | null
   * }>}
   */
  async acquire(_context) {
    throw new Error("ImageAcquisitionStrategy.acquire() is not implemented.");
  }
}