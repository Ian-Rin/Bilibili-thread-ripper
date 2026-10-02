#!/usr/bin/env node
"use strict";
// 线程撕裂者 局域网代理：node proxy/index.js [选项]
//
//   --proxy-port 8080      HTTP 代理端口（CONNECT），0 关闭
//   --tls-port 0           透明代理 / DNS 方式用的 TLS 端口（通常 443）
//   --http-port 0          透明代理 / DNS 方式用的明文 HTTP 端口（通常 80）
//   --dns-port 0           内置 DNS 端口（通常 53）；开启后把路由器的 DNS 指向本机
//   --admin-port 8081      状态页和证书下载
//   --lan-ip auto          本机在局域网里的地址（DNS 回答、状态页链接）
//   --dns-upstream a,b     代理和内置 DNS 自己使用的上游 DNS，默认 223.5.5.5,119.29.29.29
//   --mode mainland        CDN 模式：mainland / overseas / custom
//   --hosts h1,h2          custom 模式使用的服务器
//   --threads 16           并发线程上限：4/8/16/32/64/128
//   --read-ahead 2         没有索引时的预读：请求长度的倍数（0 关闭全部预读）
//   --read-ahead-seconds 20 读到索引后按播放时间预读多少秒
//   --read-ahead-max 64    预读上限（MiB）
//   --live on              直播加速：on / off
//   --cache 512            内存缓存上限（MiB）
//   --bypass-after 3       同一设备连续几次 TLS 握手失败后自动放行（不加速），0 关闭
//   --bypass-minutes 15    放行多久
//   --ca-dir proxy/ca      证书目录
//   --listen 0.0.0.0       监听地址
//   --verbose              打印每个请求
const os = require("node:os");
const path = require("node:path");
const { loadAuthority } = require("./x509.js");
const { loadSharedCore } = require("./shared-core.js");
const { createUpstream } = require("./upstream.js");
const { createMediaCache } = require("./media-cache.js");
const { createLiveCache } = require("./live-cache.js");
const { createProxyServer, isInterceptHost } = require("./server.js");
const { createAdminServer } = require("./admin.js");
const { createDnsServer } = require("./dns.js");

function parseArgs(argv) {
  const options = {
    proxyPort: 8080, tlsPort: 0, httpPort: 0, dnsPort: 0, adminPort: 8081,
    lanIp: "auto", dnsUpstream: "223.5.5.5,119.29.29.29",
    mode: "mainland", hosts: "", threads: 16, readAhead: 2, readAheadSeconds: 20, readAheadMax: 64, cache: 512, bypassAfter: 3, bypassMinutes: 15, live: "on",
    caDir: path.resolve(__dirname, "ca"), listen: "0.0.0.0", verbose: false, help: false
  };
  const names = { "proxy-port": "proxyPort", "tls-port": "tlsPort", "http-port": "httpPort", "dns-port": "dnsPort", "admin-port": "adminPort", "lan-ip": "lanIp", "dns-upstream": "dnsUpstream", mode: "mode", hosts: "hosts", threads: "threads", "read-ahead": "readAhead", "read-ahead-max": "readAheadMax", "read-ahead-seconds": "readAheadSeconds", cache: "cache", "bypass-after": "bypassAfter", "bypass-minutes": "bypassMinutes", live: "live", "ca-dir": "caDir", listen: "listen" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--verbose" || argument === "-v") { options.verbose = true; continue; }
    if (argument === "--help" || argument === "-h") { options.help = true; continue; }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argument);
    if (!match || !names[match[1]]) throw new Error(`不认识的选项：${argument}`);
    const value = match[2] !== undefined ? match[2] : argv[++index];
    if (value === undefined) throw new Error(`选项 ${argument} 需要一个值`);
    const key = names[match[1]];
    options[key] = ["proxyPort", "tlsPort", "httpPort", "dnsPort", "adminPort", "threads", "readAhead", "readAheadSeconds", "readAheadMax", "cache", "bypassAfter", "bypassMinutes"].includes(key) ? Number(value) : value;
  }
  return options;
}

function detectLanIp() {
  const candidates = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const item of addresses || []) {
      if (item.family !== "IPv4" || item.internal) continue;
      // Real LAN addresses first; virtual adapters (docker, VPN) after.
      const score = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address) ? 0 : 1;
      candidates.push({ score, name, address: item.address });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0]?.address || "127.0.0.1";
}

