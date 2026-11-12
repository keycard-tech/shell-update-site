// Fixtures for the SHVR tests: synthetic devices that can sign for themselves, and an allowlist built
// the way tools/build-db.py builds one. A factory CSV cannot take part in a signature test — nobody
// holds those private keys — so the tests bring their own, exactly as that repo's tests/gen-devices.mjs
// does.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { createHash } from "node:crypto";
import { rowHash } from "../src/js/shvr/db.ts";

export const sha256Bytes = sha256;
export const sha256OfFile = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export interface SyntheticDevice {
  uid: Uint8Array;
  priv: string;
  pub: Uint8Array;
}

export function syntheticDevices(count: number): SyntheticDevice[] {
  const devices: SyntheticDevice[] = [];

  while (devices.length < count) {
    const uid = crypto.getRandomValues(new Uint8Array(16));
    // 0xff 0xff keeps a synthetic uid from ever colliding with a factory row in the same file.
    uid[0] = 0xff;
    uid[1] = 0xff;

    const priv = crypto.getRandomValues(new Uint8Array(32));
    devices.push({ uid, priv: bytesToHex(priv), pub: secp256k1.getPublicKey(priv, true) });
  }

  return devices;
}

// 64-byte header, sorted rows padded to a power of two, 64-byte signature over SHA256 of everything
// before it — docs/format.md. The padding rows are zeros, which sort first.
export function buildAllowlist(devices: SyntheticDevice[], signWith: string, { salt = new Uint8Array(16).fill(0x4a), version = 20261112 } = {}): Uint8Array {
  const hashed = devices.map((device) => rowHash(salt, device.uid, device.pub)).sort(compare);
  const rowCount = Math.max(4, 2 ** Math.ceil(Math.log2(hashed.length)));
  const header = new Uint8Array(64);
  const view = new DataView(header.buffer);

  header.set(new TextEncoder().encode("SHVR"), 0);
  view.setUint16(4, 1, true);
  header[6] = 16;
  view.setUint32(8, rowCount, true);
  header.set(salt, 12);
  view.setUint32(28, version, true);

  const prefix = new Uint8Array(64 + rowCount * 32);
  prefix.set(header, 0);

  for (const [at, row] of hashed.entries()) prefix.set(row, 64 + (rowCount - hashed.length + at) * 32);

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

// Builds dev_auth response messages, well-formed and deliberately not. The encoder is only as general
// as the protocol needs; the malformed variants exist so that the verifier's refusals are tested
// rather than assumed. Ported from shell-units tests/response.mjs.

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
export const tagged = (tag: number, inner: Uint8Array): Uint8Array => U8(...head(6, tag), inner);

export interface ResponseParts {
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

// digest = SHA256(uid ‖ challenge), 64-byte compact r‖s, s left exactly as signed.
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
