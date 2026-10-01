"use strict";
// A small DNS server for the DNS deployment: the router hands this machine out as the LAN's
// DNS server, this server answers the CDN names with the proxy's own address and forwards
// every other question to the real DNS servers unchanged. Clients then connect to the proxy
// believing it to be the CDN node, with the node's name in SNI, and the proxy can tell them
// apart. AAAA and HTTPS questions for those names get an empty answer on purpose: an IPv6
// address or an HTTP/3 hint from the real DNS would let the client bypass the proxy.
const dgram = require("node:dgram");

const TYPE_A = 1;
const TYPE_AAAA = 28;
const TYPE_HTTPS = 65;

function parseQuestion(message) {
  if (message.length < 12) return null;
  const flags = message.readUInt16BE(2);
  if (flags & 0x8000) return null;
  if (message.readUInt16BE(4) < 1) return null;
  let offset = 12;
  const labels = [];
  for (;;) {
    if (offset >= message.length) return null;
    const length = message[offset];
    if (length === 0) { offset += 1; break; }
    if (length & 0xc0) return null;
    offset += 1;
    if (offset + length > message.length) return null;
    labels.push(message.toString("ascii", offset, offset + length));
    offset += length;
  }
  if (offset + 4 > message.length) return null;
  return {
    id: message.readUInt16BE(0),
    name: labels.join(".").toLowerCase(),
    type: message.readUInt16BE(offset),
    klass: message.readUInt16BE(offset + 2),
    question: message.subarray(12, offset + 4)
  };
}

function buildAnswer(query, addresses, ttl) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.id, 0);
  // QR, AA, RD, RA; NOERROR.
  header.writeUInt16BE(0x8580, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(addresses.length, 6);
  const answers = addresses.map((address) => {
    const record = Buffer.alloc(16);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(TYPE_A, 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt32BE(ttl, 6);
    record.writeUInt16BE(4, 10);
    const parts = address.split(".").map(Number);
    for (let index = 0; index < 4; index += 1) record[12 + index] = parts[index] & 0xff;
    return record;
  });
  return Buffer.concat([header, query.question, ...answers]);
}

function createDnsServer(options) {
  const answerIp = String(options.answerIp || "");
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(answerIp)) throw new Error(`DNS 要回答的地址无效：${answerIp}`);
  const isIntercept = typeof options.isIntercept === "function" ? options.isIntercept : () => false;
  const upstreams = (options.upstreams || ["223.5.5.5", "119.29.29.29"]).map(String).filter(Boolean);
  if (!upstreams.length) throw new Error("DNS 需要至少一个上游服务器");
  const ttl = Math.max(1, Math.trunc(Number(options.ttl)) || 60);
  const log = typeof options.log === "function" ? options.log : () => {};
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const relay = dgram.createSocket("udp4");
  const pending = new Map();
  let sequence = 1;
  let turn = 0;
  const stats = { answered: 0, forwarded: 0, dropped: 0 };

  socket.on("message", (message, remote) => {
    const query = parseQuestion(message);
    if (!query) return;
    if (query.klass === 1 && isIntercept(query.name)) {
      if (query.type === TYPE_A) {
        stats.answered += 1;
        socket.send(buildAnswer(query, [answerIp], ttl), remote.port, remote.address);
        return;
      }
      if (query.type === TYPE_AAAA || query.type === TYPE_HTTPS) {
        stats.answered += 1;
        socket.send(buildAnswer(query, [], ttl), remote.port, remote.address);
        return;
      }
    }
    // Forwarded under a new id, so two clients asking with the same id do not collide.
    const id = sequence;
    sequence = sequence >= 0xffff ? 1 : sequence + 1;
    const forwarded = Buffer.from(message);
    forwarded.writeUInt16BE(id, 0);
    const timer = setTimeout(() => {
      pending.delete(id);
      stats.dropped += 1;
    }, 4000);
    pending.set(id, { remote, originalId: query.id, timer });
    stats.forwarded += 1;
    const upstream = upstreams[turn++ % upstreams.length];
    relay.send(forwarded, 53, upstream, (error) => {
      if (!error) return;
      clearTimeout(timer);
      pending.delete(id);
      log("warn", `转发 DNS 到 ${upstream} 失败：${error.message}`);
    });
  });

  relay.on("message", (message) => {
    if (message.length < 12) return;
    const entry = pending.get(message.readUInt16BE(0));
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.readUInt16BE(0));
    const reply = Buffer.from(message);
    reply.writeUInt16BE(entry.originalId, 0);
    socket.send(reply, entry.remote.port, entry.remote.address);
  });

  socket.on("error", (error) => log("error", `DNS 服务出错：${error.message}`));
  relay.on("error", (error) => log("error", `DNS 转发出错：${error.message}`));

  return Object.freeze({
    stats,
    listen(port = 53, host = "0.0.0.0") {
      return new Promise((resolve, reject) => {
        relay.bind(0, () => {
          socket.once("error", reject);
          socket.bind(port, host, () => {
            socket.removeListener("error", reject);
            resolve(socket.address());
          });
        });
      });
    },
    address: () => socket.address(),
    close() {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      socket.close();
      relay.close();
    }
  });
}

module.exports = { createDnsServer, parseQuestion, buildAnswer, TYPE_A, TYPE_AAAA, TYPE_HTTPS };
