// Ported from keycard-tech/shell-units tests/verify.test.mjs at tag 20261112: file authentication,
// row agreement with the builder, the device challenge/response, and every way a response can be
// wrong. The fixtures come from test/fixtures.ts instead of a Python-built database, so `npm test`
// needs nothing but Node.

import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { BYTEWORDS, identifier } from "@blockchaincommons/uniform-resources/bytewords";
import { bstr, buildAllowlist, bytesToHex, compare, concat, deviceSign, hexToBytes, responseBytes, sha256, syntheticDevices, uint } from "./fixtures.ts";
import { findRow, loadDatabase, NotRegistered, Refusal, rowHash, verifyDeviceResponse } from "../src/js/shvr/db.ts";
import { encodeDevAuthInit } from "../src/js/shvr/cbor.ts";
import { DEV_AUTH_TYPE, encodeBytewords, looksLikeUr, urDecode, urEncode } from "../src/js/shvr/ur.ts";

const signingKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const verifyKey = bytesToHex(secp256k1.getPublicKey(hexToBytes(signingKey), true));
const devices = syntheticDevices(24);
const file = buildAllowlist(devices, signingKey);
const db = loadDatabase(file, verifyKey);

const challengeOf = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));
const responseOf = (device: (typeof devices)[number], challenge: Uint8Array, opts = {}) =>
  responseBytes({ uid: device.uid, challenge, sig: deviceSign(device.priv, device.uid, challenge, opts) });

test("the header says what a reader needs to refuse or accept", () => {
  assert.equal(db.uidLen, 16);
  assert.ok(db.rowCount >= devices.length, `no padding: ${db.rowCount} rows for ${devices.length} devices`);
  assert.equal(db.rowCount & (db.rowCount - 1), 0, `row count ${db.rowCount} is not a power of two`);
  assert.equal(db.version, 20261112);
});

test("every device in the file is located by its row hash", () => {
  for (const device of devices) {
    assert.ok(findRow(db, rowHash(db.salt, device.uid, device.pub)) >= 0, `row for ${bytesToHex(device.uid)} not found`);
  }
});

for (const [name, opts] of [["as-signed", {}], ["low-s", { forceLowS: true }], ["high-s", { forceHighS: true }]] as [string, { forceHighS?: boolean; forceLowS?: boolean }][]) {
  test(`${name}: a device signature is accepted and yields its key`, () => {
    for (const device of devices) {
      const challenge = challengeOf();
      const result = verifyDeviceResponse(db, challenge, responseOf(device, challenge, opts));
      assert.equal(result.hex, bytesToHex(device.pub), `${name}: recovered key mismatch`);
    }
  });
}

const device = devices[0];
const challenge = challengeOf();
const good = responseOf(device, challenge);

test("a response round-trips through the text a scanner returns", () => {
  const text = urEncode(DEV_AUTH_TYPE, good);
  assert.ok(text.startsWith("UR:DEV-AUTH/"), `bad UR text ${text.slice(0, 20)}`);
  assert.ok(looksLikeUr(text));
  assert.equal(verifyDeviceResponse(db, challenge, urDecode(text, DEV_AUTH_TYPE)).hex, bytesToHex(device.pub));
});

test("a malleated signature still verifies, and yields the same key", () => {
  const N = secp256k1.Point.Fn.ORDER;
  const sig = secp256k1.Signature.fromBytes(deviceSign(device.priv, device.uid, challenge));
  const malleated = concat(sig.toBytes("compact").subarray(0, 32), hexToBytes((N - sig.s).toString(16).padStart(64, "0")));

  assert.equal(verifyDeviceResponse(db, challenge, responseBytes({ uid: device.uid, challenge, sig: malleated })).hex, bytesToHex(device.pub));
});

test("a transcript replayed against another challenge is not registered", () => {
  assert.throws(() => verifyDeviceResponse(db, challengeOf(), good), NotRegistered);
});

test("a registered uid signed by an unlisted key is not registered", () => {
  const foreign = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const c = challengeOf();

  assert.throws(() => verifyDeviceResponse(db, c, responseBytes({ uid: device.uid, challenge: c, sig: deviceSign(foreign, device.uid, c) })), NotRegistered);
});

