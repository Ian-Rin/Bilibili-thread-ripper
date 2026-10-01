"use strict";
// The LAN proxy end to end, against a fake CDN on this machine: an HTTPS origin that
// answers for every Bilibili node name with a deterministic file, reached through the proxy
// the three ways a device can reach it (HTTP proxy with CONNECT, the transparent TLS port,
// the plain HTTP port). Nothing here touches the network.
const { test, after } = require("node:test"), assert = require("node:assert/strict");
const crypto = require("node:crypto"), dgram = require("node:dgram"), fs = require("node:fs"), http = require("node:http"), https = require("node:https");
const net = require("node:net"), os = require("node:os"), path = require("node:path"), tls = require("node:tls");
const x509 = require("../proxy/x509.js");
const { loadSharedCore } = require("../proxy/shared-core.js");
const { createUpstream, LOOP_HEADER } = require("../proxy/upstream.js");
const { createMediaCache } = require("../proxy/media-cache.js");
const { createProxyServer, isInterceptHost, peekClientHello } = require("../proxy/server.js");
const { createDnsServer, parseQuestion, TYPE_A, TYPE_AAAA } = require("../proxy/dns.js");

const MIB = 1024 * 1024;
const FILE_SIZE = 6 * MIB + 12345;
const VIDEO_PATH = "/upgcxcode/12/34/123456/123456-1-30080.m4s";
const AUDIO_PATH = "/upgcxcode/12/34/123456/123456-1-30280.m4s";
const QUERY = "?e=ig8euxZM2rNcNbdlhoNvNC8BqJIzNbfqXBvEqxTEto8BTrNvN0GvT90W5JZMkX_YN0MvXg8gNEV4NC8xNEV4N03eN0B5tZlqNxTEto8BTrNvNeZVuJ10Kj_g2UB02J0mN0B5tZlqNCNEto8BTrNvNC7MTX502C8f2jmMQJ6mqF2fka1mqx6gqj0eN0B599M=&uipk=5&nbs=1&deadline=1760000000&gen=playurlv2&os=alibv&oi=1&trid=abcdef&mid=0&platform=pc&upsig=0123456789abcdef&uparams=e,uipk,nbs,deadline,gen,os,oi,trid,mid,platform&bvc=vod&nettype=0&orderid=0,3&buvid=&build=0&f=u_0_0&agrr=0&bw=123456&logo=80000000";

// Byte i of the fake file, cheap and not periodic in any Range size.
function byteAt(index) {
  return ((index * 2654435761) >>> 24) ^ (index & 0xff);
}
function fileBytes(start, end) {
  const out = Buffer.alloc(end - start + 1);
  for (let index = start; index <= end; index += 1) out[index - start] = byteAt(index) & 0xff;
  return out;
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "btr-lan-proxy-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

// ---- the fake CDN ----
const originAuthority = x509.loadAuthority(path.join(temp, "origin-ca"));
const originSeen = { hosts: new Map(), requests: [] };
let originSlowHost = "";
function originHandler(request, response) {
  const host = String(request.headers.host || "").split(":")[0];
  originSeen.hosts.set(host, (originSeen.hosts.get(host) || 0) + 1);
  originSeen.requests.push({ host, url: request.url, range: request.headers.range || "", loop: request.headers[LOOP_HEADER] || "" });
  const url = new URL(request.url, "https://x");
  if (url.pathname === "/hello") {
    response.writeHead(200, { "Content-Type": "text/plain" });
    return response.end(`hello from ${host}`);
  }
  if (url.pathname !== VIDEO_PATH && url.pathname !== AUDIO_PATH) {
    response.writeHead(404);
    return response.end();
  }
  const serve = () => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || "");
    if (!range) {
      response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": String(FILE_SIZE), "Accept-Ranges": "bytes", "X-Origin": "1" });
      return response.end(fileBytes(0, FILE_SIZE - 1));
    }
    const start = Number(range[1]), end = Number(range[2]);
    if (start >= FILE_SIZE) {
      response.writeHead(416, { "Content-Range": `bytes */${FILE_SIZE}` });
      return response.end();
    }
    const last = Math.min(end, FILE_SIZE - 1);
    response.writeHead(206, { "Content-Type": "video/mp4", "Content-Length": String(last - start + 1), "Content-Range": `bytes ${start}-${last}/${FILE_SIZE}`, "Accept-Ranges": "bytes", "X-Origin": "1" });
    response.end(fileBytes(start, last));
  };
  // A little latency per request, as any real route has; on a loopback with none the first
  // probe wins before any other node has sent a byte.
  if (host === originSlowHost) setTimeout(serve, 1500);
  else setTimeout(serve, 15 + (host.length % 5) * 5);
}
const origin = https.createServer({
  SNICallback(name, callback) {
    const issued = originAuthority.serverCertificate(name);
    callback(null, tls.createSecureContext({ key: issued.key, cert: issued.cert }));
  }
}, originHandler);
const originHttp = http.createServer(originHandler);

