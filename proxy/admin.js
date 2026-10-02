"use strict";
// The status page of the proxy: what it is doing, the CA certificate to install on the
// devices, and the instructions for each deployment. Plain HTTP, meant for the LAN.
const http = require("node:http");

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[char]));
}

function page(context) {
  const { authority, lanIp, ports } = context;
  const base = `http://${lanIp}:${ports.admin}`;
  const proxyLine = ports.proxy ? `<code>${lanIp}:${ports.proxy}</code>` : "<em>未开启</em>";
  const tlsLine = ports.tls ? `<code>${ports.tls}</code>` : "<em>未开启</em>";
  const dnsLine = ports.dns ? `<code>${lanIp}</code>（端口 ${ports.dns}）` : "<em>未开启</em>";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>线程撕裂者 局域网代理</title>
<style>
:root{color-scheme:light dark;--fg:#1f2328;--bg:#fff;--muted:#59636e;--line:#d1d9e0;--accent:#fb7299;--ok:#1a7f37;--bad:#cf222e}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--muted:#9198a1;--line:#30363d}}
body{margin:0;padding:16px;font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--fg);background:var(--bg);max-width:960px;margin-inline:auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}
.muted{color:var(--muted)}code{background:rgba(127,127,127,.15);padding:1px 5px;border-radius:4px}
.btn{display:inline-block;padding:8px 14px;border-radius:6px;background:var(--accent);color:#fff;text-decoration:none;margin:4px 8px 4px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.tile{border:1px solid var(--line);border-radius:8px;padding:10px}.tile b{display:block;font-size:20px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left}
.ok{color:var(--ok)}.bad{color:var(--bad)}details{margin:8px 0}summary{cursor:pointer}
ol li,ul li{margin:4px 0}
</style></head><body>
<h1>Bilibili 线程撕裂者 · 局域网代理</h1>
<div class="muted">同一局域网内的设备把 B 站视频流量交给这台机器，由它多线程、多 CDN 并发下载。</div>

<h2>1. 安装证书（每台设备一次）</h2>
<p>代理要替 B 站视频服务器“接电话”，设备必须信任它的证书，否则浏览器会报不安全。证书只对本局域网代理有效，私钥只在这台机器上。</p>
<a class="btn" href="${base}/ca.crt">下载证书（.crt，PEM）</a>
<a class="btn" href="${base}/ca.cer">下载证书（.cer，DER）</a>
<div class="muted">证书：${escapeHtml(authority.subject.split("\n")[0])}，SHA-256 指纹 <code>${escapeHtml(authority.fingerprint256)}</code>，有效期至 ${escapeHtml(authority.validTo)}</div>
<details><summary>Windows</summary><ol><li>下载 .crt，双击 → 安装证书 → 本地计算机（或当前用户）→ “将所有的证书都放入下列存储” → 受信任的根证书颁发机构。</li><li>Firefox 另有自己的证书库：设置 → 隐私与安全 → 查看证书 → 证书颁发机构 → 导入，勾选“信任由此证书颁发机构来标识网站”。</li></ol></details>
<details><summary>macOS</summary><ol><li>下载 .crt，双击导入“钥匙串访问”的登录钥匙串。</li><li>双击证书 → 信任 → “使用此证书时” 选 始终信任。</li></ol></details>
<details><summary>iOS / iPadOS</summary><ol><li>用 Safari 打开 <code>${base}/ca.crt</code>，允许下载描述文件。</li><li>设置 → 已下载描述文件 → 安装。</li><li>设置 → 通用 → 关于本机 → 证书信任设置 → 打开对该证书的完全信任。</li></ol></details>
<details><summary>Android</summary><ol><li>下载 .crt，设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书。</li><li>注意：Android 7 以上的 App 默认<b>不信任</b>用户安装的 CA，B 站官方 App 的视频流量不会经过这里加速；手机浏览器可以。</li></ol></details>

<h2>2. 把设备的流量指到代理</h2>
<ul>
<li><b>HTTP 代理</b>（最省事，浏览器、Windows/macOS 系统代理都可）：代理地址 ${proxyLine}。</li>
<li><b>DNS 方式</b>（路由器 DHCP 的 DNS 改成本机，全家设备自动生效）：把 DNS 设为 ${dnsLine}。本机只对 B 站视频域名“指路”，其他域名照常转发。</li>
<li><b>透明代理</b>（本机就是网关/旁路由）：用 iptables 把目标端口 443 的 TCP 重定向到本机 TLS 端口 ${tlsLine}，见 proxy/README.md。</li>
</ul>

<h2>3. 当前状态</h2>
<div class="grid" id="tiles"></div>
<h2>CDN 节点</h2>
<table><thead><tr><th>节点</th><th>状态</th><th>速度</th></tr></thead><tbody id="nodes"></tbody></table>
<h2>正在下载的文件</h2>
<table><thead><tr><th>文件</th><th>类型</th><th>大小</th><th>索引</th><th>播放位置（估）</th><th>请求数</th><th>缓存片段</th></tr></thead><tbody id="files"></tbody></table>
<h2>直播</h2>
<table><thead><tr><th>直播流</th><th>已缓存分片</th><th>最新分片号</th><th>节点</th></tr></thead><tbody id="streams"></tbody></table>
<h2>不信任证书的设备</h2>
<p class="muted">这些设备连接 B 站视频服务器时 TLS 握手失败，多半是没装证书（安卓 App 不认用户证书）。连续失败几次后代理会自动放行它们一段时间：能看，但不加速。在设备上装好证书后等放行到期即可。</p>
<table><thead><tr><th>设备</th><th>状态</th><th>失败次数</th><th>最近错误</th></tr></thead><tbody id="untrusted"></tbody></table>
<p class="muted">这个页面每秒刷新一次状态；数据也可以从 <a href="${base}/stats.json">/stats.json</a> 读取。</p>
<script>
const fmt=(n)=>{n=Number(n)||0;if(n>=1073741824)return (n/1073741824).toFixed(2)+" GiB";if(n>=1048576)return (n/1048576).toFixed(1)+" MiB";if(n>=1024)return (n/1024).toFixed(0)+" KiB";return n+" B"};
const esc=(s)=>String(s).replace(/[&<>"]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
async function tick(){
  try{
    const s=await (await fetch("/stats.json",{cache:"no-store"})).json();
    const c=s.cache, p=s.proxy;
    document.getElementById("tiles").innerHTML=[
      ["当前线程",c.activeThreads],["总速度",fmt(c.totalSpeedBps)+"/s"],["加速请求",p.accelerated],["预读命中",c.aheadHits],
      ["已加速数据",fmt(c.servedBytes)],["内存缓存",fmt(c.cacheBytes)],["直接转发",p.passthrough],["交回原连接",p.fallbacks],
      ["TLS 接管连接",p.tlsIntercepted],["普通隧道",p.tunnels+p.spliced],["放行的连接",p.bypassed],["CDN 模式",c.settings.mode==="overseas"?"海外":c.settings.mode==="custom"?"自定义":"大陆"],["线程上限",c.settings.concurrency],
      ["直播分片",s.live?s.live.segments:"关"],["直播预取命中",s.live?s.live.segmentHits:"关"]
    ].map(([k,v])=>'<div class="tile"><span class="muted">'+k+'</span><b>'+esc(v)+'</b></div>').join("");
    document.getElementById("nodes").innerHTML=(c.nodes||[]).map((n)=>'<tr><td>'+esc(n.host)+'</td><td class="'+(n.state==="healthy"?"ok":n.state==="untested"?"muted":"bad")+'">'+esc({healthy:"正常",untested:"未测",blocked:"暂停",banned:"停用"}[n.state]||n.state)+'</td><td>'+(n.bps?fmt(n.bps)+"/s":"")+'</td></tr>').join("")||'<tr><td colspan=3 class="muted">还没有下载</td></tr>';
    document.getElementById("files").innerHTML=(c.files||[]).map((f)=>'<tr><td><code>'+esc(f.path.split("/").pop())+'</code></td><td>'+(f.kind==="audio"?"声音":"画面")+'</td><td>'+(f.total?fmt(f.total):"")+'</td><td>'+(f.segments?f.segments+" 段":'<span class="muted">无</span>')+'</td><td>'+(f.playhead==null?'<span class="muted">未知</span>':f.playhead.toFixed(1)+" s"+(f.requestedAhead!=null?'，已请求到 +'+f.requestedAhead.toFixed(0)+' s':""))+'</td><td>'+f.requests+'</td><td>'+f.pieces.length+'（'+fmt(f.pieces.reduce((a,b)=>a+b.received,0))+'）</td></tr>').join("")||'<tr><td colspan=7 class="muted">没有正在播放的视频</td></tr>';
    const l=s.live; document.getElementById("streams").innerHTML=l?((l.streams||[]).map((st)=>'<tr><td><code>'+esc(st.key)+'</code></td><td>'+st.cached+'</td><td>'+st.lastNum+'</td><td>'+st.hosts.map((h)=>'<span class="'+(h.state==="healthy"?"ok":h.state==="untested"?"muted":"bad")+'">'+esc(h.host.split(".")[0])+'</span>').join(" · ")+'</td></tr>').join("")||'<tr><td colspan=4 class="muted">没有正在看的直播</td></tr>'):'<tr><td colspan=4 class="muted">直播加速已关闭</td></tr>';
    document.getElementById("untrusted").innerHTML=(p.untrusted||[]).map((u)=>'<tr><td><code>'+esc(u.ip)+'</code></td><td class="'+(u.bypassed?"bad":"muted")+'">'+(u.bypassed?"已放行，还剩 "+Math.ceil(u.bypassForMs/60000)+" 分钟":"握手失败中")+'</td><td>'+u.failures+'</td><td class="muted">'+esc(u.lastError||"")+'</td></tr>').join("")||'<tr><td colspan=4 class="muted">没有</td></tr>';
  }catch(e){}
}
tick();setInterval(tick,1000);
</script>
</body></html>`;
}

function createAdminServer(context) {
  const { authority, status } = context;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname === "/ca.crt" || url.pathname === "/ca.pem") {
      response.writeHead(200, { "Content-Type": "application/x-x509-ca-cert", "Content-Disposition": "attachment; filename=\"btr-lan-proxy-ca.crt\"", "Cache-Control": "no-store" });
      return response.end(authority.certificatePem);
    }
    if (url.pathname === "/ca.cer" || url.pathname === "/ca.der") {
      response.writeHead(200, { "Content-Type": "application/x-x509-ca-cert", "Content-Disposition": "attachment; filename=\"btr-lan-proxy-ca.cer\"", "Cache-Control": "no-store" });
      return response.end(authority.certificateDer);
    }
    if (url.pathname === "/stats.json") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
      return response.end(JSON.stringify(status()));
    }
    if (url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return response.end(page(context));
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("没有这个页面");
  });
  return Object.freeze({
    listen(port, host = "0.0.0.0") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve(server.address());
        });
      });
    },
    close() { server.close(); server.closeAllConnections?.(); }
  });
}

module.exports = { createAdminServer, page };