test("an unlisted uid is not registered", () => {
  const ghost = new Uint8Array(16).fill(0xff);
  const c = challengeOf();

  assert.throws(() => verifyDeviceResponse(db, c, responseBytes({ uid: ghost, challenge: c, sig: deviceSign(devices[1].priv, ghost, c) })), NotRegistered);
});

const tamperedResponses: [string, () => Uint8Array][] = [
  ["a reserved response key", () => responseBytes({ uid: device.uid, challenge, sig: deviceSign(device.priv, device.uid, challenge), extra: [[3, uint(1)]] })],
  ["another reserved response key", () => responseBytes({ uid: device.uid, challenge, sig: deviceSign(device.priv, device.uid, challenge), extra: [[5, uint(7)]] })],
  ["an unknown map key", () => responseBytes({ uid: device.uid, challenge, sig: deviceSign(device.priv, device.uid, challenge), extra: [[42, uint(1)]] })],
  ["the init step instead of the device step", () => responseBytes({ uid: device.uid, challenge, sig: deviceSign(device.priv, device.uid, challenge), step: 1 })],
  ["a missing challenge field", () => responseBytes({ uid: device.uid, challenge: null, sig: deviceSign(device.priv, device.uid, challenge) })],
  ["a missing signature", () => responseBytes({ uid: device.uid, challenge, sig: null })],
  ["dev_id without tag 37", () => responseBytes({ uid: device.uid, challenge, sig: deviceSign(device.priv, device.uid, challenge), tagDevId: false })],
  ["dev_id truncated to the 96-bit ID", () => responseBytes({ uid: device.uid.subarray(0, 12), challenge, sig: deviceSign(device.priv, device.uid, challenge) })],
  ["an indefinite-length map", () => responseBytes({ uid: device.uid, challenge, sig: deviceSign(device.priv, device.uid, challenge), definite: false })],
  ["a signature one byte too long", () => responseBytes({ uid: device.uid, challenge, sig: concat(deviceSign(device.priv, device.uid, challenge), bstr(new Uint8Array(0))) })],
];

for (const [name, build] of tamperedResponses) {
  test(`refused: ${name}`, () => {
    assert.throws(() => verifyDeviceResponse(db, challenge, build()), Refusal);
  });
}

const mutate = (offset: number, value: number): Uint8Array => {
  const bytes = Uint8Array.from(file);
  new DataView(bytes.buffer).setUint8(offset, value);

  return bytes;
};

test("refused: a tampered row", () => {
  const bytes = Uint8Array.from(file);
  bytes[64] ^= 0x01;

  assert.throws(() => loadDatabase(bytes, verifyKey), Refusal);
});

test("refused: a truncated file", () => {
  assert.throws(() => loadDatabase(file.subarray(0, file.length - 1), verifyKey), Refusal);
});

// A mutation of the header also breaks the signature, so these assert on the message: matching only
// the exception type would pass when the signature check caught it instead of the field check.
test("refused: a header this reader must not interpret", () => {
  assert.throws(() => loadDatabase(mutate(6, 24), verifyKey), /uid length/);
  assert.throws(() => loadDatabase(mutate(4, 2), verifyKey), /format version/);
  assert.throws(() => loadDatabase(mutate(7, 1), verifyKey), /reserved/);
  assert.throws(() => loadDatabase(mutate(40, 1), verifyKey), /reserved/);
});

test("refused: a different signing key", () => {
  const other = secp256k1.getPublicKey(crypto.getRandomValues(new Uint8Array(32)), true);

  assert.throws(() => loadDatabase(file, bytesToHex(other)), /pinned key/);
});

test("refused: rows out of order", () => {
  const header = Uint8Array.from(file.subarray(0, 64));
  new DataView(header.buffer).setUint32(8, 2, true);

  // Sorted the wrong way and signed that way, so the refusal can only come from the order check.
  const prefix = concat(header, new Uint8Array(32).fill(0xff), new Uint8Array(32).fill(0x01));
  const signature = secp256k1.sign(sha256(prefix), hexToBytes(signingKey), { prehash: false, format: "compact" });

  assert.throws(() => loadDatabase(concat(prefix, signature), verifyKey), /not sorted/);
});