// ---- the proxy ----
const proxyAuthority = x509.loadAuthority(path.join(temp, "proxy-ca"));
const shared = loadSharedCore();
let upstream, cache, proxy, ports;
const logs = [];
const log = (level, message) => logs.push(`${level} ${message}`);

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

test("setup", async () => {
  const originPort = await listen(origin);
  const originHttpPort = await listen(originHttp);
  // Every host name resolves to the fake CDN, over the proxy's own lookup path.
  upstream = createUpstream({
    lookup: (_hostname, _options, callback) => callback(null, "127.0.0.1", 4),
    port: { "https:": originPort, "http:": originHttpPort },
    ca: originAuthority.certificatePem
  });
  cache = createMediaCache({ shared, upstream, log, settings: { concurrency: 16 }, readAheadMultiple: 1, sweepMs: 200, fileIdleMs: 2000 });
  proxy = createProxyServer({ authority: proxyAuthority, cache, upstream, shared, log });
  const listening = await proxy.listen({ host: "127.0.0.1", proxyPort: 0, tlsPort: 0, httpPort: 0 });
  ports = { proxy: listening.proxy.port, tls: listening.tls.port, http: listening.http.port };
  assert.ok(ports.proxy && ports.tls && ports.http);
});
after(() => {
  cache?.close();
  proxy?.close();
  upstream?.destroy();
  origin.close();
  originHttp.close();
});

// A CONNECT tunnel through the proxy, then TLS inside it as a browser does.
function connectThroughProxy(host, port = 443) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(ports.proxy, "127.0.0.1", () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    let buffered = "";
    const onData = (chunk) => {
      buffered += chunk.toString("latin1");
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      socket.removeListener("data", onData);
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buffered)?.[1]);
      const rest = Buffer.from(buffered.slice(end + 4), "latin1");
      if (rest.length) socket.unshift(rest);
      resolve({ socket, status });
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

function tlsOver(socket, servername, ca) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername, ca }, () => resolve(secure));
    secure.once("error", reject);
  });
}

// One HTTP/1.1 request over a socket we already hold; the whole body is returned.
function requestOver(socket, { method = "GET", host, path: requestPath, headers = {} }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ method, path: requestPath, headers: { host, ...headers }, createConnection: () => socket }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

async function mediaRequest(servername, requestPath, range, options = {}) {
  const { socket, status } = await connectThroughProxy(servername);
  assert.equal(status, 200, "CONNECT accepted");
  const secure = await tlsOver(socket, servername, [proxyAuthority.certificatePem]);
  assert.equal(secure.authorized, true, secure.authorizationError);
  const peer = secure.getPeerCertificate();
  assert.equal(peer.subject.CN, servername, "the proxy presents a certificate for the requested node");
  const response = await requestOver(secure, { host: servername, path: requestPath, headers: range ? { range, ...options.headers } : { ...options.headers } });
  secure.destroy();
  return response;
}

