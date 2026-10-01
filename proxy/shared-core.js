"use strict";
// The download core the userscript uses, loaded into this process: range parsing and
// splitting (range-core), the CDN node list, speed measurements and bans (cdn-resolver), and
// the multi-connection downloader with its hedging and retries (idm-downloader). The files
// attach themselves to globalThis, as they do in a page, and need nothing from a browser
// beyond fetch, AbortController and performance, which Node has.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SOURCE = path.resolve(__dirname, "../src");
const FILES = ["range-core.js", "cdn-resolver.js", "idm-downloader.js", "sidx.js"];
let loaded = null;

function loadSharedCore() {
  if (loaded) return loaded;
  for (const file of FILES) {
    vm.runInThisContext(fs.readFileSync(path.join(SOURCE, file), "utf8"), { filename: path.join(SOURCE, file) });
  }
  const core = globalThis.__BILI_RANGE_CORE__;
  const cdn = globalThis.__BILI_CDN_RESOLVER_FACTORY__;
  const idm = globalThis.__BILI_IDM_DOWNLOADER_FACTORY__;
  const sidx = globalThis.__BILI_SIDX__;
  if (!core || !cdn || !idm || !sidx) throw new Error("共享下载内核没有加载完整");
  loaded = Object.freeze({ core, cdn, idm, sidx });
  return loaded;
}

module.exports = { loadSharedCore };