test("the challenge text follows the device framing rules", () => {
  const c = challengeOf();
  const payload = encodeDevAuthInit(c);
  const text = urEncode(DEV_AUTH_TYPE, payload);
  const body = text.slice(text.indexOf("/") + 1);

  assert.match(text.slice(0, text.indexOf("/")), /^UR:DEV-AUTH$/);
  assert.match(body, /^[a-z]+$/, `body is not lowercase letters only: ${body.slice(0, 24)}`);
  assert.equal(body.length, (payload.length + 4) * 2, "two letters per byte plus a 4 byte checksum");

  // Naming the checksum without trusting the encoder means re-deriving it elsewhere: equal strings
  // prove the algorithm is CRC-32 big-endian, which is what the device's bytewords.c computes.
  const want = (crc32(payload) >>> 0).toString(16).padStart(8, "0");
  assert.ok(body.endsWith(encodeBytewords(Uint8Array.from(Buffer.from(want, "hex")), "minimal").slice(0, 8)));
  assert.deepEqual(urDecode(text, DEV_AUTH_TYPE), payload);
});

// A table that is merely self-consistent passes every other test in this file and still produces codes
// the firmware refuses without a word. These spellings are read out of the vendor bundle shell-units
// ships at 20261112 — a second implementation, not the one under test. `identifier` is that table
// spelled without a checksum, which is the thing being pinned.
test("the bytewords table is the device's table", () => {
  assert.equal(identifier(new Uint8Array([0x00, 0x01, 0x02, 0x03]), { style: "minimal" }), "aeadaoax");
  assert.equal(identifier(Uint8Array.from([0xfc, 0xfd, 0xfe, 0xff]), { style: "minimal" }), "ztzczezm");

  // The code is the first and last letter of each word, and the spec's claim is that those 256 pairs
  // never collide; a table with a collision would decode two bytes to the same pair.
  assert.equal(new Set(BYTEWORDS.map((word) => word[0] + word[word.length - 1])).size, 256);
});

test("the challenge is what the firmware decoder demands", () => {
  const c = challengeOf();

  assert.deepEqual(encodeDevAuthInit(c), Uint8Array.from([0xa2, 0x01, 0x01, 0x06, 0x58, 0x20, ...c]));
});

test("a base32 payload is refused, as the device refuses it", () => {
  assert.throws(() => urDecode("UR:DEV-AUTH/IBSGAYTBOJSXG42PNRSGK5DBN5ZGK5DUPBSXG2DB", DEV_AUTH_TYPE), Error);
});

test("a multi-part UR is refused", () => {
  assert.throws(() => urDecode("UR:DEV-AUTH/1-3/oeadadamhdcxae", DEV_AUTH_TYPE), Error);
});

test("a corrupted bytewords body is refused", () => {
  const text = urEncode(DEV_AUTH_TYPE, encodeDevAuthInit(challengeOf()));
  const cut = text.length - 2;

  assert.throws(() => urDecode(text.slice(0, cut) + (text.endsWith("lk") ? "jl" : "lk"), DEV_AUTH_TYPE), Error);
});

test("a QR string round-trips through the case a scanner may fold it to", () => {
  const c = challengeOf();
  const text = urEncode(DEV_AUTH_TYPE, encodeDevAuthInit(c)).toLowerCase();

  assert.deepEqual(urDecode(text, DEV_AUTH_TYPE), encodeDevAuthInit(c));
});

test("refused: a file whose length contradicts its header", () => {
  const bytes = Uint8Array.from(file);
  new DataView(bytes.buffer).setUint32(8, db.rowCount + 1, true);

  assert.throws(() => loadDatabase(bytes, verifyKey), /bytes/);
});

test("rows the builder sorted are in the order the search assumes", () => {
  const sorted = devices.map((each) => rowHash(db.salt, each.uid, each.pub)).sort(compare);

  for (const [at, row] of sorted.entries()) assert.equal(findRow(db, row), db.rowCount - sorted.length + at);
});
