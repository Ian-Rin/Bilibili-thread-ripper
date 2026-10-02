"use strict";
// The LAN proxy's index-aware VOD path and its live module, against a fake CDN on this
// machine: a DASH file with a real SIDX box, and an fMP4 HLS stream with a playlist and
// one-second segments. Nothing here touches the network.
const { test, after } = require("node:test"), assert = require("node:assert/strict");
const crypto = require("node:crypto"), fs = require("node:fs"), http = require("node:http"), https = require("node:https");
const net = require("node:net"), os = require("node:os"), path = require("node:path"), tls = require("node:tls");
const x509 = require("../proxy/x509.js");
const { loadSharedCore } = require("../proxy/shared-core.js");
const { createUpstream } = require("../proxy/upstream.js");
const { createMediaCache } = require("../proxy/media-cache.js");
const { createLiveCache } = require("../proxy/live-cache.js");
const { createProxyServer } = require("../proxy/server.js");

const KIB = 1024, MIB = 1024 * KIB;

// ---- a DASH file with an index: ftyp + moov (1024 bytes), a SIDX box, then 12 segments ----
const SEGMENT_BYTES = 512 * KIB, SEGMENT_COUNT = 12, SEGMENT_MS = 2000;
const INIT_END = 1023;
function box(type, payload) {
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(out.length, 0);
  out.write(type, 4, "ascii");
  payload.copy(out, 8);
  return out;
}
const sidxPayload = Buffer.alloc(24 + 12 * SEGMENT_COUNT);
sidxPayload.writeUInt32BE(0, 0);            // version 0, flags
sidxPayload.writeUInt32BE(1, 4);            // reference_ID
sidxPayload.writeUInt32BE(1000, 8);         // timescale
sidxPayload.writeUInt32BE(0, 12);           // earliest_presentation_time
sidxPayload.writeUInt32BE(0, 16);           // first_offset
sidxPayload.writeUInt16BE(0, 20);           // reserved
sidxPayload.writeUInt16BE(SEGMENT_COUNT, 22);
for (let index = 0; index < SEGMENT_COUNT; index += 1) {
  sidxPayload.writeUInt32BE(SEGMENT_BYTES, 24 + index * 12);      // media reference, size
  sidxPayload.writeUInt32BE(SEGMENT_MS, 28 + index * 12);         // duration
  sidxPayload.writeUInt32BE(0x90000000, 32 + index * 12);        // SAP
}
const HEADER = Buffer.concat([box("ftyp", Buffer.alloc(16)), box("moov", Buffer.alloc(992)), box("sidx", sidxPayload)]);
assert.equal(HEADER.length, 1024 + 8 + sidxPayload.length);
const INDEX_START = 1024, INDEX_END = HEADER.length - 1, MEDIA_START = HEADER.length;
const FILE_SIZE = MEDIA_START + SEGMENT_BYTES * SEGMENT_COUNT;
const VIDEO_PATH = "/upgcxcode/55/66/777777/777777-1-30080.m4s";
const QUERY = "?e=abc&deadline=1760000000&os=alibv&upsig=0123&uparams=e,deadline,os&platform=pc";
function byteAt(index) {
  return index < HEADER.length ? HEADER[index] : (((index * 2654435761) >>> 24) ^ (index & 0xff)) & 0xff;
}
function fileBytes(start, end) {
  const out = Buffer.alloc(end - start + 1);
  for (let index = start; index <= end; index += 1) out[index - start] = byteAt(index);
  return out;
}
const segmentRange = (index) => ({ start: MEDIA_START + index * SEGMENT_BYTES, end: MEDIA_START + (index + 1) * SEGMENT_BYTES - 1 });

// ---- a live stream ----
const LIVE_DIR = "/live-bvc/123456/live_1234_5678/";
const LIVE_QUERY = "?expires=1760000000&len=0&oi=1&pt=web&qn=10000&trid=abc&sigparams=cdn,expires,len,oi,pt,qn,trid&cdn=cn-gotcha208&sign=xyz";
const LIVE_MAP = "h1759358400.m4s";
const LIVE_SEGMENTS = [100, 101, 102];
function liveSegmentBytes(name) {
  const seed = crypto.createHash("sha256").update(name).digest();
  const out = Buffer.alloc(64 * KIB);
  for (let index = 0; index < out.length; index += 1) out[index] = seed[index % 32] ^ (index & 0xff);
  return out;
}
const livePlaylist = () => ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:1", `#EXT-X-MEDIA-SEQUENCE:${LIVE_SEGMENTS[0]}`, `#EXT-X-MAP:URI="${LIVE_MAP}"`,
  ...LIVE_SEGMENTS.flatMap((num) => ["#EXTINF:1.000,", `${num}.m4s`]), ""].join("\n");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "btr-lan-proxy-media-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const originAuthority = x509.loadAuthority(path.join(temp, "origin-ca"));
