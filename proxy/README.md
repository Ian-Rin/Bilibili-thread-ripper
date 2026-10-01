# 局域网代理（实验性）

把线程撕裂者的多线程、多 CDN 下载内核搬到局域网里的一台机器上（旁路由、NAS、树莓派、一台常开的电脑），让同一网络里的设备不装脚本也能加速 B 站视频。

## 先说结论

| 问题 | 结论 |
| --- | --- |
| 能不能“在局域网里直接扫描 B 站流量”来加速？ | **被动扫描不行**。视频数据走 HTTPS，网关看得到的只有目标 IP、SNI 域名和流量大小，看不到也改不了里面的 Range 请求。要加速必须让设备把 TLS 连接交给代理（代理用自己的 CA 给 `*.bilivideo.com` 签证书），这就要求**每台设备安装一次代理的根证书**。 |
| 能自动生效吗？ | 装好证书以后可以：路由器把 DNS 指到这台机器（或者这台机器就是网关做透明代理），设备什么都不用设。只是证书这一步绕不开。 |
| 能加速哪些设备？ | 电脑和手机上的**浏览器**（Chrome、Edge、Firefox、Safari）可以。**B 站安卓 App 不行**：Android 7 起 App 默认不信任用户安装的 CA，除非 root 后把证书装进系统目录。iOS App、电视盒子 App 要实测，可能有证书绑定。 |
| 效果和油猴脚本比？ | 下载内核相同（同一份 `range-core / cdn-resolver / idm-downloader`），多了预读（提前下好下一段）。少了脚本里“离播放还有多久”的截止时间信息和缓冲区感知，所以线程调度不如全接管模式精细，更接近兼容模式。 |

下面是原理、部署方式、限制和开发说明。

## 为什么被动扫描做不到

B 站播放器下载视频的方式是：从 `playurl` 接口拿到一组**带签名的下载地址**（`https://upos-sz-mirrorxxx.bilivideo.com/upgcxcode/.../xxx-30080.m4s?deadline=...&upsig=...`），然后按 `sidx` 索引一段一段地发 `Range: bytes=a-b` 请求。油猴脚本能加速，是因为它在页面里拦下了这些 Range 请求，把 `[a, b]` 再切成很多小块，换着 8 个大陆节点的域名并发下载，再按顺序拼回去交给播放器。

网关上的程序要做同样的事，必须看见两样东西：**完整的签名地址**和**Range 头**。这两样都在 TLS 加密层里面。网关上只能看到：

- DNS 查询（设备在找 `upos-sz-mirrorali.bilivideo.com` 的 IP）；
- TLS ClientHello 里的 SNI（明文的域名）；
- 每条连接的流量大小和时序。

所以单纯“扫描”只能做到换节点（把 `*.bilivideo.com` 解析到你选的 IP），那是 CDN 优选插件的水平，还是一条连接，冷门视频照样卡。README 里说的多线程调度，前提是能改请求。

能改请求的唯一办法是**TLS 终结（中间人）**：代理用自己的 CA 现场签一张 `upos-sz-mirrorali.bilivideo.com` 的证书给设备，设备信任这个 CA 才会握手成功。这也是 Loon、Quantumult X、Clash 的“MITM / 脚本重写”功能的原理。README 常见问题里说手机端“通过 Loon / 圈 X / Clash 去改写优化效果有限”，原因就是它们只能改写单条请求，没有多线程下载器和预读；这个目录里的代理补上的正是这一块。

## 代理做了什么

```text
局域网设备（浏览器 / App）
    │  https://upos-xx.bilivideo.com/...m4s   Range: bytes=a-b
    ▼
BTR 局域网代理（这台机器）
    ├─ 用自己的 CA 签的证书接下 TLS
    ├─ 看是不是 B 站媒体文件的 Range 请求
    │     是：交给下载内核
    │         ├─ 切成子块，8 个大陆节点并发（同一份内核：测速、备份副本、断点续传、停用坏节点）
    │         ├─ 按顺序边下边写回给设备（206 Partial Content）
    │         └─ 顺手把后面的 N 段预读到内存，下一个请求直接命中
    │     不是：原样转发到原来的服务器
    └─ 不是 B 站视频域名的连接：原样隧道，碰都不碰
```

