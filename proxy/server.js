"use strict";
// The network side of the LAN proxy. Three ways in, one handler:
//   - an ordinary HTTP proxy (CONNECT): a browser or a device with a proxy setting. A CONNECT
//     to a CDN node is answered by the proxy itself, with a certificate for that name from
//     the proxy's CA; any other CONNECT becomes a plain tunnel.
//   - the TLS port of the transparent and DNS deployments: a connection arrives as if this
//     machine were the CDN node. The server name in the client's first TLS record says which
//     one; a name that is not a CDN node is spliced through to the real server.
//   - a plain HTTP port for the same deployments, for clients that still use http://.
// Inside a terminated connection every request is looked at: a bounded Range request for a
// media file goes to the cache, which downloads it in pieces from many nodes; everything
// else is passed through to its original host.
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const { LOOP_HEADER } = require("./upstream.js");

// The hosts whose TLS is terminated: Bilibili's video servers. hdslb.com also carries the
// site's static files, so only its upos- names count.
const INTERCEPT_HOST_RE = /(?:^|\.)(?:bilivideo\.(?:com|cn|net)|akamaized\.net|szbdyd\.com|xycdn\.com|mountaintoys\.cn|nexusedgeio\.com|ahdohpiechei\.com)$/i;
const UPOS_HDSLB_RE = /^upos-[\w-]+\.hdslb\.com$/i;
function isInterceptHost(host) {
  const name = String(host || "").toLowerCase().replace(/\.$/, "");
  return INTERCEPT_HOST_RE.test(name) || UPOS_HDSLB_RE.test(name);
}

const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade"];
// Headers of a passed-through answer that must not reach the client: an Alt-Svc offer of
// HTTP/3 would move the next connections to UDP, past the proxy.
const STRIPPED_RESPONSE = [...HOP_BY_HOP, "alt-svc"];
// Requests with these are the player checking or validating something, not fetching media.
const CONDITIONAL = ["if-match", "if-none-match", "if-modified-since", "if-unmodified-since", "if-range"];

// Reads the server name out of a TLS ClientHello. { complete: false } while more bytes are
// needed; { complete: true, tls: false } for something that is not TLS; otherwise the SNI
// name or null.
function peekClientHello(buffer) {
  if (buffer.length < 5) return { complete: false };
  if (buffer[0] !== 0x16 || buffer[1] !== 0x03) return { complete: true, tls: false, sni: null };
  // The handshake message may span several records; gather their payloads.
  const payloads = [];
  let offset = 0;
  let gathered = 0;
  let needed = 4;
  while (gathered < needed) {
    if (offset + 5 > buffer.length) return { complete: false };
    if (buffer[offset] !== 0x16) return { complete: true, tls: false, sni: null };
    const length = buffer.readUInt16BE(offset + 3);
    if (offset + 5 + length > buffer.length) return { complete: false };
    payloads.push(buffer.subarray(offset + 5, offset + 5 + length));
    gathered += length;
    offset += 5 + length;
    const head = Buffer.concat(payloads);
    if (head.length >= 4) {
      if (head[0] !== 0x01) return { complete: true, tls: true, sni: null };
      needed = 4 + head.readUIntBE(1, 3);
    }
  }
  const hello = Buffer.concat(payloads).subarray(0, needed);
  try {
    let cursor = 4 + 2 + 32;
    cursor += 1 + hello[cursor];
    cursor += 2 + hello.readUInt16BE(cursor);
    cursor += 1 + hello[cursor];
    if (cursor + 2 > hello.length) return { complete: true, tls: true, sni: null };
    const extensionsEnd = cursor + 2 + hello.readUInt16BE(cursor);
    cursor += 2;
    while (cursor + 4 <= extensionsEnd && cursor + 4 <= hello.length) {
      const type = hello.readUInt16BE(cursor);
      const length = hello.readUInt16BE(cursor + 2);
      cursor += 4;
      if (type === 0) {
        let inner = cursor + 2;
        const listEnd = cursor + 2 + hello.readUInt16BE(cursor);
        while (inner + 3 <= listEnd) {
          const nameType = hello[inner];
          const nameLength = hello.readUInt16BE(inner + 1);
          if (nameType === 0) return { complete: true, tls: true, sni: hello.toString("ascii", inner + 3, inner + 3 + nameLength).toLowerCase() };
          inner += 3 + nameLength;
        }
        return { complete: true, tls: true, sni: null };
      }
      cursor += length;
    }
  } catch (_error) {}
  return { complete: true, tls: true, sni: null };
}