const originSeen = { hosts: new Map(), requests: [] };
function originHandler(request, response) {
  const host = String(request.headers.host || "").split(":")[0];
  originSeen.hosts.set(host, (originSeen.hosts.get(host) || 0) + 1);
  originSeen.requests.push({ host, url: request.url, range: request.headers.range || "", at: Date.now() });
  const url = new URL(request.url, "https://x");
  const serve = () => {
    if (url.pathname === VIDEO_PATH) {
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || "");
      if (!range) {
        response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(FILE_SIZE), "X-Origin": "1" });
        return response.end(fileBytes(0, FILE_SIZE - 1));
      }
      const start = Number(range[1]), end = Math.min(Number(range[2]), FILE_SIZE - 1);
      if (start >= FILE_SIZE) { response.writeHead(416, { "Content-Range": `bytes */${FILE_SIZE}` }); return response.end(); }
      response.writeHead(206, { "Content-Type": "video/mp4", "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${FILE_SIZE}`, "X-Origin": "1" });
      return response.end(fileBytes(start, end));
    }
    if (url.pathname.startsWith(LIVE_DIR)) {
      const name = url.pathname.slice(LIVE_DIR.length);
      if (name === "index.m3u8") {
        response.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "X-Origin": "1" });
        return response.end(livePlaylist());
      }
      if (name === "master.m3u8") {
        response.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl", "X-Origin": "1" });
        return response.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nindex.m3u8\n");
      }
      const number = /^(\d+)\.m4s$/.exec(name);
      const known = name === LIVE_MAP || (number && Number(number[1]) >= 100 && Number(number[1]) <= 105 && Number(number[1]) !== 103);
      if (!known) { response.writeHead(404); return response.end(); }
      const bytes = liveSegmentBytes(name);
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || "");
      if (range) {
        const start = Number(range[1]), end = Math.min(Number(range[2]), bytes.length - 1);
        response.writeHead(206, { "Content-Type": "video/iso.segment", "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "X-Origin": "1" });
        return response.end(bytes.subarray(start, end + 1));
      }
      response.writeHead(200, { "Content-Type": "video/iso.segment", "Content-Length": String(bytes.length), "X-Origin": "1" });
      return response.end(bytes);
    }
    response.writeHead(404);
    response.end();
  };
  setTimeout(serve, 15 + (host.length % 5) * 5);
}
const origin = https.createServer({
  SNICallback(name, callback) {
    const issued = originAuthority.serverCertificate(name);
    callback(null, tls.createSecureContext({ key: issued.key, cert: issued.cert }));
  }
}, originHandler);

const proxyAuthority = x509.loadAuthority(path.join(temp, "proxy-ca"));
const shared = loadSharedCore();
let upstream, cache, live, proxy, ports;
const logs = [];
const log = (level, message) => logs.push(`${level} ${message}`);

test("setup", async () => {
  await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originPort = origin.address().port;
  upstream = createUpstream({ lookup: (_h, _o, callback) => callback(null, "127.0.0.1", 4), port: { "https:": originPort, "http:": originPort }, ca: originAuthority.certificatePem });
  const settings = shared.core.normalizeSettings({ concurrency: 16 });
  cache = createMediaCache({ shared, upstream, log, settings, readAheadSeconds: 20, sweepMs: 200, fileIdleMs: 5000 });
  live = createLiveCache({ shared, upstream, log, getSettings: () => settings, sweepMs: 200 });
  proxy = createProxyServer({ authority: proxyAuthority, cache, live, upstream, shared, log });
  const listening = await proxy.listen({ host: "127.0.0.1", proxyPort: 0 });
  ports = { proxy: listening.proxy.port };
});
after(() => { cache?.close(); live?.close(); proxy?.close(); upstream?.destroy(); origin.close(); });

