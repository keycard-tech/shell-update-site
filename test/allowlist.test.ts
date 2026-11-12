// Two readers of the same file — scripts/binfmt.mjs in Node, src/js/shvr/db.ts in the browser — must refuse the same things, or a build certifies what the page will not open

import assert from "node:assert/strict";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { buildAllowlist, bytesToHex, compare, concat, hexToBytes, sha256Bytes, syntheticDevices } from "./fixtures.ts";
import { readUnits, unitsHeader } from "../scripts/binfmt.mjs";

const signingKey = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const verifyKey = bytesToHex(secp256k1.getPublicKey(hexToBytes(signingKey), true));
const file = buildAllowlist(syntheticDevices(8), signingKey);

test("a file the builder writes reads back with the fields the log shows", () => {
  const header = readUnits(file, verifyKey);

  assert.deepEqual(header, { version: "20261112", rowCount: 8, salt: "4a".repeat(16) });
});

test("the header is readable without the pinned key, and still refuses a contradiction", () => {
  assert.equal(unitsHeader(file).rowCount, 8);

  const lying = Uint8Array.from(file);
  new DataView(lying.buffer).setUint32(8, 9, true);

  assert.throws(() => unitsHeader(lying), /header describes/);
});

const mutate = (what: (bytes: Uint8Array, view: DataView) => void): Uint8Array => {
  const bytes = Uint8Array.from(file);

  what(bytes, new DataView(bytes.buffer));

  return bytes;
};

const refusals: [string, Uint8Array, RegExp][] = [
  ["another magic", mutate((bytes) => bytes.set(new TextEncoder().encode("SHVS"), 0)), /magic/],
  ["format version 2", mutate((_bytes, view) => view.setUint16(4, 2, true)), /format version/],
  ["uid_len 8", mutate((bytes) => (bytes[6] = 8)), /uid length/],
  ["a reserved byte at 7 set", mutate((bytes) => (bytes[7] = 1)), /reserved/],
  ["a reserved byte at 40 set", mutate((bytes) => (bytes[40] = 1)), /reserved/],
  ["truncated by a byte", file.subarray(0, file.length - 1), /header describes/],
  ["row_count zero", mutate((_bytes, view) => view.setUint32(8, 0, true)), /header describes/],
  ["signed by another key", mutate((bytes) => (bytes[bytes.length - 1] ^= 0xff)), /pinned key/],
  ["a row changed after signing", mutate((bytes) => (bytes[96] ^= 0x01)), /pinned key/],
  ["too short to hold a header", file.subarray(0, 100), /too short/],
];

for (const [name, bytes, pattern] of refusals) {
  test(`refused: ${name}`, () => {
    assert.throws(() => readUnits(bytes, verifyKey), pattern);
  });
}

// A length agreeing with a row_count of zero is a contradiction only the empty-array rule can catch
test("refused: an allowlist with no rows at all", () => {
  const empty = new Uint8Array(128);
  empty.set(new TextEncoder().encode("SHVR"), 0);
  new DataView(empty.buffer).setUint16(4, 1, true);
  new DataView(empty.buffer).setUint8(6, 16);

  assert.throws(() => unitsHeader(empty), /empty row array/);
});

// Sorted the wrong way and signed that way, so the refusal can only come from the order check
test("refused: rows out of order", () => {
  const header = Uint8Array.from(file.subarray(0, 64));
  new DataView(header.buffer).setUint32(8, 2, true);

  const prefix = concat(header, new Uint8Array(32).fill(0xff), new Uint8Array(32).fill(0x01));
  const signature = secp256k1.sign(sha256Bytes(prefix), hexToBytes(signingKey), { prehash: false, format: "compact" });

  assert.ok(compare(new Uint8Array(32).fill(0x01), new Uint8Array(32).fill(0xff)) < 0, "the fixtures' own comparator is backwards");
  assert.throws(() => readUnits(concat(prefix, signature), verifyKey), /not sorted/);
});
