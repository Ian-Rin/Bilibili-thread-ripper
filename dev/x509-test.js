"use strict";
// The proxy's certificate authority: DER encoding, a root that signs server certificates
// that Node (and so OpenSSL) accepts for the host they were made for, and a TLS handshake.
const { test } = require("node:test"), assert = require("node:assert/strict");
const crypto = require("node:crypto"), fs = require("node:fs"), os = require("node:os"), path = require("node:path"), tls = require("node:tls");
const x509 = require("../proxy/x509.js");

test("DER primitives match known encodings", () => {
  const hex = (buffer) => Buffer.from(buffer).toString("hex");
  assert.equal(hex(x509.der.integer(0)), "020100");
  assert.equal(hex(x509.der.integer(127)), "02017f");
  assert.equal(hex(x509.der.integer(128)), "02020080", "a leading zero keeps the integer positive");
  assert.equal(hex(x509.der.integer(Buffer.from([0x80, 0x01]))), "0203008001");
  assert.equal(hex(x509.der.oid("1.2.840.113549.1.1.11")), "06092a864886f70d01010b", "sha256WithRSAEncryption");
  assert.equal(hex(x509.der.oid("2.5.29.17")), "0603551d11", "subjectAltName");
  assert.equal(hex(x509.der.namedBits([5, 6])), "03020106", "keyCertSign | cRLSign with one unused bit");
  assert.equal(hex(x509.der.namedBits([0, 2])), "030205a0", "digitalSignature | keyEncipherment with five unused bits");
  assert.equal(hex(x509.der.time(new Date(Date.UTC(2026, 8, 30, 12, 0, 0)))), Buffer.from("\x17\x0d260930120000Z", "latin1").toString("hex"));
  assert.equal(x509.der.time(new Date(Date.UTC(2050, 0, 1)))[0], 0x18, "GeneralizedTime from 2050 on");
  const long = x509.der.sequence(Buffer.alloc(300));
  assert.equal(hex(long.subarray(0, 4)), "3082012c", "long form length");
});

test("the authority signs certificates that verify for their host, and persists", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "btr-x509-"));
  const authority = x509.loadAuthority(directory);
  assert.equal(authority.created, true);
  const root = new crypto.X509Certificate(authority.certificatePem);
  assert.equal(root.ca, true);
  assert.equal(root.verify(root.publicKey), true, "self-signed");
  assert.ok(root.subject.includes("BTR LAN Proxy CA"));
  assert.ok(new Date(root.validTo).getTime() - Date.now() > 3000 * 24 * 3600 * 1000, "about ten years");
  const issued = authority.serverCertificate("upos-sz-mirrorali.bilivideo.com");
  const leaf = new crypto.X509Certificate(issued.cert);
  assert.equal(leaf.checkIssued(root), true);
  assert.equal(leaf.verify(root.publicKey), true);
  assert.equal(leaf.checkHost("upos-sz-mirrorali.bilivideo.com"), "upos-sz-mirrorali.bilivideo.com");
  assert.equal(leaf.checkHost("upos-sz-mirrorhw.bilivideo.com"), undefined, "one certificate per host");
  assert.equal(leaf.subjectAltName, "DNS:upos-sz-mirrorali.bilivideo.com");
  assert.deepEqual(leaf.keyUsage, ["1.3.6.1.5.5.7.3.1"], "serverAuth");
  assert.equal(leaf.ca, false);
  const days = (new Date(leaf.validTo).getTime() - Date.now()) / (24 * 3600 * 1000);
  assert.ok(days > 390 && days < 400, `valid ${days.toFixed(0)} days: under Apple's 398 day limit`);
  assert.notEqual(leaf.serialNumber, root.serialNumber);
  assert.equal(authority.serverCertificate("upos-sz-mirrorali.bilivideo.com"), issued, "kept for the next connection");
  // The same directory loads the same authority.
  const again = x509.loadAuthority(directory);
  assert.equal(again.created, false);
  assert.equal(again.fingerprint256, authority.fingerprint256);
  assert.throws(() => authority.serverCertificate("not a host"), RangeError);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a TLS client that trusts the root accepts the proxy's server certificate", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "btr-x509-"));
  const authority = x509.loadAuthority(directory);
  const server = tls.createServer({
    SNICallback(name, callback) {
      const issued = authority.serverCertificate(name);
      callback(null, tls.createSecureContext({ key: issued.key, cert: issued.cert }));
    }
  }, (socket) => socket.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const connect = (servername, ca) => new Promise((resolve, reject) => {
    const socket = tls.connect({ port, host: "127.0.0.1", servername, ca }, () => resolve({ authorized: socket.authorized, error: socket.authorizationError, socket }));
    socket.once("error", reject);
  });
  try {
    const trusted = await connect("upos-sz-mirrorbos.bilivideo.com", [authority.certificatePem]);
    assert.equal(trusted.authorized, true, trusted.error);
    trusted.socket.destroy();
    await assert.rejects(connect("upos-sz-mirrorbos.bilivideo.com", undefined), /unable to verify|self[- ]signed|UNABLE_TO_VERIFY|SELF_SIGNED/i, "without the root the handshake fails, as a device without the certificate would");
  } finally {
    server.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