function connectThroughProxy(host, port = 443) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(ports.proxy, "127.0.0.1", () => socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
    let buffered = "";
    const onData = (chunk) => {
      buffered += chunk.toString("latin1");
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.removeListener("data", onData);
      const rest = Buffer.from(buffered.slice(end + 4), "latin1");
      if (rest.length) socket.unshift(rest);
      resolve({ socket, status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(buffered)?.[1]) });
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}
function requestOver(socket, { host, path: requestPath, headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ method: "GET", path: requestPath, headers: { host, ...headers }, createConnection: () => socket }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}
async function viaProxy(servername, requestPath, headers = {}, port = 443) {
  const { socket, status } = await connectThroughProxy(servername, port);
  assert.equal(status, 200, "CONNECT accepted");
  const secure = await new Promise((resolve, reject) => {
    const client = tls.connect({ socket, servername, ca: [proxyAuthority.certificatePem] }, () => resolve(client));
    client.once("error", reject);
  });
  assert.equal(secure.authorized, true, secure.authorizationError);
  const response = await requestOver(secure, { host: servername, path: requestPath, headers });
  secure.destroy();
  return response;
}
const until = async (predicate, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
};
const videoFile = () => cache.status().files.find((file) => file.path === VIDEO_PATH);

test("the index is read from the player's own index request, nothing is known before it", async () => {
  const host = "upos-sz-mirrorali.bilivideo.com";
  const init = await viaProxy(host, `${VIDEO_PATH}${QUERY}`, { range: `bytes=0-${INIT_END}` });
  assert.equal(init.status, 206);
  assert.ok(init.body.equals(fileBytes(0, INIT_END)));
  await until(() => videoFile()?.pieces.every((piece) => piece.done));
  assert.equal(videoFile().segments, 0, "ftyp and moov carry no index");
  const index = await viaProxy(host, `${VIDEO_PATH}${QUERY}`, { range: `bytes=${INDEX_START}-${INDEX_END}` });
  assert.equal(index.status, 206);
  assert.ok(index.body.equals(fileBytes(INDEX_START, INDEX_END)));
  assert.ok(await until(() => videoFile()?.segments === SEGMENT_COUNT), JSON.stringify(videoFile()));
  assert.equal(videoFile().playhead, null, "no media requested yet, so no playback clock");
  assert.equal(videoFile().pieces.filter((piece) => !piece.demand).length, 0, "header requests start no read-ahead");
});

test("the first media request anchors the clock and the read-ahead follows the segments to the horizon", async () => {
  const host = "upos-sz-mirrorhw.bilivideo.com";
  const first = segmentRange(0);
  const response = await viaProxy(host, `${VIDEO_PATH}${QUERY}`, { range: `bytes=${first.start}-${first.end}` });
  assert.equal(response.status, 206);
  assert.ok(response.body.equals(fileBytes(first.start, first.end)));
  const file = videoFile();
  assert.ok(file.playhead !== null && file.playhead < 1.5, `playhead starts at the requested segment (${file.playhead})`);
  // Horizon: segment 0 ends at 2 s, plus 20 s: segments 1 to 10 (start times 2 to 20 s).
  const expected = Array.from({ length: 10 }, (_item, index) => segmentRange(index + 1));
  assert.ok(await until(() => {
    const ahead = videoFile()?.pieces.filter((piece) => !piece.demand) || [];
    return expected.every((segment) => ahead.some((piece) => piece.start === segment.start && piece.end === segment.end && piece.done));
  }, 15000), JSON.stringify(videoFile()?.pieces));
  const ahead = videoFile().pieces.filter((piece) => !piece.demand);
  assert.ok(ahead.every((piece) => (piece.start - MEDIA_START) % SEGMENT_BYTES === 0), "every read-ahead piece starts on a segment boundary");
  assert.ok(!ahead.some((piece) => piece.start === segmentRange(11).start), "segment 11 (22 s) lies past the horizon");
  const before = cache.status().aheadHits;
  const second = segmentRange(1);
  const hit = await viaProxy(host, `${VIDEO_PATH}${QUERY}`, { range: `bytes=${second.start}-${second.end}` });
  assert.equal(hit.status, 206);
  assert.ok(hit.body.equals(fileBytes(second.start, second.end)));
  assert.equal(cache.status().aheadHits, before + 1, "served from the read-ahead");
  assert.ok(videoFile().requestedAhead >= 3, `requests run ahead of the estimated playhead (${videoFile().requestedAhead})`);
});

