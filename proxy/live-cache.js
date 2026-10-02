"use strict";
// Live streams, the proxy's version of the userscript's live module (live-hook.js). The web
// player and the apps play live.bilibili.com rooms as fMP4 HLS: a playlist refreshed every
// second and one-second segments, each fetched whole. What the module does in the page is
// done here for every client on the LAN:
//   - a playlist request is answered from the real server and read on the way through, so
//     the segments it announces are downloaded before the player asks for them, plus one
//     speculative segment past the end (its 404 only means it is not born yet);
//   - a segment request is answered from that cache, or downloaded at once; every download
//     races the best known nodes, with a second copy when the first is slow, and a node that
//     twice sends nothing is banned for the stream;
//   - addresses of P2P relays and commercial relays are turned back into the official node.
// What cannot be done from a proxy is the page's part: the WebRTC P2P SDK runs inside the
// browser and its traffic never comes this way.
//
// The logic layer (playlist parsing, node pool, URL classification) is src/live-core.js,
// loaded by shared-core.js; nothing of it is copied here.

function createLiveCache(options) {
  const { shared, upstream } = options;
  const { core: rangeCore, live: core } = shared;
  const log = typeof options.log === "function" ? options.log : () => {};
  const getSettings = typeof options.getSettings === "function" ? options.getSettings : () => rangeCore.normalizeSettings({});
  const config = {
    hedgeMs: Number(options.hedgeMs) > 0 ? Number(options.hedgeMs) : 400,
    // A segment the player is waiting for hedges sooner: pieces are one second long and its
    // own buffer is shallow.
    urgentHedgeMs: Number(options.urgentHedgeMs) > 0 ? Number(options.urgentHedgeMs) : 150,
    firstByteTimeoutMs: Number(options.firstByteTimeoutMs) > 0 ? Number(options.firstByteTimeoutMs) : 2500,
    segmentTimeoutMs: Number(options.segmentTimeoutMs) > 0 ? Number(options.segmentTimeoutMs) : 8000,
    cacheLimit: Math.max(4, Math.trunc(Number(options.cacheLimit)) || 32),
    cacheTtlMs: Number(options.cacheTtlMs) > 0 ? Number(options.cacheTtlMs) : 45000,
    // A stream nobody asked a playlist of for this long is forgotten.
    streamIdleMs: Number(options.streamIdleMs) > 0 ? Number(options.streamIdleMs) : 60000,
    sweepMs: Number(options.sweepMs) > 0 ? Number(options.sweepMs) : 5000
  };
  const stats = { playlists: 0, segments: 0, segmentHits: 0, segmentBytes: 0, prefetched: 0, failures: 0, rewritten: 0, activeTransfers: 0 };
  // One context per stream, keyed by the playlist's directory: several viewers on the LAN
  // may watch different rooms.
  const streams = new Map();
  let activeTransfers = 0;

  const swapHost = (url, host) => { const u = new URL(url); u.hostname = host; u.port = ""; return u.href; };
  const directoryOf = (url) => { try { const u = new URL(url); return u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1); } catch (_error) { return ""; } };
  const hostOf = (url) => { try { return new URL(url).hostname; } catch (_error) { return ""; } };
  // Segments are cached by path: the signature sits on the playlist address, and a player
  // may ask for a segment with or without the playlist's query, from any node.
  const keyOf = (url) => { try { return new URL(url).pathname; } catch (_error) { return String(url); } };

  function dropStream(ctx, reason) {
    ctx.prefetchQueue.length = 0;
    ctx.abort.abort(new DOMException(reason || "直播已结束", "AbortError"));
    streams.delete(ctx.key);
  }

  function streamFor(url, clientHeaders) {
    const key = directoryOf(url);
    let ctx = streams.get(key);
    if (ctx) {
      ctx.lastSeenAt = Date.now();
      return ctx;
    }
    const pool = core.createHostPool({
      onBan(host) { log("warn", `停用直播节点 ${host}：两次没有返回数据（${key}）`); }
    });
    const origin = hostOf(url);
    // The node Bilibili handed out is trusted unless it is a P2P relay. In the custom CDN
    // mode only the servers the viewer picked join it; otherwise the known fMP4 group does.
    if (origin && !core.isP2pUrl(url)) pool.add(origin, true);
    const settings = getSettings();
    const extra = settings.mode === "custom" ? settings.customHosts : core.KNOWN_FMP4_HOSTS;
    for (const host of extra) if (host !== origin) pool.add(host, false);
    ctx = {
      key, playlistUrl: url, pool, cache: new Map(), lastNum: 0, mapKey: "", probing: false, speculativeMisses: 0,
      prefetchQueue: [], inflightPrefetch: 0, urgentInflight: 0, abort: new AbortController(), lastSeenAt: Date.now(),
      clientHeaders: {}
    };
    const ua = clientHeaders?.["user-agent"];
    if (ua) ctx.clientHeaders["user-agent"] = String(ua);
    const referer = clientHeaders?.referer;
    if (referer && /^https:\/\/[^/]*bilibili\.com\//i.test(String(referer))) ctx.clientHeaders.referer = String(referer);
    streams.set(key, ctx);
    log("info", `接管直播流 ${key}`);
    return ctx;
  }

  // Candidate nodes must prove they serve this stream before ranking uses them: the
  // signature is shared within the fMP4 node group, but a node may still lack the stream.
  function probeCandidates(ctx, sampleUrl) {
    if (ctx.probing) return;
    const unproven = ctx.pool.unproven();
    if (!unproven.length) return;
    ctx.probing = true;
    Promise.allSettled(unproven.map(async (host) => {
      const startedAt = performance.now();
      const probe = new AbortController();
      const probeTimer = setTimeout(() => probe.abort(new DOMException("直播节点探测超时", "TimeoutError")), 4000);
      const dropProbe = () => probe.abort(ctx.abort.signal.reason);
      ctx.abort.signal.addEventListener("abort", dropProbe, { once: true });
      try {
        const response = await upstream.fetch(swapHost(sampleUrl, host), { headers: { ...ctx.clientHeaders, Range: "bytes=0-2047" }, signal: probe.signal });
        const body = new Uint8Array(await response.arrayBuffer());
        if ((response.status === 206 || response.status === 200) && body.byteLength > 0) ctx.pool.success(host, performance.now() - startedAt, 0);
        else ctx.pool.failure(host, body.byteLength);
      } catch (_error) {
        ctx.pool.failure(host, 0);
      } finally {
        clearTimeout(probeTimer);
        ctx.abort.signal.removeEventListener("abort", dropProbe);
      }
    })).then(() => { ctx.probing = false; });
  }

  async function attemptSegment(ctx, url, host, signal) {
    const startedAt = performance.now();
    activeTransfers += 1;
    let received = 0;
    try {
      const response = await upstream.fetch(swapHost(url, host), { headers: ctx.clientHeaders, signal });
      if (response.status !== 200 && response.status !== 206) {
        throw Object.assign(new Error(`直播分片响应异常：HTTP ${response.status}`), { status: response.status });
      }
      // Nothing here asks for a range, so a 206 is only acceptable when it covers the file.
      const contentRange = rangeCore.parseContentRange(response.headers.get("content-range"));
      if (response.status === 206 && (!contentRange || contentRange.start !== 0 || contentRange.total === null || contentRange.end !== contentRange.total - 1)) {
        throw new Error("直播分片只返回了一部分");
      }
      const reader = response.body?.getReader?.();
      const chunks = [];
      let firstByteMs = 0;
      if (reader) {
        const firstByteTimer = setTimeout(() => reader.cancel(new DOMException("直播分片首字节超时", "TimeoutError")).catch(() => {}), config.firstByteTimeoutMs);
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!firstByteMs) {
              firstByteMs = performance.now() - startedAt;
              clearTimeout(firstByteTimer);
            }
            chunks.push(value);
            received += value.byteLength;
          }
        } finally {
          clearTimeout(firstByteTimer);
        }
      } else {
        const body = new Uint8Array(await response.arrayBuffer());
        firstByteMs = performance.now() - startedAt;
        chunks.push(body);
        received = body.byteLength;
      }
      if (signal?.aborted) throw new DOMException("已取消", "AbortError");
      if (received <= 0) throw new Error("直播分片为空");
      const declared = response.status === 206 ? contentRange.total : Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > 0 && received !== declared) throw new Error(`直播分片长度不对：收到 ${received}，应为 ${declared}`);
      const bytes = rangeCore.concatChunks(chunks, received);
      const elapsed = Math.max(1, performance.now() - startedAt);
      ctx.pool.success(host, firstByteMs || elapsed, received * 1000 / elapsed);
      return { bytes, contentType: response.headers.get("content-type") || "video/iso.segment", host };
    } catch (error) {
      if (error?.name !== "AbortError" && Number(error?.status) !== 404) ctx.pool.failure(host, received);
      throw error;
    } finally {
      activeTransfers -= 1;
    }
  }

  // One segment: the best node first, a hedge copy on the second-best when the first is
  // slow to produce bytes. 404 means "not born yet" for a speculative fetch and is not a
  // node failure.
  async function downloadSegment(ctx, url, { speculative = false, urgent = false } = {}) {
    const hosts = ctx.pool.pick(2);
    if (!hosts.length) throw new Error("没有可用直播节点");
    const controllers = hosts.map(() => new AbortController());
    const dropped = () => controllers.forEach((controller) => { if (!controller.signal.aborted) controller.abort(ctx.abort.signal.reason); });
    if (ctx.abort.signal.aborted) dropped();
    else ctx.abort.signal.addEventListener("abort", dropped, { once: true });
    const overall = setTimeout(() => controllers.forEach((controller) => controller.abort(new DOMException("直播分片总超时", "TimeoutError"))), config.segmentTimeoutMs);
    let primaryFailed = () => {};
    const primaryFailure = new Promise((resolve) => { primaryFailed = resolve; });
    try {
      const attempts = hosts.map((host, index) => (async () => {
        if (index) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, speculative ? config.hedgeMs * 3 : urgent ? config.urgentHedgeMs : config.hedgeMs);
            primaryFailure.then(() => { clearTimeout(timer); resolve(); });
          });
          if (controllers[index].signal.aborted) throw new DOMException("已取消", "AbortError");
        }
        try {
          return await attemptSegment(ctx, url, host, controllers[index].signal);
        } catch (error) {
          if (!index) primaryFailed();
          throw error;
        }
      })());
      const winner = await Promise.any(attempts);
      controllers.forEach((controller) => { if (!controller.signal.aborted) controller.abort(new DOMException("并发副本已取消", "AbortError")); });
      return winner;
    } catch (aggregate) {
      throw aggregate?.errors?.at?.(-1) || aggregate;
    } finally {
      clearTimeout(overall);
      ctx.abort.signal.removeEventListener("abort", dropped);
    }
  }

  function pruneCache(ctx) {
    const at = Date.now();
    for (const [key, item] of ctx.cache) {
      if (key === ctx.mapKey) continue;
      if (at - item.at > config.cacheTtlMs) ctx.cache.delete(key);
    }
    while (ctx.cache.size > config.cacheLimit) {
      const oldest = [...ctx.cache.keys()].find((key) => key !== ctx.mapKey);
      if (!oldest) break;
      ctx.cache.delete(oldest);
    }
  }

  function cacheSegment(ctx, url, segmentOptions = {}) {
    const key = keyOf(url);
    let item = ctx.cache.get(key);
    if (item) return item;
    item = { url, at: Date.now(), hit: false, done: false, promise: downloadSegment(ctx, url, segmentOptions) };
    item.promise.then(() => {
      item.done = true;
      if (!segmentOptions.urgent) stats.prefetched += 1;
    }, () => { if (ctx.cache.get(key) === item) ctx.cache.delete(key); });
    ctx.cache.set(key, item);
    pruneCache(ctx);
    return item;
  }

  // Prefetch runs through a small queue instead of all at once: the first playlist would
  // otherwise burst eight segments that compete for bandwidth with the very segment the
  // player is waiting for. While a player waits for a segment (urgent), the queue nearly stops.
  function pumpPrefetch(ctx) {
    while (ctx.inflightPrefetch < (ctx.urgentInflight > 0 ? 1 : 3) && ctx.prefetchQueue.length) {
      const next = ctx.prefetchQueue.shift();
      if (ctx.cache.has(keyOf(next.url))) continue;
      ctx.inflightPrefetch += 1;
      const item = cacheSegment(ctx, next.url, next.options);
      const done = (ok) => {
        try { next.options.onSettled?.(ok); } catch (_error) {}
        ctx.inflightPrefetch = Math.max(0, ctx.inflightPrefetch - 1);
        pumpPrefetch(ctx);
      };
      item.promise.then(() => done(true), () => done(false));
    }
  }

  function enqueuePrefetch(ctx, url, segmentOptions = {}) {
    if (ctx.cache.has(keyOf(url)) || ctx.prefetchQueue.some((entry) => keyOf(entry.url) === keyOf(url))) return;
    ctx.prefetchQueue.push({ url, options: segmentOptions });
    if (ctx.prefetchQueue.length > 16) ctx.prefetchQueue.shift();
    pumpPrefetch(ctx);
  }

  // What a new playlist drives: prefetch the announced-but-uncached tail, the init map,
  // and, once everything announced is in hand, one speculative future segment.
  function onPlaylist(ctx, playlistUrl, text) {
    // Only fMP4 media playlists: a master playlist or a TS stream is not the module's business.
    if (/#EXT-X-STREAM-INF/.test(text) || !/#EXT-X-MAP/.test(text)) return false;
    const parsed = core.parseM3u8(text, playlistUrl);
    if (!parsed.segments.length || !parsed.segments.every((segment) => /\.m4s$/i.test(segment.name))) return false;
    ctx.playlistUrl = playlistUrl;
    ctx.lastNum = Math.max(ctx.lastNum, parsed.lastNum);
    if (parsed.mapUrl) {
      ctx.mapKey = keyOf(parsed.mapUrl);
      if (!ctx.cache.has(ctx.mapKey)) cacheSegment(ctx, parsed.mapUrl);
    }
    probeCandidates(ctx, parsed.segments[0].url);
    // The whole announced window, oldest first: the order the player will consume them in.
    let pending = 0;
    for (const segment of parsed.segments) {
      if (!ctx.cache.has(keyOf(segment.url))) {
        enqueuePrefetch(ctx, segment.url);
        pending += 1;
      }
    }
    if (!pending && parsed.lastNum > 0 && ctx.speculativeMisses < 6) {
      const last = parsed.segments.at(-1);
      const nextUrl = last.url.replace(`${last.num}.m4s`, `${last.num + 1}.m4s`);
      if (!ctx.cache.has(keyOf(nextUrl))) {
        enqueuePrefetch(ctx, nextUrl, {
          speculative: true,
          onSettled: (ok) => { ctx.speculativeMisses = ok ? 0 : ctx.speculativeMisses + 1; }
        });
      }
    }
    return true;
  }

  // ---- what the server calls ----
  // The URL with relays taken out: a smtcdns wrapper unwraps to the node it fronts, a P2P
  // relay goes to the best node of its stream (or stays, without a stream to judge by).
  function rewriteUrl(url) {
    const unwrapped = core.unwrapProxyUrl(url) || url;
    if (!core.isP2pUrl(unwrapped)) return unwrapped;
    const ctx = streams.get(directoryOf(unwrapped));
    if (ctx && /\.m4s(?:\?|$)/i.test(unwrapped)) {
      const best = ctx.pool.pick(1)[0];
      if (best) {
        stats.rewritten += 1;
        try { return swapHost(unwrapped, best); } catch (_error) {}
      }
    }
    return unwrapped;
  }

  // A playlist: fetched from the real server (through the rewrite), parsed on the way, and
  // handed back whole for the client. Playlists are a few kilobytes.
  async function fetchPlaylist(url, clientHeaders, signal) {
    const target = rewriteUrl(url);
    const ctx = streamFor(target, clientHeaders);
    stats.playlists += 1;
    const response = await upstream.fetch(target, { headers: ctx.clientHeaders, signal });
    const text = await response.text();
    if (response.status === 200) {
      try { onPlaylist(ctx, target, text); }
      catch (error) { log("warn", `解析直播列表失败：${error?.message || error}`); }
    }
    return { status: response.status, headers: response.headers, text };
  }

  // A segment: from the cache, or downloaded now with the player waiting.
  async function fetchSegment(url, clientHeaders, signal) {
    const target = rewriteUrl(url);
    const ctx = streamFor(target, clientHeaders);
    stats.segments += 1;
    if (signal?.aborted) throw signal.reason || new DOMException("已取消", "AbortError");
    const cached = ctx.cache.get(keyOf(target));
    const item = cached || cacheSegment(ctx, target, { urgent: true });
    if (!cached) ctx.urgentInflight += 1;
    let stopWaiting = () => {};
    try {
      const result = await (signal ? Promise.race([item.promise, new Promise((_resolve, reject) => {
        stopWaiting = () => reject(signal.reason || new DOMException("已取消", "AbortError"));
        signal.addEventListener("abort", stopWaiting, { once: true });
      })]) : item.promise);
      if (!item.hit) {
        item.hit = true;
        if (cached) stats.segmentHits += 1;
        stats.segmentBytes += result.bytes.byteLength;
      }
      return { ...result, fromCache: Boolean(cached) };
    } catch (error) {
      if (error?.name !== "AbortError") {
        stats.failures += 1;
        log("warn", `直播分片下载失败 ${target.split("/").pop().split("?")[0]}：${error?.message || error}`);
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", stopWaiting);
      if (!cached) {
        ctx.urgentInflight = Math.max(0, ctx.urgentInflight - 1);
        pumpPrefetch(ctx);
      }
    }
  }

  function isPlaylistUrl(url) { return core.isLivePlaylistUrl(url); }
  function isSegmentUrl(url) { return core.isLiveSegmentUrl(core.unwrapProxyUrl(url) || url); }

  function sweep() {
    const at = Date.now();
    for (const ctx of [...streams.values()]) {
      pruneCache(ctx);
      if (at - ctx.lastSeenAt > config.streamIdleMs) dropStream(ctx, "这个直播很久没有人看了");
    }
  }
  const sweeper = setInterval(sweep, config.sweepMs);
  sweeper.unref?.();

  function status() {
    return {
      ...stats,
      activeTransfers,
      streams: [...streams.values()].map((ctx) => ({
        key: ctx.key, lastNum: ctx.lastNum, cached: ctx.cache.size, ready: [...ctx.cache.values()].filter((item) => item.done).length, queued: ctx.prefetchQueue.length,
        idleMs: Date.now() - ctx.lastSeenAt, hosts: ctx.pool.status()
      }))
    };
  }

  function close() {
    clearInterval(sweeper);
    for (const ctx of [...streams.values()]) dropStream(ctx, "代理已关闭");
  }

  return Object.freeze({ fetchPlaylist, fetchSegment, rewriteUrl, isPlaylistUrl, isSegmentUrl, status, close, config });
}

module.exports = { createLiveCache };
