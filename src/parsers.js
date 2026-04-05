import { Parser } from "./parser.js";
import { DanbooruParser } from "./danbooru.js";
import { Rule34XxxParser } from "./rule34xxx.js";

class UnsupportedParser extends Parser {
  canHandle(_url) {
    return false;
  }

  parse(_document, _url) {
    throw new Error("Unsupported parser cannot parse.");
  }
}

const parserRegistry = [
  new DanbooruParser(),
  new Rule34XxxParser(),
  new UnsupportedParser()
];

/** @param {URL} url */
export function findParser(url) {
  return parserRegistry.find((parser) => parser.canHandle(url)) ?? null;
}

export function listRegisteredParsers() {
  return parserRegistry.map((parser) => parser.constructor.name);
}