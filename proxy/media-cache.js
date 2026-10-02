"use strict";
// The proxy's counterpart of the userscript's compatibility mode: the player (in a browser
// or an app on the LAN) keeps playing as it always does and asks the CDN for byte ranges of
// the media files; each such request is answered here, downloaded in many pieces from many
// nodes by the shared core, and written to the client as the pieces arrive in order.
//
// A proxy sees less than the userscript: no playinfo, no player buffer. What it does see is
// the sequence of requests, and the index (SIDX) the player fetches first, which maps bytes
// to playback time. With the index, the proxy knows which segment each request is, estimates
// where playback is (the first request after a seek starts at the playhead, and the clock
// runs from there), and gives every download the same kind of playback deadline the full
// takeover gives its pieces: the shared core then hedges and orders by urgency as it does
// there. The segments that follow are read ahead by playback time, so the next requests are
// answered out of memory. Without an index (FLV, or a player that never asked for one) the
// read-ahead falls back to a multiple of the request length and downloads get no deadline.
//
// Pieces are the unit: a contiguous byte range of one file, downloading or complete, with its
// data kept as the ordered chunks it arrived in. A request is served from the pieces that
// cover it, and new pieces are started for the gaps. Pieces of one file never overlap.

const KIB = 1024;
const MIB = 1024 * KIB;