function makeLogger(verbose) {
  return (level, message) => {
    if (level === "debug" && !verbose) return;
    const stamp = new Date().toISOString().slice(11, 19);
    const line = `${stamp} ${{ error: "错误", warn: "注意", info: "    ", debug: "    " }[level] || "    "} ${message}`;
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  };
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  if (options.help) {
    console.log(require("node:fs").readFileSync(__filename, "utf8").split("\n").filter((line) => line.startsWith("//")).slice(1).map((line) => line.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }
  const log = makeLogger(options.verbose);
  const lanIp = options.lanIp === "auto" ? detectLanIp() : options.lanIp;
  const dnsServers = String(options.dnsUpstream || "").split(",").map((item) => item.trim()).filter(Boolean);
  const shared = loadSharedCore();
  const authority = loadAuthority(options.caDir);
  if (authority.created) log("info", `已生成新的证书颁发机构：${authority.subject.split("\n")[0]}（${options.caDir}）`);
  const upstream = createUpstream({ dnsServers });
  const settings = shared.core.normalizeSettings({
    mode: options.mode,
    customHosts: String(options.hosts || "").split(",").map((item) => item.trim()).filter(Boolean),
    concurrency: options.threads,
    autoConcurrency: false
  });
  const cache = createMediaCache({
    shared, upstream, log,
    settings,
    readAhead: options.readAhead > 0,
    readAheadMultiple: options.readAhead,
    readAheadSeconds: options.readAheadSeconds,
    readAheadMaxBytes: options.readAheadMax * 1024 * 1024,
    maxCacheBytes: options.cache * 1024 * 1024
  });
  const liveOn = String(options.live).toLowerCase() !== "off";
  const live = liveOn ? createLiveCache({ shared, upstream, log, getSettings: () => settings }) : null;
  const proxy = createProxyServer({ authority, cache, live, upstream, shared, log, bypassAfter: options.bypassAfter, bypassMs: options.bypassMinutes * 60 * 1000 });
  let dns = null;
  const ports = { proxy: options.proxyPort, tls: options.tlsPort, http: options.httpPort, dns: options.dnsPort, admin: options.adminPort };
  try {
    await proxy.listen({ host: options.listen, proxyPort: options.proxyPort || null, tlsPort: options.tlsPort || null, httpPort: options.httpPort || null });
    if (options.dnsPort) {
      dns = createDnsServer({ answerIp: lanIp, isIntercept: isInterceptHost, upstreams: dnsServers, log });
      await dns.listen(options.dnsPort, options.listen);
    }
    const admin = createAdminServer({
      authority, lanIp, ports,
      status: () => ({ at: new Date().toISOString(), lanIp, ports, cache: cache.status(), live: live ? live.status() : null, proxy: proxy.status(), dns: dns?.stats || null })
    });
    await admin.listen(options.adminPort, options.listen);
  } catch (error) {
    if (error.code === "EACCES") log("error", `端口 ${error.port} 需要管理员权限（Linux 上可用 sudo，或 setcap cap_net_bind_service=+ep $(which node)）`);
    else if (error.code === "EADDRINUSE") log("error", `端口 ${error.port} 已被占用`);
    else log("error", `启动失败：${error.message}`);
    process.exit(1);
  }
  const modeName = settings.mode === "overseas" ? "海外 CDN" : settings.mode === "custom" ? `自定义 ${settings.customHosts.length} 个服务器` : "大陆 CDN";
  console.log("");
  console.log("线程撕裂者 局域网代理 已启动");
  console.log(`  状态页 / 证书下载   http://${lanIp}:${options.adminPort}/`);
  if (options.proxyPort) console.log(`  HTTP 代理           ${lanIp}:${options.proxyPort}`);
  if (options.tlsPort) console.log(`  透明代理 TLS 端口   ${options.tlsPort}`);
  if (options.httpPort) console.log(`  透明代理 HTTP 端口  ${options.httpPort}`);
  if (options.dnsPort) console.log(`  内置 DNS            ${lanIp}:${options.dnsPort}（上游 ${dnsServers.join(", ")}）`);
  console.log(`  下载                ${modeName}，${settings.concurrency} 条线程上限，预读 ${options.readAhead > 0 ? `${options.readAheadSeconds} 秒（没有索引时 ${options.readAhead} 倍请求长度，最多 ${options.readAheadMax} MiB）` : "关闭"}`);
  console.log(`  直播                ${liveOn ? "分片多节点竞速 + 预取" : "关闭，原样转发"}`);
  console.log(`  不信任证书的设备      ${options.bypassAfter > 0 ? `连续 ${options.bypassAfter} 次握手失败后放行 ${options.bypassMinutes} 分钟（不加速）` : "不放行"}`);
  console.log("  每台设备都要先安装状态页上的证书，再把流量指到代理。按 Ctrl+C 退出。");
  console.log("");
  const shutdown = () => {
    log("info", "正在退出");
    cache.close();
    live?.close();
    proxy.close();
    dns?.close();
    upstream.destroy();
    setTimeout(() => process.exit(0), 300).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (require.main === module) main();

module.exports = { parseArgs, detectLanIp };
