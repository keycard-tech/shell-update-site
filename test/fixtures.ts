// Synthetic devices that sign for themselves, as shell-units' tests/gen-devices.mjs does: a factory CSV cannot take part in a signature test

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { BUILD_VERSION_OFFSET, FORMAT_OFFSET, FORMAT_VERSION, HEADER_SIZE, MAGIC, ROW_COUNT_OFFSET, ROW_LEN, SALT_OFFSET, UID_LEN, UID_LEN_OFFSET } from "../src/js/shvr/format.ts";
import { rowHash } from "../src/js/shvr/db.ts";

export const sha256Bytes = sha256;

interface SyntheticDevice {
  uid: Uint8Array;
  priv: string;
  pub: Uint8Array;
}

export function syntheticDevices(count: number): SyntheticDevice[] {
  const devices: SyntheticDevice[] = [];

  while (devices.length < count) {
    const uid = crypto.getRandomValues(new Uint8Array(16));
    // 0xff 0xff keeps a synthetic uid from ever colliding with a factory row in the same file
    uid[0] = 0xff;
    uid[1] = 0xff;

    const priv = crypto.getRandomValues(new Uint8Array(32));
    devices.push({ uid, priv: bytesToHex(priv), pub: secp256k1.getPublicKey(priv, true) });
  }

  return devices;
}

// 64-byte header, sorted rows padded to a power of two, signature over SHA256 of everything before it
export function buildAllowlist(devices: SyntheticDevice[], signWith: string, { salt = new Uint8Array(16).fill(0x4a), version = 20261112 } = {}): Uint8Array {
  const hashed = devices.map((device) => rowHash(salt, device.uid, device.pub)).sort(compare);
  const rowCount = Math.max(4, 2 ** Math.ceil(Math.log2(hashed.length)));
  const header = new Uint8Array(HEADER_SIZE);
  const view = new DataView(header.buffer);

  header.set(new TextEncoder().encode(MAGIC), 0);
  view.setUint16(FORMAT_OFFSET, FORMAT_VERSION, true);
  header[UID_LEN_OFFSET] = UID_LEN;
  view.setUint32(ROW_COUNT_OFFSET, rowCount, true);
  header.set(salt, SALT_OFFSET);
  view.setUint32(BUILD_VERSION_OFFSET, version, true);

  const prefix = new Uint8Array(HEADER_SIZE + rowCount * ROW_LEN);
  prefix.set(header, 0);

  for (const [at, row] of hashed.entries()) prefix.set(row, HEADER_SIZE + (rowCount - hashed.length + at) * ROW_LEN);

  const signature = secp256k1.sign(sha256(prefix), hexToBytes(signWith), { prehash: false, format: "compact" });

  return concat(prefix, signature);
}

export function compare(a: Uint8Array, b: Uint8Array): number {
  for (const [i, byte] of a.entries()) if (byte !== b[i]) return byte < b[i] ? -1 : 1;

  return 0;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }

  return out;
}

// Well-formed and deliberately malformed dev_auth messages, so the verifier's refusals are tested rather than assumed

const U8 = (...parts: (Uint8Array | number)[]): Uint8Array => {
  const out: number[] = [];
  for (const part of parts) out.push(...(part instanceof Uint8Array ? [...part] : [part]));

  return Uint8Array.from(out);
};

function head(major: number, value: number): Uint8Array[] {
  if (value < 24) return [U8((major << 5) | value)];

  const bytes: number[] = [];
  let v = value;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>>= 8;
  }

  return [U8((major << 5) | (23 + bytes.length)), U8(...bytes)];
}

export const uint = (value: number): Uint8Array => U8(...head(0, value));
export const bstr = (bytes: Uint8Array): Uint8Array => U8(...head(2, bytes.length), bytes);
const tagged = (tag: number, inner: Uint8Array): Uint8Array => U8(...head(6, tag), inner);

interface ResponseParts {
  step?: number;
  uid: Uint8Array;
  challenge: Uint8Array | null;
  sig: Uint8Array | null;
  extra?: [number, Uint8Array][];
  tagDevId?: boolean;
  definite?: boolean;
}

export function responseBytes({ step = 2, uid, challenge, sig, extra = [], tagDevId = true, definite = true }: ResponseParts): Uint8Array {
  const map: Uint8Array[][] = [];

  map.push([uint(1), uint(step)]);
  map.push([uint(2), tagDevId ? tagged(37, bstr(uid)) : bstr(uid)]);
  if (challenge !== null) map.push([uint(6), bstr(challenge)]);
  if (sig !== null) map.push([uint(7), bstr(sig)]);
  for (const [key, value] of extra) map.push([uint(key), value]);

  const body = U8(...map.flat(2));

  return definite ? U8(...head(5, map.length), body) : U8(0xbf, body, 0xff);
}

// Digest = SHA256(uid ‖ challenge), 64-byte compact r‖s, s left exactly as signed
export function deviceSign(privHex: string, uid: Uint8Array, challenge: Uint8Array, { forceHighS = false, forceLowS = false } = {}): Uint8Array {
  const digest = sha256(concat(uid, challenge));
  let sig: Uint8Array = secp256k1.sign(digest, hexToBytes(privHex), { prehash: false, format: "compact", lowS: false });

  const N = secp256k1.Point.Fn.ORDER;
  const s = secp256k1.Signature.fromBytes(sig);

  if ((forceHighS && !s.hasHighS()) || (forceLowS && s.hasHighS())) {
    sig = U8(sig.subarray(0, 32), hexToBytes((N - s.s).toString(16).padStart(64, "0")));
  }

  return sig;
}

export { bytesToHex, hexToBytes, sha256 };