function createMediaCache(options) {
  const { shared, upstream } = options;
  const { core, cdn, idm, sidx: sidxTools } = shared;
  const log = typeof options.log === "function" ? options.log : () => {};
  const now = typeof options.now === "function" ? options.now : Date.now;
  const config = {
    readAhead: options.readAhead !== false,
    // Read-ahead by playback time once the index is known: this many seconds of media past
    // the request, as one piece per segment, a few in flight at a time.
    readAheadSeconds: Number(options.readAheadSeconds) > 0 ? Number(options.readAheadSeconds) : 20,
    aheadInFlight: Math.max(1, Math.trunc(Number(options.aheadInFlight)) || 2),
    // Read-ahead without an index: this many times the request's own length, within the
    // bounds. The player's own requests are one segment each, so one segment ahead is one
    // request ahead.
    readAheadMultiple: Number(options.readAheadMultiple) > 0 ? Number(options.readAheadMultiple) : 2,
    readAheadMinBytes: Number(options.readAheadMinBytes) > 0 ? Number(options.readAheadMinBytes) : 512 * KIB,
    readAheadMaxBytes: Number(options.readAheadMaxBytes) > 0 ? Number(options.readAheadMaxBytes) : 64 * MIB,
    // Below this a request is a header or an index, not media: it gets no read-ahead.
    mediaRequestMinBytes: Number(options.mediaRequestMinBytes) > 0 ? Number(options.mediaRequestMinBytes) : 128 * KIB,
    // Data behind the newest request that is kept, for a player that re-reads a little.
    keepBehindBytes: Number(options.keepBehindBytes) >= 0 ? Number(options.keepBehindBytes) : 4 * MIB,
    maxCacheBytes: Number(options.maxCacheBytes) > 0 ? Number(options.maxCacheBytes) : 512 * MIB,
    fileIdleMs: Number(options.fileIdleMs) > 0 ? Number(options.fileIdleMs) : 90000,
    sweepMs: Number(options.sweepMs) > 0 ? Number(options.sweepMs) : 5000
  };
  let settings = core.normalizeSettings({ concurrency: 16, autoConcurrency: false, ...(options.settings || {}) });
  const files = new Map();
  const videos = new Map();
  const stats = {
    requests: 0, servedBytes: 0, aheadHits: 0, aheadBytes: 0, failures: 0, indexedFiles: 0,
    activeThreads: 0, totalSpeedBps: 0, cacheBytes: 0, pieces: 0, filesOpen: 0
  };
  const transfers = new Map();
  let transferSequence = 1;
  const recent = [];

  // ---- settings ----
  function applySettings(next) {
    settings = core.normalizeSettings({ concurrency: 16, ...next, autoConcurrency: false });
    for (const video of videos.values()) video.downloader.applySettings();
  }

  // ---- transfer statistics (the "threads" of the panel) ----
  function onTransfer(event) {
    const at = now();
    if (event?.phase === "start") {
      const id = transferSequence++;
      let host = "";
      try { host = new URL(event.url).hostname; } catch (_error) {}
      transfers.set(id, { id, host, kind: event.kind, loaded: 0, startedAt: at, lastAt: at });
      return id;
    }
    const item = transfers.get(Number(event?.id));
    if (!item) return event?.id;
    if (event.phase === "progress") {
      const bytes = Math.max(0, Number(event.bytes) || 0);
      item.loaded += bytes;
      item.lastAt = at;
      recent.push({ at, bytes });
    } else {
      transfers.delete(item.id);
    }
    return event.id;
  }

  function refreshStats() {
    const at = now();
    while (recent.length && at - recent[0].at > 2000) recent.shift();
    stats.activeThreads = transfers.size;
    stats.totalSpeedBps = Math.round(recent.reduce((sum, item) => sum + item.bytes, 0) / 2);
    stats.filesOpen = files.size;
    let pieces = 0, indexed = 0;
    for (const file of files.values()) {
      pieces += file.pieces.length;
      if (file.sidx) indexed += 1;
    }
    stats.pieces = pieces;
    stats.indexedFiles = indexed;
    return stats;
  }

  // ---- files and videos ----
  const KIND_RE = /-(?:302\d\d|3025[0-9])\.m4s(?:$|\?)/i;
  function kindOf(url) {
    return KIND_RE.test(url.pathname) ? "audio" : "video";
  }

  function deadlineOf(url) {
    return Number(url.searchParams.get("deadline")) || 0;
  }

  // One video: a directory of files sharing a node list, a ban list and a thread budget. The
  // userscript keeps all that per video too.
  function videoFor(url) {
    const key = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1).toLowerCase();
    let video = videos.get(key);
    if (video) return video;
    const bans = cdn.createBanList({
      onBan(host, _count, _error, kind) {
        log("warn", kind === "address" ? `停用一个被所有节点拒绝的下载地址（${key}）` : `停用节点 ${host}：两次没有返回数据（${key}）`);
      }
    });
    video = {
      key,
      bans,
      files: new Set(),
      lastRequestAt: now(),
      // The client's own identity goes with every piece: a node that cares about the
      // player's User-Agent sees the same one it would have seen.
      clientHeaders: {},
      downloader: null
    };
    video.downloader = idm.createDownloader({
      getSettings: () => settings,
      nativeFetch: (target, init = {}) => upstream.fetch(target, { ...init, headers: { ...video.clientHeaders, ...(init.headers || {}) } }),
      onTransfer
    });
    videos.set(key, video);
    return video;
  }

  function fileFor(url, clientHeaders) {
    const key = url.pathname.toLowerCase();
    const video = videoFor(url);
    let file = files.get(key);
    if (!file) {
      const representation = { baseUrl: url.href };
      file = {
        key,
        video,
        kind: kindOf(url),
        representation,
        deadline: deadlineOf(url),
        resolver: cdn.createResolver(representation, () => settings.mode, video.bans, () => settings.customHosts),
        pieces: [],
        total: null,
        // The SIDX once a piece carried it, and the estimated playhead: the media time at
        // which playback was last known to be (a seek lands on it) and when that was.
        sidx: null,
        clock: null,
        lastRequestAt: now(),
        lastRequestEnd: -1,
        lastRequestLength: 0,
        requests: 0
      };
      files.set(key, file);
      video.files.add(file);
    } else if (deadlineOf(url) > file.deadline || (!deadlineOf(url) && url.href !== file.representation.baseUrl)) {
      // A fresh signature from the player: the resolver reads the representation on every
      // request, so the new address goes in place and its measurements stay.
      file.representation.baseUrl = url.href;
      file.deadline = deadlineOf(url);
    }
    const ua = clientHeaders?.["user-agent"];
    if (ua && !video.clientHeaders["user-agent"]) video.clientHeaders["user-agent"] = String(ua);
    const referer = clientHeaders?.referer;
    if (referer && /^https:\/\/[^/]*bilibili\.com\//i.test(String(referer)) && !video.clientHeaders.referer) video.clientHeaders.referer = String(referer);
    file.lastRequestAt = video.lastRequestAt = now();
    return file;
  }

  // ---- the index and the playback clock ----
  function segmentAt(file, byteOffset) {
    const segments = file.sidx?.segments;
    if (!segments?.length) return null;
    let low = 0, high = segments.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const segment = segments[middle];
      if (byteOffset < segment.start) high = middle - 1;
      else if (byteOffset > segment.end) low = middle + 1;
      else return segment;
    }
    return null;
  }

  // The estimated media time playback has reached: from the anchor at one second per second.
  // A paused or stalled player is behind the estimate, which only makes deadlines earlier
  // than they need to be: the safe side.
  function playheadAt(file, at = performance.now()) {
    if (!file.clock) return null;
    return file.clock.mediaTime + (at - file.clock.wallAt) / 1000;
  }

  // When playback needs the bytes at an offset, as a performance.now() instant, read again
  // at every check by the downloader; Infinity until the index and the clock are known.
  function deadlineFor(file, byteOffset) {
    return () => {
      const segment = segmentAt(file, byteOffset);
      const playhead = playheadAt(file);
      if (!segment || playhead === null) return Infinity;
      return performance.now() + Math.max(0, (segment.startTime - playhead) * 1000);
    };
  }

  // The player fetches the index first, as a small request; any small piece of a file whose
  // index is not known yet is tried. A media piece, starting at a box boundary or not, fails
  // the parse at once.
  function tryIndex(file, piece) {
    if (file.sidx || piece.length > MIB || /\.flv$/i.test(file.key)) return;
    let parsed = null;
    try { parsed = sidxTools.parseSidx(core.concatChunks(piece.chunks, piece.length), piece.start); }
    catch (_error) { return; }
    if (!parsed?.segments?.length) return;
    file.sidx = parsed;
    log("debug", `读到 ${file.key.split("/").pop()} 的索引：${parsed.segments.length} 段，${(parsed.segments.at(-1).endTime).toFixed(0)} 秒`);
  }

  function anchorClock(file, byteOffset) {
    const segment = segmentAt(file, byteOffset);
    if (!segment) return;
    file.clock = { mediaTime: segment.startTime, wallAt: performance.now() };
  }

  // ---- pieces ----
  function notify(piece) {
    const waiters = piece.waiters;
    piece.waiters = [];
    for (const resolve of waiters) resolve();
  }

  function waitFor(piece) {
    return new Promise((resolve) => piece.waiters.push(resolve));
  }

  function dropPiece(file, piece, reason) {
    const index = file.pieces.indexOf(piece);
    if (index >= 0) file.pieces.splice(index, 1);
    if (!piece.done) piece.controller.abort(new DOMException(reason || "不再需要这段数据", "AbortError"));
    stats.cacheBytes -= piece.received;
    piece.dropped = true;
    notify(piece);
  }

  function startPiece(file, start, end, demand, priority = demand ? 120 : 50) {
    const piece = {
      start, end, length: end - start + 1,
      demand,
      chunks: [], received: 0, done: false, error: null, dropped: false,
      // A piece the player asked for and then gave up on (a seek) is an orphan: the next
      // request elsewhere drops it, and the sweep drops it after a while.
      orphan: false,
      waiters: [], readers: 0, lastReadAt: now(), createdAt: now(),
      controller: new AbortController(),
      scheduled: null
    };
    let scheduledResolve = () => {};
    piece.scheduled = new Promise((resolve) => { scheduledResolve = resolve; });
    file.pieces.push(piece);
    file.pieces.sort((a, b) => a.start - b.start);
    const range = { start, end, length: piece.length };
    piece.promise = file.video.downloader.downloadRange(range, file.resolver, {
      signal: piece.controller.signal,
      parallel: true,
      kind: file.kind,
      // A piece the player is waiting for is a startup piece: probed first, then spread over
      // the measured nodes, ahead of everything else in the queue. Read-ahead is ordinary,
      // and with a deadline the queue ranks it by how soon playback needs it.
      startup: demand,
      priority,
      deadlineAt: deadlineFor(file, start),
      onStartupScheduled: scheduledResolve,
      onOrderedChunk(bytes, part, fileTotal) {
        if (piece.controller.signal.aborted) throw piece.controller.signal.reason;
        if (part.start !== piece.start + piece.received || bytes.byteLength !== part.length) throw new Error("媒体 Range 校验失败");
        if (!Number.isSafeInteger(fileTotal) || fileTotal <= piece.end) throw new Error("文件总长度与请求的范围矛盾");
        if (file.total !== null && file.total !== fileTotal) throw new Error("不同 CDN 返回的文件总长度不一致");
        file.total = fileTotal;
        piece.chunks.push(bytes);
        piece.received += bytes.byteLength;
        stats.cacheBytes += bytes.byteLength;
        notify(piece);
      }
    }).then((result) => {
      scheduledResolve();
      if (piece.received !== piece.length) throw new Error(`子区间长度不符：${piece.received}/${piece.length}`);
      piece.done = true;
      piece.hosts = result.hosts;
      piece.pieceCount = result.pieceCount;
      if (demand) tryIndex(file, piece);
      notify(piece);
      // A finished read-ahead piece makes room for the next one towards the horizon.
      if (!demand && files.get(file.key) === file && file.lastRequestEnd >= 0) {
        scheduleReadAhead(file, file.lastRequestEnd, file.lastRequestLength);
        enforceCacheLimit();
      }
      return piece;
    }, (error) => {
      scheduledResolve();
      piece.error = error;
      if (error?.name !== "AbortError") {
        stats.failures += 1;
        log("warn", `${demand ? "下载" : "预读"}失败 ${file.key} [${start}-${end}]：${error?.message || error}`);
      }
      dropPiece(file, piece, "下载失败");
      throw error;
    });
    piece.promise.catch(() => {});
    return piece;
  }

  // The bytes of one piece from `from` to `to` (inclusive, absolute), yielded as they arrive.
  async function* readPiece(piece, from, to) {
    piece.readers += 1;
    piece.lastReadAt = now();
    try {
      let cursor = from;
      let chunkIndex = 0;
      let chunkStart = piece.start;
      while (cursor <= to) {
        while (piece.start + piece.received <= cursor) {
          if (piece.error) throw piece.error;
          if (piece.dropped) throw new Error("这段数据已经被释放");
          if (piece.done) throw new Error("数据提前结束");
          await waitFor(piece);
        }
        while (chunkStart + piece.chunks[chunkIndex].byteLength <= cursor) {
          chunkStart += piece.chunks[chunkIndex].byteLength;
          chunkIndex += 1;
        }
        const chunk = piece.chunks[chunkIndex];
        const sliceStart = cursor - chunkStart;
        const sliceEnd = Math.min(chunk.byteLength, to - chunkStart + 1);
        yield chunk.subarray(sliceStart, sliceEnd);
        cursor = chunkStart + sliceEnd;
        piece.lastReadAt = now();
      }
    } finally {
      piece.readers -= 1;
    }
  }

  const live = (piece) => !piece.dropped && !piece.error;

  // The intervals of [start, end] no piece covers, in order.
  function gapsIn(file, start, end) {
    const gaps = [];
    let cursor = start;
    while (cursor <= end) {
      const covering = file.pieces.find((piece) => live(piece) && piece.start <= cursor && piece.end >= cursor);
      if (covering) {
        cursor = covering.end + 1;
        continue;
      }
      const next = file.pieces.find((piece) => live(piece) && piece.start > cursor);
      const to = Math.min(end, next ? next.start - 1 : end);
      gaps.push({ start: cursor, end: to });
      cursor = to + 1;
    }
    return gaps;
  }

  // Which pieces cover a range, in order, with new pieces for the gaps.
  function coverage(file, start, end) {
    const created = new Set();
    for (const gap of gapsIn(file, start, end)) created.add(startPiece(file, gap.start, gap.end, true));
    const plan = [];
    let cursor = start;
    while (cursor <= end) {
      const piece = file.pieces.find((item) => live(item) && item.start <= cursor && item.end >= cursor);
      if (!piece) throw new Error("覆盖计算出错");
      const to = Math.min(end, piece.end);
      plan.push({ piece, from: cursor, to, fresh: created.has(piece) });
      cursor = to + 1;
    }
    return plan;
  }

  function aheadInFlight(file) {
    return file.pieces.filter((piece) => live(piece) && !piece.demand && !piece.done).length;
  }

  function cacheRoom(bytes) {
    return stats.cacheBytes + bytes <= config.maxCacheBytes * 0.85;
  }

  // Read-ahead after a request: with the index, the segments that follow until the horizon
  // of playback time, each as one piece with its own deadline, a few in flight at a time;
  // without it, the bytes that follow as one piece. Only one read-ahead piece is in flight
  // without an index, so a player that seeks does not leave a trail of downloads.
  function scheduleReadAhead(file, requestEnd, requestLength) {
    if (!config.readAhead) return;
    const limit = file.total !== null ? file.total - 1 : Infinity;
    if (file.sidx) {
      const anchor = segmentAt(file, requestEnd);
      if (!anchor) return;
      const horizon = anchor.endTime + config.readAheadSeconds;
      let inFlight = aheadInFlight(file);
      let scheduledBytes = 0;
      for (let index = anchor.index + 1; index < file.sidx.segments.length && inFlight < config.aheadInFlight; index += 1) {
        const segment = file.sidx.segments[index];
        if (segment.startTime >= horizon || segment.start > limit) break;
        const gaps = gapsIn(file, segment.start, Math.min(segment.end, limit));
        for (const gap of gaps) {
          const size = gap.end - gap.start + 1;
          if (scheduledBytes + size > config.readAheadMaxBytes || !cacheRoom(size)) return;
          // The further away, the lower the priority; the deadline sorts them finer still.
          startPiece(file, gap.start, gap.end, false, Math.max(20, 50 - (index - anchor.index) * 2));
          scheduledBytes += size;
          inFlight += 1;
          if (inFlight >= config.aheadInFlight) return;
        }
      }
      return;
    }
    if (requestLength < config.mediaRequestMinBytes || aheadInFlight(file)) return;
    let start = requestEnd + 1;
    for (;;) {
      const covering = file.pieces.find((piece) => live(piece) && piece.start <= start && piece.end >= start);
      if (!covering) break;
      start = covering.end + 1;
    }
    if (start > limit) return;
    const wanted = Math.max(config.readAheadMinBytes, Math.min(config.readAheadMaxBytes, Math.round(requestLength * config.readAheadMultiple)));
    const next = file.pieces.find((piece) => live(piece) && piece.start > start);
    const end = Math.min(limit, start + wanted - 1, next ? next.start - 1 : Infinity);
    if (end < start || !cacheRoom(end - start + 1)) return;
    startPiece(file, start, end, false);
  }

  // A player that jumped elsewhere in the file: the read-ahead of the old position is
  // cancelled unless the new request touches it. Data behind the new position goes too.
  function trimAround(file, start, end) {
    for (const piece of file.pieces.slice()) {
      const overlaps = piece.end >= start && piece.start <= end + config.readAheadMaxBytes;
      if ((!piece.demand || piece.orphan) && !piece.done && !overlaps && !piece.readers) dropPiece(file, piece, "播放位置变了");
      else if (piece.end < start - config.keepBehindBytes && !piece.readers) dropPiece(file, piece, "已经播放过了");
    }
  }

  // Over the limit, completed pieces go: what is behind the newest request first (oldest
  // read first), then what is furthest ahead of it. The pieces needed soonest stay longest.
  function enforceCacheLimit() {
    if (stats.cacheBytes <= config.maxCacheBytes) return;
    const candidates = [];
    for (const file of files.values()) {
      for (const piece of file.pieces) {
        if (!piece.done || piece.readers) continue;
        const behind = piece.end < file.lastRequestEnd;
        candidates.push({ file, piece, rank: behind ? -1e15 + piece.lastReadAt : -(piece.start - file.lastRequestEnd) });
      }
    }
    candidates.sort((a, b) => a.rank - b.rank);
    for (const { file, piece } of candidates) {
      if (stats.cacheBytes <= config.maxCacheBytes * 0.9) break;
      dropPiece(file, piece, "缓存已满");
    }
  }

  // ---- serving ----
  // request: { url (URL), range {start,end,length}, headers (client's, lower-case), signal }
  // sink: { head(total) once before the first byte, write(bytes) -> Promise }
  // Returns { total, bytes, pieces, fromCache } or throws before head() was called; a failure
  // after head() rejects as well, and the caller ends the connection.
  async function serve(request, sink) {
    const { url, range } = request;
    const file = fileFor(url, request.headers);
    const video = file.video;
    stats.requests += 1;
    file.requests += 1;
    const sequential = file.lastRequestEnd >= 0 && range.start === file.lastRequestEnd + 1;
    const media = range.length >= config.mediaRequestMinBytes;
    if (!sequential) trimAround(file, range.start, range.end);
    // The first media request after a seek (or the start) lands where playback is.
    if (media && (!sequential || !file.clock)) anchorClock(file, range.start);
    const plan = coverage(file, range.start, range.end);
    const fresh = plan.filter((item) => item.fresh);
    const cachedBytes = plan.filter((item) => !item.fresh).reduce((sum, item) => sum + (item.to - item.from + 1), 0);
    if (cachedBytes) {
      stats.aheadHits += 1;
      stats.aheadBytes += cachedBytes;
    }
    file.lastRequestEnd = range.end;
    file.lastRequestLength = range.length;
    // The read-ahead waits until the requested pieces hold their places in the download
    // queue; started earlier it would take their connections.
    Promise.all(fresh.map((item) => item.piece.scheduled)).then(() => {
      if (request.signal?.aborted) return;
      scheduleReadAhead(file, range.end, range.length);
      enforceCacheLimit();
    });
    let headed = false;
    let written = 0;
    try {
      for (const item of plan) {
        for await (const chunk of readPiece(item.piece, item.from, item.to)) {
          if (request.signal?.aborted) throw request.signal.reason || new DOMException("客户端已断开", "AbortError");
          if (!headed) {
            headed = true;
            sink.head(file.total);
          }
          await sink.write(chunk);
          written += chunk.byteLength;
        }
      }
      stats.servedBytes += written;
      video.lastRequestAt = file.lastRequestAt = now();
      // The index may have come with this very request; the read-ahead then follows it.
      if (file.sidx && !file.clock && media) anchorClock(file, range.start);
      return { total: file.total, bytes: written, pieces: plan.length, fromCache: cachedBytes, headed };
    } catch (error) {
      for (const item of fresh) if (!item.piece.done && !item.piece.readers) item.piece.orphan = true;
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { headed });
    }
  }

  // ---- housekeeping ----
  function sweep() {
    const at = now();
    for (const file of files.values()) {
      for (const piece of file.pieces.slice()) {
        if (piece.orphan && !piece.done && !piece.readers && at - piece.lastReadAt > 10000) dropPiece(file, piece, "播放器已经放弃了这段数据");
      }
      // A file someone is still reading from is not idle, however long ago it was asked for.
      if (at - file.lastRequestAt < config.fileIdleMs || file.pieces.some((piece) => piece.readers > 0)) continue;
      for (const piece of file.pieces.slice()) dropPiece(file, piece, "这个文件很久没有被请求了");
      files.delete(file.key);
      file.video.files.delete(file);
    }
    for (const video of videos.values()) {
      if (!video.files.size && at - video.lastRequestAt >= config.fileIdleMs) videos.delete(video.key);
    }
    enforceCacheLimit();
  }
  const sweeper = setInterval(sweep, config.sweepMs);
  sweeper.unref?.();

  function status() {
    refreshStats();
    const nodes = new Map();
    for (const file of files.values()) {
      for (const item of file.resolver.status()) {
        const current = nodes.get(item.host);
        if (!current || current.state === "untested" || item.bps > current.bps) nodes.set(item.host, item);
      }
    }
    return {
      ...stats,
      settings: { mode: settings.mode, customHosts: settings.customHosts, concurrency: settings.concurrency, readAheadSeconds: config.readAheadSeconds },
      nodes: [...nodes.values()],
      files: [...files.values()].map((file) => {
        const playhead = playheadAt(file);
        const ahead = file.sidx && playhead !== null ? segmentAt(file, Math.max(0, file.lastRequestEnd)) : null;
        return {
          path: file.key, kind: file.kind, total: file.total, requests: file.requests,
          idleMs: now() - file.lastRequestAt,
          segments: file.sidx?.segments.length || 0,
          playhead: playhead === null ? null : Math.round(playhead * 10) / 10,
          // How far past the estimated playhead the requested data reaches, in seconds.
          requestedAhead: ahead ? Math.round((ahead.endTime - playhead) * 10) / 10 : null,
          pieces: file.pieces.map((piece) => ({ start: piece.start, end: piece.end, received: piece.received, done: piece.done, demand: piece.demand }))
        };
      }),
      threads: [...transfers.values()].map((item) => ({ id: item.id, host: item.host, kind: item.kind, loaded: item.loaded, bps: Math.round(item.loaded * 1000 / Math.max(1, now() - item.startedAt)) }))
    };
  }

  function close() {
    clearInterval(sweeper);
    for (const file of files.values()) for (const piece of file.pieces.slice()) dropPiece(file, piece, "代理已关闭");
    files.clear();
    videos.clear();
  }

  return Object.freeze({ serve, status, applySettings, close, config, settings: () => settings, kindOf });
}

module.exports = { createMediaCache };