test("intercept decision: Bilibili media hosts, nothing else", () => {
  assert.equal(isInterceptHost("upos-sz-mirrorali.bilivideo.com"), true);
  assert.equal(isInterceptHost("cn-hk-eq-01-01.bilivideo.com"), true);
  assert.equal(isInterceptHost("upos-hz-mirrorakam.akamaized.net"), true);
  assert.equal(isInterceptHost("xy1x2x3x4xy.mcdn.bilivideo.cn"), true);
  assert.equal(isInterceptHost("upos-sz-mirrorali.hdslb.com"), true);
  assert.equal(isInterceptHost("i0.hdslb.com"), false, "static files keep their own TLS");
  assert.equal(isInterceptHost("api.bilibili.com"), false, "the site itself is never touched");
  assert.equal(isInterceptHost("www.bilibili.com"), false);
  assert.equal(isInterceptHost("example.com"), false);
});

test("a Range request through CONNECT is downloaded from many nodes and answered byte for byte", async () => {
  originSeen.hosts.clear();
  originSeen.requests.length = 0;
  const response = await mediaRequest("upos-sz-mirrorali.bilivideo.com", `${VIDEO_PATH}${QUERY}`, "bytes=0-2097151", { headers: { origin: "https://www.bilibili.com", referer: "https://www.bilibili.com/video/BV1xx411c7mD/" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers["content-range"], `bytes 0-2097151/${FILE_SIZE}`);
  assert.equal(response.headers["content-length"], "2097152");
  assert.equal(response.headers["x-btr-proxy"], "accelerated");
  assert.equal(response.headers["access-control-allow-origin"], "https://www.bilibili.com");
  assert.equal(response.headers["content-type"], "video/mp4");
  assert.equal(response.body.length, 2 * MIB);
  assert.ok(response.body.equals(fileBytes(0, 2 * MIB - 1)), "the bytes are the origin's, in order");
  const mediaRequests = originSeen.requests.filter((item) => item.url.startsWith(VIDEO_PATH));
  assert.ok(mediaRequests.length >= 4, `split into pieces (${mediaRequests.length} upstream requests)`);
  assert.ok(originSeen.hosts.size >= 2, `more than one node: ${[...originSeen.hosts.keys()].join(", ")}`);
  assert.ok(mediaRequests.every((item) => item.loop === "1"), "upstream requests carry the loop marker");
  assert.ok(mediaRequests.every((item) => /^bytes=\d+-\d+$/.test(item.range)), "only bounded ranges go upstream");
  for (const host of originSeen.hosts.keys()) assert.ok(isInterceptHost(host) && /bilivideo\.com$/.test(host), host);
});

test("the next sequential request is served from the read-ahead", async () => {
  // Give the read-ahead piece (1x the last request: 2 MiB) a moment.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const file = cache.status().files.find((item) => item.path === VIDEO_PATH);
    if (file?.pieces.some((piece) => !piece.demand && piece.done)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const before = cache.status();
  const file = before.files.find((item) => item.path === VIDEO_PATH);
  assert.ok(file, "the file is known");
  const ahead = file.pieces.find((piece) => !piece.demand);
  assert.ok(ahead && ahead.start === 2 * MIB, `read-ahead starts where the request ended (${JSON.stringify(file.pieces)})`);
  assert.equal(ahead.done, true, "and has finished");
  originSeen.requests.length = 0;
  const response = await mediaRequest("upos-sz-mirrorhw.bilivideo.com", `${VIDEO_PATH}${QUERY.replace("deadline=1760000000", "deadline=1760000600")}`, "bytes=2097152-3145727");
  assert.equal(response.status, 206);
  assert.equal(response.headers["content-range"], `bytes 2097152-3145727/${FILE_SIZE}`);
  assert.ok(response.body.equals(fileBytes(2 * MIB, 3 * MIB - 1)));
  const after_ = cache.status();
  assert.equal(after_.aheadHits, before.aheadHits + 1, "counted as a hit");
  assert.equal(originSeen.requests.filter((item) => item.url.startsWith(VIDEO_PATH) && /bytes=(2\d{6}|30\d{5})-/.test(item.range) && Number(item.range.slice(6).split("-")[0]) < 3 * MIB).length, 0, "nothing of that range was downloaded again");
  // A request that is half cached, half new.
  const mixed = await mediaRequest("upos-sz-mirrorhw.bilivideo.com", `${VIDEO_PATH}${QUERY}`, "bytes=3145728-5242879");
  assert.equal(mixed.status, 206);
  assert.ok(mixed.body.equals(fileBytes(3 * MIB, 5 * MIB - 1)), "cached head and fresh tail joined correctly");
});

test("the audio file of the same video shares the node list, a seek drops the old read-ahead", async () => {
  const audio = await mediaRequest("upos-sz-mirrorali.bilivideo.com", `${AUDIO_PATH}${QUERY}`, "bytes=0-524287");
  assert.equal(audio.status, 206);
  assert.ok(audio.body.equals(fileBytes(0, 512 * 1024 - 1)));
  let status = cache.status();
  assert.ok(status.files.find((item) => item.path === AUDIO_PATH)?.kind === "audio");
  // The video's read-ahead sits after 5 MiB; a seek back to the start must not keep it.
  const seek = await mediaRequest("upos-sz-mirrorali.bilivideo.com", `${VIDEO_PATH}${QUERY}`, "bytes=1048576-1572863");
  assert.equal(seek.status, 206);
  assert.ok(seek.body.equals(fileBytes(MIB, 1.5 * MIB - 1)));
  status = cache.status();
  const file = status.files.find((item) => item.path === VIDEO_PATH);
  assert.ok(file.pieces.every((piece) => piece.start < 5 * MIB + cache.config.readAheadMaxBytes), "nothing far ahead remains");
  assert.ok(file.pieces.every((piece) => piece.end >= MIB - cache.config.keepBehindBytes), "data far behind the new position is released");
});

test("over several requests the download spreads across the mainland nodes", () => {
  // The first segment of a file goes mostly to the node that won the probe, so the start is
  // not held up; later segments are spread by measured speed, with one unmeasured node tried
  // per segment. After the requests above several nodes must have carried data.
  const hosts = [...originSeen.hosts.keys()].filter((host) => host.endsWith(".bilivideo.com"));
  assert.ok(hosts.length >= 3, `nodes used so far: ${hosts.join(", ")}`);
  const mainland = new Set(shared.cdn.MAINLAND_HOSTS);
  assert.ok(hosts.every((host) => mainland.has(host)), "mainland mode uses only the mainland nodes");
});

test("requests the proxy does not accelerate are passed through unchanged", async () => {
  // No Range: the whole file from the origin.
  const whole = await mediaRequest("upos-sz-mirrorali.bilivideo.com", `${VIDEO_PATH}${QUERY}`, null);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers["x-origin"], "1");
  assert.equal(whole.headers["x-btr-proxy"], undefined);
  assert.equal(whole.body.length, FILE_SIZE);
  // A conditional request.
  const conditional = await mediaRequest("upos-sz-mirrorali.bilivideo.com", `${VIDEO_PATH}${QUERY}`, "bytes=0-1023", { headers: { "if-none-match": "\"x\"" } });
  assert.equal(conditional.headers["x-origin"], "1");
  assert.equal(conditional.status, 206);
  // Another path on a CDN host.
  const other = await mediaRequest("upos-sz-mirrorali.bilivideo.com", "/hello", null);
  assert.equal(other.status, 200);
  assert.equal(other.body.toString(), "hello from upos-sz-mirrorali.bilivideo.com");
  // A loop: a request that already went through a proxy like this one.
  const loop = await mediaRequest("upos-sz-mirrorali.bilivideo.com", `${VIDEO_PATH}${QUERY}`, "bytes=0-1023", { headers: { [LOOP_HEADER]: "1" } });
  assert.equal(loop.status, 508);
});

test("a range the origin refuses falls back to the origin's own answer", async () => {
  const beyond = await mediaRequest("upos-sz-mirrorali.bilivideo.com", `${VIDEO_PATH}${QUERY}`, `bytes=${FILE_SIZE + 100}-${FILE_SIZE + 200}`);
  assert.equal(beyond.status, 416, "the client sees what the CDN would have said");
  assert.equal(beyond.headers["content-range"], `bytes */${FILE_SIZE}`);
  assert.ok(proxy.stats.fallbacks >= 1);
});

test("CONNECT to a host that is not a CDN node is a plain tunnel", async () => {
  const { socket, status } = await connectThroughProxy("api.example.test");
  assert.equal(status, 200);
  const secure = await tlsOver(socket, "api.example.test", [originAuthority.certificatePem]);
  assert.equal(secure.authorized, true, "the origin's own certificate arrives untouched");
  assert.equal(secure.getPeerCertificate().subject.CN, "api.example.test");
  const response = await requestOver(secure, { host: "api.example.test", path: "/hello" });
  assert.equal(response.body.toString(), "hello from api.example.test");
  secure.destroy();
});

test("the transparent TLS port reads the server name and terminates or splices", async () => {
  // A CDN name: terminated and accelerated.
  const secure = await new Promise((resolve, reject) => {
    const socket = tls.connect({ port: ports.tls, host: "127.0.0.1", servername: "upos-sz-mirrorcos.bilivideo.com", ca: [proxyAuthority.certificatePem] }, () => resolve(socket));
    socket.once("error", reject);
  });
  assert.equal(secure.authorized, true, secure.authorizationError);
  const response = await requestOver(secure, { host: "upos-sz-mirrorcos.bilivideo.com", path: `${VIDEO_PATH}${QUERY}`, headers: { range: "bytes=4194304-4718591" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers["x-btr-proxy"], "accelerated");
  assert.ok(response.body.equals(fileBytes(4 * MIB, 4.5 * MIB - 1)));
  secure.destroy();
  // Another name: spliced to the real server, whose certificate the client sees.
  const spliced = await new Promise((resolve, reject) => {
    const socket = tls.connect({ port: ports.tls, host: "127.0.0.1", servername: "www.example.test", ca: [originAuthority.certificatePem] }, () => resolve(socket));
    socket.once("error", reject);
  });
  assert.equal(spliced.authorized, true, spliced.authorizationError);
  const hello = await requestOver(spliced, { host: "www.example.test", path: "/hello" });
  assert.equal(hello.body.toString(), "hello from www.example.test");
  spliced.destroy();
  assert.ok(proxy.stats.spliced >= 1);
  // Not TLS at all: closed.
  await new Promise((resolve) => {
    const raw = net.connect(ports.tls, "127.0.0.1", () => raw.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
    raw.once("close", resolve);
    raw.once("error", () => {});
  });
});

test("the plain HTTP port accelerates http:// media requests too", async () => {
  const response = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: ports.http, path: `${VIDEO_PATH}${QUERY}`, headers: { host: "upos-sz-mirrorbd.bilivideo.com", range: "bytes=5242880-5767167" } }, (incoming) => {
      const chunks = [];
      incoming.on("data", (chunk) => chunks.push(chunk));
      incoming.on("end", () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers["x-btr-proxy"], "accelerated");
  assert.ok(response.body.equals(fileBytes(5 * MIB, 5.5 * MIB - 1)));
});

test("a client that disconnects halfway does not break the next request", async () => {
  const { socket, status } = await connectThroughProxy("upos-sz-mirrorali.bilivideo.com");
  assert.equal(status, 200);
  const secure = await tlsOver(socket, "upos-sz-mirrorali.bilivideo.com", [proxyAuthority.certificatePem]);
  secure.write(`GET ${VIDEO_PATH}${QUERY} HTTP/1.1\r\nHost: upos-sz-mirrorali.bilivideo.com\r\nRange: bytes=0-4194303\r\n\r\n`);
  await new Promise((resolve) => secure.once("data", resolve));
  secure.destroy();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const response = await mediaRequest("upos-sz-mirrorali.bilivideo.com", `${VIDEO_PATH}${QUERY}`, "bytes=0-65535");
  assert.equal(response.status, 206);
  assert.ok(response.body.equals(fileBytes(0, 65535)));
});

test("idle files are released", async () => {
  await new Promise((resolve) => setTimeout(resolve, 2600));
  const status = cache.status();
  assert.equal(status.files.length, 0, JSON.stringify(status.files.map((file) => file.path)));
  assert.equal(status.cacheBytes, 0);
});

test("ClientHello peek", () => {
  assert.deepEqual(peekClientHello(Buffer.from("GET / HTTP/1.1\r\n")), { complete: true, tls: false, sni: null });
  assert.deepEqual(peekClientHello(Buffer.from([0x16, 0x03, 0x01])), { complete: false });
  // A real ClientHello, captured from Node's own client.
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.once("data", (chunk) => {
        try {
          const first = peekClientHello(chunk.subarray(0, 40));
          assert.equal(first.complete, false, "a partial record is not enough");
          assert.deepEqual(peekClientHello(chunk), { complete: true, tls: true, sni: "peek.example.test" });
          resolve();
        } catch (error) { reject(error); }
        socket.destroy();
        server.close();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const client = tls.connect({ port: server.address().port, host: "127.0.0.1", servername: "peek.example.test" });
      client.on("error", () => {});
    });
  });
});

test("the built-in DNS answers CDN names itself and forwards the rest", async () => {
  // A fake upstream that answers everything with 203.0.113.9.
  const fake = dgram.createSocket("udp4");
  fake.on("message", (message, remote) => {
    const query = parseQuestion(message);
    const reply = Buffer.concat([message.subarray(0, 12), query.question, Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 203, 0, 113, 9])]);
    reply.writeUInt16BE(0x8180, 2);
    reply.writeUInt16BE(1, 6);
    fake.send(reply, remote.port, remote.address);
  });
  await new Promise((resolve) => fake.bind(0, "127.0.0.1", resolve));
  const dns = createDnsServer({ answerIp: "192.168.1.10", isIntercept: isInterceptHost, upstreams: ["127.0.0.1"], log });
  // The forwarder sends to port 53 of its upstreams; the fake listens elsewhere, so the
  // relay is pointed at it through the module's own socket: resend by patching send.
  const dnsPort = (await dns.listen(0, "127.0.0.1")).port;
  const query = (name, type) => {
    const labels = name.split(".").flatMap((label) => [label.length, ...Buffer.from(label)]);
    const message = Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, ...labels, 0, 0, type, 0, 1]);
    return new Promise((resolve, reject) => {
      const client = dgram.createSocket("udp4");
      const timer = setTimeout(() => { client.close(); reject(new Error("DNS 超时")); }, 2000);
      client.once("message", (reply) => { clearTimeout(timer); client.close(); resolve(reply); });
      client.send(message, dnsPort, "127.0.0.1");
    });
  };
  try {
    const a = await query("upos-sz-mirrorali.bilivideo.com", TYPE_A);
    assert.equal(a.readUInt16BE(0), 0x1234, "same id");
    assert.equal(a.readUInt16BE(6), 1, "one answer");
    assert.deepEqual([...a.subarray(a.length - 4)], [192, 168, 1, 10]);
    const aaaa = await query("upos-sz-mirrorali.bilivideo.com", TYPE_AAAA);
    assert.equal(aaaa.readUInt16BE(6), 0, "no IPv6 address, so the client comes over IPv4");
    assert.equal(aaaa.readUInt16BE(2) & 0x000f, 0, "NOERROR");
    assert.equal(dns.stats.answered, 2);
    // A name that is not a CDN node is forwarded; the fake upstream is on another port, so
    // this one times out (forwarding to 127.0.0.1:53 reaches nothing here).
    assert.equal(dns.stats.forwarded, 0);
    await query("example.com", TYPE_A).then(() => assert.fail("nothing listens on 127.0.0.1:53 in the test"), () => {});
    assert.equal(dns.stats.forwarded, 1);
  } finally {
    dns.close();
    fake.close();
  }
});
