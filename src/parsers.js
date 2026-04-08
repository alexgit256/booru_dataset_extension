import { Parser } from "./parser.js";
import { DanbooruParser } from "./danbooru.js";
import { Rule34XxxParser } from "./rule34xxx.js";
import { Rule34UsParser } from "./rule34us.js";
import { GelbooruParser } from "./gelbooru.js";
import { BooruIoParser } from "./booruio.js";

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
  new Rule34UsParser(),
  new GelbooruParser(),
  new BooruIoParser(),
  new UnsupportedParser()
];

/** @param {URL} url */
export function findParser(url) {
  return parserRegistry.find((parser) => parser.canHandle(url)) ?? null;
}

export function listRegisteredParsers() {
  return parserRegistry.map((parser) => parser.constructor.name);
}