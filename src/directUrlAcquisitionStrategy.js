import { ImageAcquisitionStrategy } from "./imageAcquisitionStrategy.js";

export class DirectUrlAcquisitionStrategy extends ImageAcquisitionStrategy {
  async acquire({ pageResult }) {
    return {
      mode: "remote-url",
      imageUrl: pageResult.imageUrl ?? null,
      mimeType: null,
      dataUrl: null,
    };
  }
}