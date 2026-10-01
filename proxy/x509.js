"use strict";
// Certificates for the LAN proxy, without any dependency: a root CA kept on disk, and one
// server certificate per host name that a client connects to, signed by that CA. Node's
// crypto module signs and verifies but does not build X.509 certificates, so the DER
// encoding is written here. Only what browsers, iOS and Android demand of a locally trusted
// root is emitted: version 3, RSA 2048, SHA-256, subjectAltName, basicConstraints, keyUsage,
// extendedKeyUsage serverAuth, subject and authority key identifiers.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// ---- DER ----
function derLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let value = length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const sequence = (...items) => der(0x30, items);
const set = (...items) => der(0x31, items);
const octetString = (bytes) => der(0x04, bytes);
const boolean = (value) => der(0x01, Buffer.from([value ? 0xff : 0x00]));
const nullValue = () => der(0x05, Buffer.alloc(0));
const utf8String = (text) => der(0x0c, Buffer.from(String(text), "utf8"));
const printableString = (text) => der(0x13, Buffer.from(String(text), "ascii"));
const ia5String = (text) => der(0x16, Buffer.from(String(text), "ascii"));
const explicit = (number, content) => der(0xa0 | number, content);

function integer(value) {
  let bytes;
  if (Buffer.isBuffer(value)) {
    bytes = value;
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0 && !(bytes[start + 1] & 0x80)) start += 1;
    bytes = bytes.subarray(start);
  } else {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("只支持非负整数");
    const list = [];
    for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) list.unshift(rest & 0xff);
    bytes = Buffer.from(list.length ? list : [0]);
  }
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return der(0x02, bytes);
}

function bitString(bytes, unusedBits = 0) {
  return der(0x03, Buffer.concat([Buffer.from([unusedBits]), bytes]));
}

// A BIT STRING of named bits (RFC 5280 KeyUsage): the DER rule leaves off the trailing
// zero bits and counts them as unused.
function namedBits(bits) {
  const highest = Math.max(...bits);
  const bytes = Buffer.alloc(Math.floor(highest / 8) + 1);
  for (const bit of bits) bytes[Math.floor(bit / 8)] |= 0x80 >> (bit % 8);
  let unused = 0;
  const last = bytes[bytes.length - 1];
  while (unused < 8 && !((last >> unused) & 1)) unused += 1;
  return bitString(bytes, unused);
}

