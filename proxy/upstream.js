"use strict";
// Everything that leaves the proxy towards the internet: the many Range requests of the
// downloader, the requests passed through untouched, and the raw tunnels. All of it resolves
// host names through the upstream DNS servers given at start, never through the LAN's own
// DNS: in the DNS deployment that DNS points the CDN names at this very machine, and the
// proxy would otherwise connect to itself.
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const { Readable } = require("node:stream");

const DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
// A request that carries this header came from a proxy like this one.
const LOOP_HEADER = "x-btr-lan-proxy";

function createUpstream(options = {}) {
  const servers = (Array.isArray(options.dnsServers) ? options.dnsServers : []).map(String).filter(Boolean);
  let resolver = null;
  if (servers.length) {
    resolver = new dns.Resolver();
    resolver.setServers(servers);
  }
  const cache = new Map();
  const CACHE_TTL_MS = 60000;

  // Node's lookup signature. Only IPv4 is asked for: the CDN names all have A records, and
  // a client that answers our own AAAA queries with nothing (the built-in DNS does) must not
  // make the proxy fail on them either.
  function lookup(hostname, lookupOptions, callback) {
    if (typeof lookupOptions === "function") {
      callback = lookupOptions;
      lookupOptions = {};
    }
    // Node asks for an array of addresses when it may try several families (lookupOptions.all)
    // and for a single address otherwise; both shapes are produced from either form.
    const answer = (addresses) => {
      const list = (Array.isArray(addresses) ? addresses : [addresses]).map((item) => typeof item === "string" ? { address: item, family: net.isIP(item) || 4 } : item);
      if (lookupOptions?.all) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    };
    if (typeof options.lookup === "function") {
      return options.lookup(hostname, lookupOptions, (error, result, family) => {
        if (error) return callback(error);
        answer(Array.isArray(result) ? result : { address: result, family: family || net.isIP(result) || 4 });
      });
    }
    if (net.isIP(hostname)) return process.nextTick(answer, hostname);
    const key = hostname.toLowerCase();
    const cached = cache.get(key);
    if (cached && cached.until > Date.now()) {
      return process.nextTick(answer, cached.addresses[cached.turn++ % cached.addresses.length]);
    }
    const done = (error, addresses) => {
      if (error || !addresses?.length) {
        // The system resolver is the fallback, which at worst reaches the LAN DNS.
        return dns.lookup(hostname, { family: 4, all: false }, (fallbackError, address) => fallbackError ? callback(fallbackError) : answer(address));
      }
      if (cache.size > 1024) cache.clear();
      cache.set(key, { addresses, until: Date.now() + CACHE_TTL_MS, turn: 1 });
      answer(addresses[0]);
    };
    if (resolver) resolver.resolve4(hostname, done);
    else dns.resolve4(hostname, done);
  }

  const agentOptions = {
    keepAlive: true,
    keepAliveMsecs: 15000,
    maxSockets: Infinity,
    maxFreeSockets: 256,
    scheduling: "lifo",
    timeout: 60000,
    lookup
  };
  const httpsAgent = new https.Agent({ ...agentOptions, ca: options.ca });
  const httpAgent = new http.Agent(agentOptions);
  // Passed-through requests go to any server on the internet, and a reused idle connection
  // that the far end has just closed fails with "socket hang up" (WeChat's long-polling
  // servers do this constantly). Those requests are not where the speed is, so each one
  // gets its own connection.
  const plainOptions = { keepAlive: false, timeout: 60000, lookup };
  const passthroughHttpsAgent = new https.Agent({ ...plainOptions, ca: options.ca });
  const passthroughHttpAgent = new http.Agent(plainOptions);
  const targetPort = (protocol, port) => Number(port) || options.port?.[protocol] || (protocol === "https:" ? 443 : 80);

  function requestOptions(target, method, headers, passthrough = false) {
    const protocol = target.protocol === "http:" && !options.forceHttps ? "http:" : "https:";
    return {
      protocol,
      hostname: target.hostname,
      port: targetPort(protocol, target.port),
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      agent: protocol === "https:" ? (passthrough ? passthroughHttpsAgent : httpsAgent) : (passthrough ? passthroughHttpAgent : httpAgent),
      servername: protocol === "https:" ? target.hostname : undefined,
      ca: options.ca,
      lookup
    };
  }

  // passthrough: a request relayed for a client as it is, on a connection of its own.
  function rawRequest(target, method, headers, passthrough = false) {
    const parsed = target instanceof URL ? target : new URL(String(target));
    const settings = requestOptions(parsed, method, headers, passthrough);
    return (settings.protocol === "https:" ? https : http).request(settings);
  }

  function mergeHeaders(defaults, extra) {
    const merged = {};
    const put = (name, value) => { if (value != null) merged[String(name).toLowerCase()] = String(value); };
    for (const [name, value] of Object.entries(defaults || {})) put(name, value);
    if (extra instanceof Headers) extra.forEach((value, name) => put(name, value));
    else if (Array.isArray(extra)) for (const [name, value] of extra) put(name, value);
    else for (const [name, value] of Object.entries(extra || {})) put(name, value);
    return merged;
  }

  // What the downloader calls in place of the browser's fetch: the same URL and init, a
  // Response whose body streams and can be cancelled, and the signal honoured before and
  // after the headers. Browser-only options (cors, referrerPolicy, priority) are ignored.
  function fetch(url, init = {}) {
    return new Promise((resolve, reject) => {
      const signal = init.signal || null;
      const abortError = () => {
        const reason = signal?.reason;
        if (reason instanceof Error) return reason;
        return new DOMException("已取消", "AbortError");
      };
      if (signal?.aborted) return reject(abortError());
      let target;
      try { target = new URL(String(url)); }
      catch (error) { return reject(new TypeError(`地址无效：${url}`)); }
      const headers = mergeHeaders({
        "user-agent": options.userAgent || DEFAULT_USER_AGENT,
        referer: options.referer || "https://www.bilibili.com/",
        accept: "*/*",
        "accept-encoding": "identity",
        [LOOP_HEADER]: "1"
      }, init.headers);
      const request = rawRequest(target, String(init.method || "GET").toUpperCase(), headers);
      let settled = false;
      let response = null;
      const onAbort = () => {
        const error = abortError();
        if (response) response.destroy(error);
        request.destroy(error);
        if (!settled) { settled = true; reject(error); }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      request.once("error", (error) => {
        signal?.removeEventListener("abort", onAbort);
        if (!settled) { settled = true; reject(signal?.aborted ? abortError() : Object.assign(new TypeError(`fetch failed: ${error.message}`), { cause: error })); }
      });
      request.once("response", (incoming) => {
        response = incoming;
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) responseHeaders.set(name, value.join(", "));
          else if (value != null) responseHeaders.set(name, String(value));
        }
        // Cancelling the body ends the socket; a connection cut mid-transfer cannot be reused.
        const body = Readable.toWeb(incoming);
        const bodiless = [101, 204, 205, 304].includes(incoming.statusCode);
        if (bodiless) incoming.resume();
        const result = new Response(bodiless ? null : body, { status: incoming.statusCode, statusText: incoming.statusMessage || "", headers: responseHeaders });
        incoming.once("close", () => signal?.removeEventListener("abort", onAbort));
        try { Object.defineProperty(result, "url", { value: target.href }); } catch (_error) {}
        settled = true;
        resolve(result);
      });
      request.end();
    });
  }

  // A plain TCP connection for a tunnel, resolved the same way. The port map of the tests
  // applies here too (443 and 80 are the only ports a client tunnels to a CDN node).
  function connect(hostname, port) {
    const wanted = Number(port) || 443;
    const mapped = wanted === 443 ? targetPort("https:", 0) : wanted === 80 ? targetPort("http:", 0) : wanted;
    return new Promise((resolve, reject) => {
      lookup(hostname, {}, (error, address) => {
        if (error) return reject(error);
        const socket = net.connect({ host: address, port: mapped });
        socket.setNoDelay(true);
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    });
  }

  return Object.freeze({
    LOOP_HEADER,
    connect,
    fetch,
    lookup,
    rawRequest,
    destroy() {
      httpsAgent.destroy();
      httpAgent.destroy();
      passthroughHttpsAgent.destroy();
      passthroughHttpAgent.destroy();
    }
  });
}

module.exports = { createUpstream, LOOP_HEADER, DEFAULT_USER_AGENT };