- `proxy/shared-core.js` 直接加载 `src/` 里的三个内核文件，没有复制一份；仓库里改了内核，代理跟着变。
- `proxy/media-cache.js` 是脚本“兼容模式”的服务器端翻版：每个文件一组“片段”，请求用已有片段覆盖、缺口新开下载、下一段提前下载；拖动进度条时丢掉旧位置的预读；文件 90 秒没人要就释放。
- `proxy/server.js` 提供三种入口（见下），`proxy/x509.js` 不依赖任何库生成 CA 和证书（RSA 2048、SHA-256，带 SAN，满足 iOS / Android / Chrome 对本地根证书的要求），`proxy/dns.js` 是一个很小的 DNS 服务器，只对 B 站视频域名“指路”。
- 直播（`live.bilibili.com` 的 fMP4 分片）目前原样转发，没有加速；可以之后把 `live-core.js` 的节点池搬过来。

## 运行

需要 Node.js 18 以上（和项目一样没有任何依赖）：

```bash
node proxy/index.js                 # 默认：HTTP 代理 8080，状态页 8081
node proxy/index.js --help          # 所有选项
```

启动后打开状态页 `http://<这台机器的局域网 IP>:8081/`：下载证书、看各平台安装步骤、看实时线程和节点状态。

常用选项：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `--proxy-port` | 8080 | HTTP 代理端口（CONNECT），0 关闭 |
| `--tls-port` / `--http-port` | 0 / 0 | DNS 方式和透明代理用的 443 / 80 |
| `--dns-port` | 0 | 内置 DNS，通常 53；配合 `--lan-ip` |
| `--dns-upstream` | `223.5.5.5,119.29.29.29` | 代理自己和内置 DNS 使用的上游 DNS。**DNS 方式必须设对**，否则代理会把 CDN 域名解析到自己（会检测并返回 508） |
| `--mode` / `--hosts` | `mainland` | 和脚本一样：`mainland` / `overseas` / `custom` |
| `--threads` | 16 | 并发上限 4/8/16/32/64/128（没有自动模式：代理看不到播放器卡不卡） |
| `--read-ahead` / `--read-ahead-max` | 2 / 32 | 预读请求长度的几倍，最多多少 MiB；0 关闭预读 |
| `--cache` | 512 | 内存缓存上限（MiB） |
| `--ca-dir` | `proxy/ca` | CA 私钥和证书的目录（已在 `.gitignore` 里） |

## 三种部署方式

### A. HTTP 代理（最省事）

设备的代理设置填 `<机器 IP>:8080`（系统代理、浏览器代理、或 PAC）。只对 `*.bilivideo.com:443` 这类视频域名做 TLS 终结，其他 CONNECT 原样隧道，所以可以放心把全部流量指过来。浏览器通过 HTTP 代理时不会用 QUIC，这是三种方式里最稳的。

### B. DNS 方式（全家自动生效）

```bash
sudo node proxy/index.js --dns-port 53 --tls-port 443 --http-port 80 --lan-ip 192.168.1.10 --dns-upstream 223.5.5.5
```

然后把路由器 DHCP 下发的 DNS 改成 `192.168.1.10`。内置 DNS 对 `*.bilivideo.com`、`*.akamaized.net` 等视频域名回答这台机器的 IP，对 AAAA 和 HTTPS 类型回答空（防止设备走 IPv6 或 HTTP/3 绕过去），其他域名原样转发到上游。设备连到 443 时 SNI 还是原来的域名，代理据此签证书和转发。

注意：开了“安全 DNS / Private DNS / DoH”的设备不会问路由器的 DNS，这种方式对它们无效；关掉或者改用方式 A / C。

### C. 透明代理（这台机器是网关或旁路由）

```bash
sudo node proxy/index.js --tls-port 8443 --http-port 8080 --proxy-port 0
# 只把去往 B 站视频节点的 443 流量重定向过来（建议用 ipset 维护目标 IP 集合，或者偷懒重定向全部 443）：
sudo iptables -t nat -A PREROUTING -i br-lan -p tcp --dport 443 -j REDIRECT --to-ports 8443
sudo iptables -t nat -A PREROUTING -i br-lan -p tcp --dport 80  -j REDIRECT --to-ports 8080
# 阻止 QUIC 绕过（可选）：
sudo iptables -A FORWARD -i br-lan -p udp --dport 443 -j REJECT
```

透明 TLS 端口会读 ClientHello 里的 SNI：是视频域名就自己接；不是就原样接到真正的服务器（按 SNI 域名解析），没有 SNI 的连接会被关掉。重定向全部 443 时，这台机器要扛得住全部 HTTPS 流量的转发。