function splitHostPort(value, defaultPort) {
  const text = String(value || "");
  const match = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(text);
  if (!match) return null;
  return { host: match[1].toLowerCase(), port: Number(match[2]) || defaultPort };
}

function contentTypeFor(url) {
  return /\.flv$/i.test(url.pathname) ? "video/x-flv" : "video/mp4";
}

function clientIp(socket) {
  const address = String(socket?.remoteAddress || socket?._parent?.remoteAddress || "");
  return address.replace(/^::ffff:/i, "");
}

function createProxyServer(options) {
  const { authority, cache, upstream, shared } = options;
  // The live module (proxy/live-cache.js); null leaves live streams passed through.
  const live = options.live || null;
  const log = typeof options.log === "function" ? options.log : () => {};
  const stats = { connections: 0, tlsIntercepted: 0, tunnels: 0, spliced: 0, accelerated: 0, passthrough: 0, fallbacks: 0, loops: 0, bypassed: 0, livePlaylists: 0, liveSegments: 0 };
  const contexts = new Map();

  // Devices that do not trust the proxy's certificate (an Android app, a TV) fail the TLS
  // handshake on every connection, and in the DNS and transparent deployments their video
  // would simply stop. After a few failures in a row such a device is let through to the
  // real servers for a while, unaccelerated but working, and shown on the status page.
  const bypass = {
    after: Math.max(0, Math.trunc(Number(options.bypassAfter ?? 3)) || 0),
    ms: Math.max(1000, Number(options.bypassMs) || 15 * 60 * 1000),
    windowMs: 120000
  };
  const clients = new Map();
  function clientRecord(ip) {
    let record = clients.get(ip);
    if (!record) {
      record = { ip, failures: [], total: 0, bypasses: 0, until: 0, lastError: "", lastFailureAt: 0 };
      if (clients.size >= 1024) clients.delete(clients.keys().next().value);
      clients.set(ip, record);
    }
    return record;
  }
  function isBypassed(ip) {
    const record = clients.get(ip);
    return Boolean(record && record.until > Date.now());
  }
  function noteHandshakeFailure(ip, error) {
    if (!bypass.after || !ip) return;
    const now = Date.now();
    const record = clientRecord(ip);
    record.failures = record.failures.filter((at) => now - at < bypass.windowMs);
    record.failures.push(now);
    record.total += 1;
    record.lastFailureAt = now;
    record.lastError = String(error?.code || error?.message || error || "").slice(0, 80);
    if (record.until > now || record.failures.length < bypass.after) return;
    record.until = now + bypass.ms;
    record.bypasses += 1;
    record.failures = [];
    log("warn", `设备 ${ip} 连续 ${bypass.after} 次 TLS 握手失败（${record.lastError}），接下来 ${Math.round(bypass.ms / 60000)} 分钟对它直接放行，不加速。请在这台设备上安装并信任代理的证书。`);
  }

  function secureContextFor(servername) {
    const host = String(servername || "").toLowerCase();
    let entry = contexts.get(host);
    if (entry && entry.until > Date.now()) return entry.context;
    const certificate = authority.serverCertificate(host);
    const context = tls.createSecureContext({ key: certificate.key, cert: certificate.cert });
    if (contexts.size >= 256) contexts.delete(contexts.keys().next().value);
    contexts.set(host, { context, until: Date.now() + 6 * 3600 * 1000 });
    return context;
  }

  const fallback = authority.serverCertificate("btr-lan-proxy.invalid");
  const httpsServer = https.createServer({
    key: fallback.key,
    cert: fallback.cert,
    ALPNProtocols: ["http/1.1"],
    SNICallback(servername, callback) {
      try { callback(null, secureContextFor(servername)); }
      catch (error) { callback(error); }
    }
  }, (request, response) => handleRequest(request, response, "https"));
  httpsServer.on("tlsClientError", (error, socket) => {
    const name = socket?.servername || "";
    const ip = clientIp(socket);
    // A client that does not trust the CA fails here, with an "unknown ca" or "bad
    // certificate" alert, or by closing the connection; worth a line, not a stack.
    log("debug", `TLS 握手失败${name ? `（${name}）` : ""}${ip ? ` 来自 ${ip}` : ""}：${error?.message || error}`);
    noteHandshakeFailure(ip, error);
  });
  const httpServer = http.createServer((request, response) => handleRequest(request, response, "http"));
  const proxyServer = http.createServer((request, response) => handleRequest(request, response, "proxy"));
  proxyServer.on("connect", handleConnect);
  const transparentServer = net.createServer(handleTransparentTls);
  for (const server of [httpsServer, httpServer, proxyServer]) {
    server.keepAliveTimeout = 30000;
    server.requestTimeout = 0;
    server.headersTimeout = 60000;
    server.on("clientError", (error, socket) => {
      if (error.code !== "ECONNRESET" && socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      else socket.destroy();
    });
  }

  function absoluteUrl(request, via) {
    const raw = String(request.url || "");
    try {
      if (/^https?:\/\//i.test(raw)) return new URL(raw);
      const host = request.headers.host;
      if (!host || raw === "*") return null;
      const scheme = via === "https" || request.socket?.encrypted ? "https" : "http";
      return new URL(`${scheme}://${host}${raw.startsWith("/") ? raw : `/${raw}`}`);
    } catch (_error) {
      return null;
    }
  }

  function respond(response, status, text) {
    if (response.headersSent) return response.destroy();
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    response.end(text);
  }

  function corsHeaders(request) {
    const origin = request.headers.origin;
    return {
      "Access-Control-Allow-Origin": origin || "*",
      ...(origin ? { "Access-Control-Allow-Credentials": "true" } : {}),
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
      "Timing-Allow-Origin": "*"
    };
  }

  // What to do with a request. Bounded GET Range requests for media files go to the media
  // cache. Live playlists and whole live segments go to the live module, and any other
  // address of a P2P or commercial relay is passed through to the official node instead.
  // Everything else is passed through as it is.
  function plan(request, url) {
    if (request.method !== "GET") return null;
    const mediaUrl = new URL(url.href);
    mediaUrl.protocol = "https:";
    if (CONDITIONAL.some((name) => request.headers[name] !== undefined)) return null;
    const range = shared.core.parseRangeHeader(request.headers.range);
    if (live) {
      if (live.isPlaylistUrl(mediaUrl.href)) return { live: "playlist", mediaUrl };
      if (live.isSegmentUrl(mediaUrl.href) && !request.headers.range) return { live: "segment", mediaUrl };
      const rewritten = live.rewriteUrl(mediaUrl.href);
      if (rewritten !== mediaUrl.href) return { passthroughTo: new URL(rewritten) };
    }
    if (!range) return null;
    if (!shared.core.isBilibiliMediaUrl(mediaUrl.href) || /\/live-bvc\//i.test(mediaUrl.pathname)) return null;
    return { range, mediaUrl };
  }

  async function handleRequest(request, response, via) {
    stats.connections += 1;
    const url = absoluteUrl(request, via);
    if (!url) return respond(response, 400, "这个代理需要完整的请求地址（或 Host 头）。");
    if (request.headers[LOOP_HEADER]) {
      stats.loops += 1;
      log("error", `代理循环：对 ${url.host} 的请求又回到了代理自己。DNS 部署里请用 --dns-upstream 指定上游 DNS。`);
      return respond(response, 508, "BTR LAN proxy: 代理循环，请检查上游 DNS 设置。");
    }
    const planned = plan(request, url);
    if (!planned) return passthrough(request, response, url);
    if (planned.passthroughTo) return passthrough(request, response, planned.passthroughTo);
    const controller = new AbortController();
    response.once("close", () => {
      if (!response.writableFinished) controller.abort(new DOMException("客户端已断开", "AbortError"));
    });
    if (planned.live) return handleLive(request, response, planned, controller);
    stats.accelerated += 1;
    const { range, mediaUrl } = planned;
    const sink = {
      head(total) {
        response.writeHead(206, {
          ...corsHeaders(request),
          "Content-Type": contentTypeFor(mediaUrl),
          "Content-Length": String(range.length),
          "Content-Range": `bytes ${range.start}-${range.end}/${total}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
          "X-BTR-Proxy": "accelerated"
        });
      },
      write(bytes) {
        return new Promise((resolve, reject) => {
          if (response.destroyed) return reject(new DOMException("客户端已断开", "AbortError"));
          const ok = response.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
          if (ok) resolve();
          else {
            const done = () => { response.removeListener("close", closed); resolve(); };
            const closed = () => { response.removeListener("drain", done); reject(new DOMException("客户端已断开", "AbortError")); };
            response.once("drain", done);
            response.once("close", closed);
          }
        });
      }
    };
    try {
      const result = await cache.serve({ url: mediaUrl, range, headers: request.headers, signal: controller.signal }, sink);
      response.end();
      log("debug", `206 ${mediaUrl.pathname.split("/").pop()} [${range.start}-${range.end}] ${result.pieces} 段${result.fromCache ? `，预读命中 ${Math.round(result.fromCache / 1024)} KiB` : ""}`);
    } catch (error) {
      if (error?.name === "AbortError" || controller.signal.aborted) return response.destroy();
      if (!error?.headed && !response.headersSent) {
        stats.fallbacks += 1;
        log("warn", `加速失败，交回原始连接：${mediaUrl.pathname.split("/").pop()} [${range.start}-${range.end}]：${error?.message || error}`);
        return passthrough(request, response, url);
      }
      log("warn", `传输中断：${error?.message || error}`);
      response.destroy();
    }
  }

  // A live playlist is fetched and handed back whole (the module reads it on the way); a
  // live segment comes from the module's cache or its node race. Either failing falls back
  // to the plain passthrough, to the official node.
  async function handleLive(request, response, planned, controller) {
    const { mediaUrl } = planned;
    const target = new URL(live.rewriteUrl(mediaUrl.href));
    try {
      if (planned.live === "playlist") {
        stats.livePlaylists += 1;
        const result = await live.fetchPlaylist(mediaUrl.href, request.headers, controller.signal);
        if (controller.signal.aborted) return response.destroy();
        const headers = { ...corsHeaders(request), "Cache-Control": "no-store", "X-BTR-Proxy": "live-playlist" };
        for (const name of ["content-type", "last-modified", "etag", "date"]) {
          const value = result.headers.get(name);
          if (value) headers[name] = value;
        }
        headers["Content-Length"] = String(Buffer.byteLength(result.text));
        response.writeHead(result.status, headers);
        return response.end(result.text);
      }
      stats.liveSegments += 1;
      const result = await live.fetchSegment(mediaUrl.href, request.headers, controller.signal);
      if (controller.signal.aborted) return response.destroy();
      response.writeHead(200, {
        ...corsHeaders(request),
        "Content-Type": result.contentType,
        "Content-Length": String(result.bytes.byteLength),
        "Cache-Control": "no-store",
        "X-BTR-Proxy": result.fromCache ? "live-prefetched" : "live"
      });
      response.end(Buffer.from(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength));
      log("debug", `直播分片 ${mediaUrl.pathname.split("/").pop()} ${result.fromCache ? "预取命中" : `来自 ${result.host}`}`);
    } catch (error) {
      if (error?.name === "AbortError" || controller.signal.aborted) return response.destroy();
      if (response.headersSent) return response.destroy();
      stats.fallbacks += 1;
      log("warn", `直播${planned.live === "playlist" ? "列表" : "分片"}处理失败，交回原始连接：${error?.message || error}`);
      passthrough(request, response, target);
    }
  }

  function passthrough(request, response, url) {
    stats.passthrough += 1;
    const headers = { ...request.headers };
    for (const name of HOP_BY_HOP) delete headers[name];
    headers.host = url.host;
    headers[LOOP_HEADER] = "1";
    let outgoing;
    try { outgoing = upstream.rawRequest(url, request.method, headers); }
    catch (error) { return respond(response, 502, `无法转发：${error.message}`); }
    const stop = () => { if (!response.writableFinished) outgoing.destroy(); };
    response.once("close", stop);
    outgoing.once("response", (incoming) => {
      const outHeaders = { ...incoming.headers };
      for (const name of STRIPPED_RESPONSE) delete outHeaders[name];
      if (response.destroyed) return incoming.destroy();
      response.writeHead(incoming.statusCode, incoming.statusMessage, outHeaders);
      incoming.pipe(response);
      incoming.once("error", () => response.destroy());
    });
    outgoing.once("error", (error) => {
      log("debug", `转发 ${url.host} 失败：${error.message}`);
      if (!response.headersSent) respond(response, 502, `上游请求失败：${error.message}`);
      else response.destroy();
    });
    request.pipe(outgoing);
  }

  // A socket that already belongs to the client, now served as a TLS connection of our own.
  // A client that rejects the certificate drops the connection after the server's first
  // flight. The proxy server's sockets allow half-open connections (as every http.Server's
  // do), and the TLS socket inherits that, so such a drop would never close the server side:
  // no failure would be seen, and the socket would stay open for good. Hence allowHalfOpen
  // is cleared, and a handshake that has not completed within the limit is ended here.
  const HANDSHAKE_TIMEOUT_MS = 15000;
  const secured = new WeakSet();
  httpsServer.on("secureConnection", (tlsSocket) => {
    if (tlsSocket._parent) secured.add(tlsSocket._parent);
  });
  function adopt(socket, head) {
    socket.removeAllListeners("data");
    socket.pause();
    socket.allowHalfOpen = false;
    if (head?.length) socket.unshift(head);
    const ip = clientIp(socket);
    const timer = setTimeout(() => {
      if (secured.has(socket) || socket.destroyed) return;
      log("debug", `TLS 握手 ${HANDSHAKE_TIMEOUT_MS / 1000} 秒没有完成${ip ? `（${ip}）` : ""}，已关闭`);
      noteHandshakeFailure(ip, "handshake timeout");
      socket.destroy();
    }, HANDSHAKE_TIMEOUT_MS);
    socket.once("close", () => clearTimeout(timer));
    httpsServer.emit("connection", socket);
  }

  function tunnel(client, server) {
    client.pipe(server);
    server.pipe(client);
    const close = () => { client.destroy(); server.destroy(); };
    client.once("error", close);
    server.once("error", close);
    client.once("close", close);
    server.once("close", close);
  }

  function handleConnect(request, socket, head) {
    socket.on("error", () => {});
    const target = splitHostPort(request.url, 443);
    if (!target) return socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    // 4483 is the port of the PCDN relays (xxx.mcdn.bilivideo.cn), whose addresses the live
    // module turns back into official nodes.
    if ((target.port === 443 || (live && target.port === 4483)) && isInterceptHost(target.host)) {
      if (isBypassed(clientIp(socket))) stats.bypassed += 1;
      else {
        stats.tlsIntercepted += 1;
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        return adopt(socket, head);
      }
    }
    stats.tunnels += 1;
    upstream.connect(target.host, target.port).then((server) => {
      if (socket.destroyed) return server.destroy();
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) server.write(head);
      tunnel(socket, server);
    }, (error) => {
      socket.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n无法连接 ${target.host}:${target.port}：${error.message}`);
    });
  }

  // The transparent TLS port: the first bytes decide where the connection goes.
  function handleTransparentTls(socket) {
    socket.on("error", () => {});
    const chunks = [];
    let length = 0;
    const timer = setTimeout(() => socket.destroy(), 8000);
    const onData = (chunk) => {
      chunks.push(chunk);
      length += chunk.length;
      const buffer = Buffer.concat(chunks);
      const peek = peekClientHello(buffer);
      if (!peek.complete) {
        if (length > 65536) socket.destroy();
        return;
      }
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.pause();
      socket.unshift(buffer);
      if (!peek.tls) {
        log("debug", "TLS 端口收到的不是 TLS 连接，已关闭");
        return socket.destroy();
      }
      if (peek.sni && isInterceptHost(peek.sni)) {
        if (isBypassed(clientIp(socket))) stats.bypassed += 1;
        else {
          stats.tlsIntercepted += 1;
          return adopt(socket);
        }
      }
      if (!peek.sni) {
        log("debug", "TLS 连接没有带服务器名，无法知道要转发到哪里");
        return socket.destroy();
      }
      stats.spliced += 1;
      upstream.connect(peek.sni, 443).then((server) => {
        if (socket.destroyed) return server.destroy();
        tunnel(socket, server);
      }, () => socket.destroy());
    };
    socket.on("data", onData);
  }

  function listenOn(server, port, host) {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve(server.address());
      });
    });
  }

  const listening = {};
  return Object.freeze({
    stats,
    listening,
    httpsServer,
    isInterceptHost,
    // A port of null stays closed; 0 takes any free port.
    async listen({ host = "0.0.0.0", proxyPort = null, tlsPort = null, httpPort = null } = {}) {
      if (proxyPort != null) listening.proxy = await listenOn(proxyServer, proxyPort, host);
      if (tlsPort != null) listening.tls = await listenOn(transparentServer, tlsPort, host);
      if (httpPort != null) listening.http = await listenOn(httpServer, httpPort, host);
      return listening;
    },
    isBypassed,
    status() {
      const now = Date.now();
      const untrusted = [...clients.values()]
        .filter((record) => record.until > now || now - record.lastFailureAt < bypass.windowMs)
        .map((record) => ({ ip: record.ip, bypassed: record.until > now, bypassForMs: Math.max(0, record.until - now), failures: record.total, bypasses: record.bypasses, lastError: record.lastError, lastFailureAt: record.lastFailureAt }));
      return { ...stats, listening: { ...listening }, bypass: { after: bypass.after, ms: bypass.ms }, untrusted };
    },
    close() {
      for (const server of [proxyServer, transparentServer, httpServer, httpsServer]) {
        try { server.close(); } catch (_error) {}
        try { server.closeAllConnections?.(); } catch (_error) {}
      }
    }
  });
}

module.exports = { createProxyServer, isInterceptHost, peekClientHello, splitHostPort };