function oid(text) {
  const arcs = String(text).split(".").map(Number);
  if (arcs.length < 2 || arcs.some((arc) => !Number.isSafeInteger(arc) || arc < 0)) throw new RangeError(`OID 无效：${text}`);
  const bytes = [arcs[0] * 40 + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const chunk = [];
    for (let rest = arc; ; rest = Math.floor(rest / 128)) {
      chunk.unshift(rest & 0x7f);
      if (rest < 128) break;
    }
    for (let index = 0; index < chunk.length - 1; index += 1) chunk[index] |= 0x80;
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

function time(date) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const year = date.getUTCFullYear();
  const rest = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  // UTCTime carries two-digit years and ends with 2049; later dates use GeneralizedTime.
  return year < 2050 ? der(0x17, Buffer.from(`${pad(year % 100)}${rest}`, "ascii")) : der(0x18, Buffer.from(`${year}${rest}`, "ascii"));
}

const OIDS = Object.freeze({
  commonName: "2.5.4.3",
  organizationName: "2.5.4.10",
  sha256WithRSAEncryption: "1.2.840.113549.1.1.11",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extendedKeyUsage: "2.5.29.37",
  subjectAltName: "2.5.29.17",
  subjectKeyIdentifier: "2.5.29.14",
  authorityKeyIdentifier: "2.5.29.35",
  serverAuth: "1.3.6.1.5.5.7.3.1"
});

function name(attributes) {
  return sequence(...Object.entries(attributes).map(([key, value]) =>
    set(sequence(oid(OIDS[key]), key === "commonName" ? utf8String(value) : printableString(value)))));
}

function extension(id, critical, value) {
  return sequence(oid(id), ...(critical ? [boolean(true)] : []), octetString(value));
}

function keyIdentifier(publicKey) {
  return crypto.createHash("sha1").update(publicKey.export({ type: "spki", format: "der" })).digest();
}

// Every host gets its own serial; a browser that saw two different certificates with one
// serial from the same issuer would refuse the second.
function randomSerial() {
  const bytes = crypto.randomBytes(16);
  bytes[0] &= 0x7f;
  bytes[0] |= 0x01;
  return bytes;
}

function signCertificate(tbs, issuerPrivateKey) {
  const signature = crypto.sign("sha256", tbs, issuerPrivateKey);
  return sequence(tbs, sequence(oid(OIDS.sha256WithRSAEncryption), nullValue()), bitString(signature));
}

function toPem(label, derBytes) {
  const body = derBytes.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

function tbsCertificate({ serial, issuer, subject, notBefore, notAfter, publicKey, extensions }) {
  return sequence(
    explicit(0, integer(2)),
    integer(serial),
    sequence(oid(OIDS.sha256WithRSAEncryption), nullValue()),
    issuer,
    sequence(time(notBefore), time(notAfter)),
    subject,
    publicKey.export({ type: "spki", format: "der" }),
    explicit(3, sequence(...extensions))
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

function generateKey() {
  return crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
}

// The root: self-signed, ten years, and only for signing certificates.
function createRootCertificate({ commonName, organization = "Bilibili Thread Ripper", privateKey, publicKey, now = new Date() }) {
  const subject = name({ commonName, organizationName: organization });
  const identifier = keyIdentifier(publicKey);
  const tbs = tbsCertificate({
    serial: randomSerial(),
    issuer: subject,
    subject,
    notBefore: new Date(now.getTime() - DAY_MS),
    notAfter: new Date(now.getTime() + 3650 * DAY_MS),
    publicKey,
    extensions: [
      extension(OIDS.basicConstraints, true, sequence(boolean(true))),
      extension(OIDS.keyUsage, true, namedBits([5, 6])),
      extension(OIDS.subjectKeyIdentifier, false, octetString(identifier))
    ]
  });
  return signCertificate(tbs, privateKey);
}

// A server certificate for one host name, valid just under 13 months: Apple refuses longer
// ones from a user-installed root. The host also goes into the common name, which some
// older clients still read.
function createServerCertificate({ hostname, issuerCertificate, issuerPrivateKey, publicKey, now = new Date(), validDays = 397 }) {
  const host = String(hostname || "").trim().toLowerCase();
  if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/.test(host) || host.length > 253) throw new RangeError(`主机名无效：${hostname}`);
  const issuer = new crypto.X509Certificate(issuerCertificate);
  const tbs = tbsCertificate({
    serial: randomSerial(),
    issuer: issuerNameDer(issuerCertificate),
    subject: name({ commonName: host.slice(0, 64) }),
    notBefore: new Date(now.getTime() - DAY_MS),
    notAfter: new Date(now.getTime() + validDays * DAY_MS),
    publicKey,
    extensions: [
      extension(OIDS.basicConstraints, true, sequence()),
      extension(OIDS.keyUsage, true, namedBits([0, 2])),
      extension(OIDS.extendedKeyUsage, false, sequence(oid(OIDS.serverAuth))),
      extension(OIDS.subjectAltName, false, sequence(der(0x82, Buffer.from(host, "ascii")))),
      extension(OIDS.subjectKeyIdentifier, false, octetString(keyIdentifier(publicKey))),
      extension(OIDS.authorityKeyIdentifier, false, sequence(der(0x80, keyIdentifier(issuer.publicKey))))
    ]
  });
  return signCertificate(tbs, issuerPrivateKey);
}

// The issuer's subject, byte for byte: a Name re-encoded here could differ in string types
// from what the root carries, and clients match the two as raw bytes.
function issuerNameDer(certificate) {
  const bytes = Buffer.isBuffer(certificate) ? certificate : pemToDer(certificate);
  const elements = (buffer, offset) => {
    const items = [];
    while (offset < buffer.length) {
      const tag = buffer[offset];
      let length = buffer[offset + 1], cursor = offset + 2;
      if (length & 0x80) {
        const count = length & 0x7f;
        length = 0;
        for (let index = 0; index < count; index += 1) length = length * 256 + buffer[cursor + index];
        cursor += count;
      }
      items.push({ tag, start: offset, headerEnd: cursor, end: cursor + length });
      offset = cursor + length;
    }
    return items;
  };
  const certificate_ = elements(bytes, 0)[0];
  const tbs = elements(bytes, certificate_.headerEnd)[0];
  const fields = elements(bytes, tbs.headerEnd);
  // version [0], serial, signature, issuer, validity, subject, ...
  const subject = fields[fields[0].tag === 0xa0 ? 5 : 4];
  return bytes.subarray(subject.start, subject.end);
}

function pemToDer(pem) {
  const body = String(pem).replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s+/g, "");
  return Buffer.from(body, "base64");
}

// The certificate authority of one proxy installation: key and certificate in a directory,
// created on first use. Server certificates share one key, which saves a slow RSA key
// generation per host, and are kept in memory.
function loadAuthority(directory, options = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const keyFile = path.join(directory, "ca.key");
  const certFile = path.join(directory, "ca.crt");
  const leafKeyFile = path.join(directory, "server.key");
  let created = false;
  let privateKey, certificatePem;
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile, "utf8"));
    certificatePem = fs.readFileSync(certFile, "utf8");
  } else {
    const pair = generateKey();
    privateKey = pair.privateKey;
    const commonName = options.commonName || `BTR LAN Proxy CA ${crypto.randomBytes(3).toString("hex")}`;
    certificatePem = toPem("CERTIFICATE", createRootCertificate({ commonName, privateKey, publicKey: pair.publicKey }));
    fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    fs.writeFileSync(certFile, certificatePem);
    created = true;
  }
  let serverKey;
  if (fs.existsSync(leafKeyFile)) serverKey = crypto.createPrivateKey(fs.readFileSync(leafKeyFile, "utf8"));
  else {
    serverKey = generateKey().privateKey;
    fs.writeFileSync(leafKeyFile, serverKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  const serverPublicKey = crypto.createPublicKey(serverKey);
  const serverKeyPem = serverKey.export({ type: "pkcs8", format: "pem" });
  const certificate = new crypto.X509Certificate(certificatePem);
  const issued = new Map();

  function serverCertificate(hostname) {
    const host = String(hostname || "").toLowerCase();
    const existing = issued.get(host);
    // Renewed a month before it runs out; a proxy may run for years.
    if (existing && existing.renewAt > Date.now()) return existing;
    const der_ = createServerCertificate({ hostname: host, issuerCertificate: certificatePem, issuerPrivateKey: privateKey, publicKey: serverPublicKey });
    const entry = { cert: toPem("CERTIFICATE", der_), key: serverKeyPem, renewAt: Date.now() + (397 - 30) * DAY_MS };
    if (issued.size >= 512) issued.delete(issued.keys().next().value);
    issued.set(host, entry);
    return entry;
  }

  return Object.freeze({
    directory,
    created,
    certificatePem,
    certificateDer: pemToDer(certificatePem),
    subject: certificate.subject,
    fingerprint256: certificate.fingerprint256,
    validTo: certificate.validTo,
    serverCertificate
  });
}

module.exports = Object.freeze({
  createRootCertificate,
  createServerCertificate,
  generateKey,
  loadAuthority,
  pemToDer,
  toPem,
  // Exposed for the tests.
  der: Object.freeze({ sequence, integer, oid, namedBits, time })
});