## 安装证书

状态页首页有每个平台的步骤和下载链接（`/ca.crt` PEM、`/ca.cer` DER）。要点：

- **Windows**：导入到“受信任的根证书颁发机构”；Firefox 要在自己的证书管理里再导一次。
- **macOS**：导入钥匙串后把信任改成“始终信任”。
- **iOS / iPadOS**：Safari 下载 → 设置里安装描述文件 → 通用 → 关于本机 → 证书信任设置 → 打开完全信任。
- **Android**：安全 → 加密与凭据 → 安装 CA 证书。只对浏览器有效，App 不认。

私钥在 `--ca-dir` 目录里，不要把这个目录发给别人，也不要把代理暴露到公网：持有这个 CA 的人可以对信任它的设备伪造任何网站。代理只对 B 站视频域名签证书，但 CA 本身对所有域名都有效。

## 哪些设备能用、哪些不能

| 设备 | 能否加速 | 说明 |
| --- | --- | --- |
| Windows / macOS / Linux 浏览器 | 能 | 装证书 + 代理或 DNS |
| 手机浏览器（Safari、Chrome） | 能 | 同上 |
| B 站 Android App | **不能** | Android 7+ 不信任用户 CA；root 后装到系统 CA 目录可以绕过，自行承担风险 |
| B 站 iOS App | 待实测 | iOS 允许用户信任的根证书，除非 App 做了证书绑定 |
| 电视盒子 / 智能电视 App | 基本不能 | 一般没有安装用户 CA 的入口 |
| 使用 http:// 地址下载视频的客户端 | 能，且不用证书 | 明文 80 端口的 Range 请求同样加速 |

## 已知限制

- **直播不加速**：live.bilibili.com 的分片原样转发。
- **没有播放截止时间**：脚本的全接管模式知道每一段离播放还有几秒，据此决定什么时候开备份副本；代理只知道请求顺序，调度退回到兼容模式的策略，另加预读补偿。
- **签名过期由播放器负责**：地址的 `deadline` 过了，B 站播放器自己会重新请求 `playurl`，代理只会用它给的新地址（同一文件的测速结果会保留）。
- **HTTP/3**：DNS 方式对 HTTPS 类型查询回答空，转发的响应里去掉了 `Alt-Svc`，但如果设备已经缓存了 QUIC 可用的信息，第一次可能绕过代理；透明代理建议顺手拦掉 UDP 443。
- **性能**：Node 单线程做 TLS 加解密和拼接，还没有实测数字；x86 小主机应该没问题，ARM 小板子多路 4K 时可能是瓶颈。
- **不替代油猴脚本**：电脑浏览器上直接装脚本效果更好（全接管模式）；代理的价值是覆盖装不了脚本的设备。**装了脚本的浏览器不要再走这个代理**：脚本发出的子块请求也是 B 站视频域名的 Range 请求，代理会再切一次、再预读一次，白费连接。那台电脑不设代理即可（DNS 方式下可以给它单独指定公共 DNS）。

## 开发

```bash
node dev/x509-test.js        # 证书：DER 编码、签发、TLS 握手
node dev/lan-proxy-test.js   # 代理端到端：本机假 CDN，CONNECT / 透明 TLS / 明文 HTTP / 预读 / 回退 / DNS
npm test                     # 上面两项已加入 dev/run-tests.js
```

文件：

```text
proxy/index.js        命令行入口、参数、启动横幅
proxy/server.js       HTTP 代理（CONNECT）、透明 TLS 端口（SNI 探测）、明文 HTTP 端口、请求分流、原样转发
proxy/media-cache.js  文件片段缓存、按请求覆盖、预读、拖动时的清理、释放
proxy/upstream.js     出站：Range 子请求（给内核用的 fetch）、原样转发、隧道；自己的上游 DNS
proxy/shared-core.js  加载 src/ 里的内核
proxy/x509.js         CA 和服务器证书
proxy/dns.js          内置 DNS
proxy/admin.js        状态页、证书下载、/stats.json
```

后续可以做的事（按价值排序）：

1. 直播：把 `live-core.js` 的节点池和分片预取搬到代理里。
2. 用请求间隔推算播放速度，给内核一个近似的截止时间，让备份副本的时机更接近全接管模式。
3. 解析 `sidx`，按真实分段边界预读，而不是按上一个请求的长度。
4. 状态页上改设置（CDN 模式、线程数）而不是只能重启。