test("a seek re-anchors the clock, drops far-behind data and reads ahead from the new place", async () => {
  const host = "upos-sz-mirrorhw.bilivideo.com";
  const target = segmentRange(8);
  const response = await viaProxy(host, `${VIDEO_PATH}${QUERY}`, { range: `bytes=${target.start}-${target.end}` });
  assert.equal(response.status, 206);
  assert.ok(response.body.equals(fileBytes(target.start, target.end)));
  const file = videoFile();
  assert.ok(file.playhead >= 16 && file.playhead < 17.5, `playhead moved to segment 8 (${file.playhead})`);
  assert.ok(!file.pieces.some((piece) => piece.end <= INDEX_END), "header pieces far behind are released");
  assert.ok(await until(() => videoFile()?.pieces.some((piece) => !piece.demand && piece.start === segmentRange(11).start && piece.done)), "the last segment is read ahead now");
  assert.ok(cache.status().indexedFiles >= 1);
});

test("live: the playlist passes through and its segments are prefetched from racing nodes", async () => {
  const host = "d1--ov-gotcha208.bilivideo.com";
  originSeen.requests.length = 0;
  const playlist = await viaProxy(host, `${LIVE_DIR}index.m3u8${LIVE_QUERY}`);
  assert.equal(playlist.status, 200);
  assert.equal(playlist.headers["x-btr-proxy"], "live-playlist");
  assert.equal(playlist.body.toString(), livePlaylist(), "the playlist reaches the player unchanged");
  assert.ok(await until(() => live.status().streams[0]?.ready >= LIVE_SEGMENTS.length + 1), JSON.stringify(live.status()));
  const prefetched = originSeen.requests.filter((item) => item.url.startsWith(LIVE_DIR) && !item.range && !item.url.includes("m3u8"));
  for (const name of [LIVE_MAP, ...LIVE_SEGMENTS.map((num) => `${num}.m4s`)]) {
    assert.ok(prefetched.some((item) => item.url.startsWith(`${LIVE_DIR}${name}`)), `${name} fetched before the player asked`);
  }
  // Every unproven node of the fMP4 group was probed with a tiny range.
  const probes = originSeen.requests.filter((item) => item.range === "bytes=0-2047");
  const probedHosts = new Set(probes.map((item) => item.host));
  assert.ok(probedHosts.size >= 3, `nodes probed: ${[...probedHosts].join(", ")}`);
  const stream = live.status().streams[0];
  assert.ok(stream.hosts.filter((item) => item.state === "healthy").length >= 3, JSON.stringify(stream.hosts));
});

test("live: a segment the player asks for comes from the prefetch, a new one is downloaded, relays are rewritten", async () => {
  const host = "d1--ov-gotcha208.bilivideo.com";
  const cached = await viaProxy(host, `${LIVE_DIR}101.m4s${LIVE_QUERY}`);
  assert.equal(cached.status, 200);
  assert.equal(cached.headers["x-btr-proxy"], "live-prefetched");
  assert.equal(cached.headers["content-type"], "video/iso.segment");
  assert.ok(cached.body.equals(liveSegmentBytes("101.m4s")));
  const fresh = await viaProxy(host, `${LIVE_DIR}105.m4s${LIVE_QUERY}`);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.headers["x-btr-proxy"], "live");
  assert.ok(fresh.body.equals(liveSegmentBytes("105.m4s")));
  // A PCDN relay address on port 4483: intercepted and answered from the official nodes.
  originSeen.hosts.clear();
  const relay = await viaProxy("xy1x2x3x4xy.mcdn.bilivideo.cn", `${LIVE_DIR}102.m4s${LIVE_QUERY}`, {}, 4483);
  assert.equal(relay.status, 200);
  assert.equal(relay.headers["x-btr-proxy"], "live-prefetched");
  assert.ok(relay.body.equals(liveSegmentBytes("102.m4s")));
  assert.ok(![...originSeen.hosts.keys()].some((item) => item.includes("mcdn")), "nothing was asked of the relay itself");
  // A ranged segment request is not the module's business and passes through.
  const ranged = await viaProxy(host, `${LIVE_DIR}100.m4s${LIVE_QUERY}`, { range: "bytes=0-1023" });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers["x-origin"], "1");
  assert.equal(ranged.headers["x-btr-proxy"], undefined);
  // A master playlist is relayed and starts no prefetch.
  const master = await viaProxy(host, `${LIVE_DIR}master.m3u8${LIVE_QUERY}`);
  assert.equal(master.status, 200);
  assert.ok(master.body.toString().includes("#EXT-X-STREAM-INF"));
  const status = live.status();
  assert.ok(status.segmentHits >= 2 && status.segments >= 3, JSON.stringify(status));
});

test("live: a stream nobody watches is forgotten", async () => {
  live.config.streamIdleMs = 300;
  assert.ok(await until(() => live.status().streams.length === 0, 3000), JSON.stringify(live.status().streams));
});
