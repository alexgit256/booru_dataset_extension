import { DirectUrlAcquisitionStrategy } from "./directUrlAcquisitionStrategy.js";
import { DebuggerResponseBodyAcquisitionStrategy } from "./debuggerResponseBodyAcquisitionStrategy.js";

const directUrlStrategy = new DirectUrlAcquisitionStrategy();
const debuggerStrategy = new DebuggerResponseBodyAcquisitionStrategy();

export function resolveImageAcquisitionStrategy(pageResult) {
  switch (pageResult?.sourceSite) {
    case "gelbooru":
    case "rule34.us":
      return debuggerStrategy;
    default:
      return directUrlStrategy;
  }
}