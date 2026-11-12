import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { decodeDevAuth } from "./cbor.ts";
import { NotRegistered, Refusal } from "./errors.ts";
import {
  BUILD_VERSION_OFFSET,
  FORMAT_OFFSET,
  FORMAT_VERSION,
  HEADER_SIZE,
  MAGIC,
  ROW_COUNT_OFFSET,
  ROW_LEN,
  SALT_LEN,
  SALT_OFFSET,
  SIG_SIZE,
  UID_LEN,
  UID_LEN_OFFSET,
  fileLength,
} from "./format.ts";

export { NotRegistered, Refusal };

const TAG_UID = new TextEncoder().encode("ShellUID");
const TAG_PUBKEY = new TextEncoder().encode("ShellPubKey");
const N = secp256k1.Point.Fn.ORDER;

export interface Allowlist {
  salt: Uint8Array;
  version: number;
  rowCount: number;
  uidLen: number;
  rows: Uint8Array;
  digest: Uint8Array;
  prefix: Uint8Array;
}

// A row holds neither id alone: the uid arrives in the response and the pubkey is recovered from the signature over it
export function rowHash(salt: Uint8Array, uid: Uint8Array, pubkey: Uint8Array): Uint8Array {
  return sha256(concatBytes(salt, TAG_UID, uid, TAG_PUBKEY, pubkey));
}

export function findRow(db: Allowlist, hash: Uint8Array): number {
  const rows = db.rows;
  let lo = 0;
  let hi = db.rowCount - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = mid * ROW_LEN;
    let cmp = 0;

    for (let i = 0; i < ROW_LEN; i++) {
      const a = rows[at + i];
      const b = hash[i];
      if (a !== b) {
        cmp = a < b ? -1 : 1;
        break;
      }
    }

    if (cmp === 0) return mid;
    if (cmp < 0) lo = mid + 1;
    else hi = mid - 1;
  }

  return -1;
}

export function loadDatabase(buffer: ArrayBuffer | Uint8Array, verifyKey: string): Allowlist {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  if (bytes.length < HEADER_SIZE + SIG_SIZE) throw new Refusal("file too short to be a database");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, length: number) => new TextDecoder().decode(bytes.subarray(offset, offset + length));

  if (text(0, MAGIC.length) !== MAGIC) throw new Refusal("not an SHVR database");

  const format = view.getUint16(FORMAT_OFFSET, true);

  if (format !== FORMAT_VERSION) throw new Refusal(`unsupported format version ${format}`);

  const uidLen = bytes[UID_LEN_OFFSET];
  const rowCount = view.getUint32(ROW_COUNT_OFFSET, true);
  const salt = bytes.subarray(SALT_OFFSET, SALT_OFFSET + SALT_LEN);
  const version = view.getUint32(BUILD_VERSION_OFFSET, true);

  if (uidLen !== UID_LEN) throw new Refusal(`unsupported uid length ${uidLen}`);

  // Reserved bytes stay zero, so giving one a meaning is a version bump rather than a silent reinterpretation
  if (bytes[UID_LEN_OFFSET + 1] !== 0 || bytes.subarray(BUILD_VERSION_OFFSET + 4, HEADER_SIZE).some((byte) => byte !== 0)) {
    throw new Refusal("reserved header bytes are not zero");
  }

  if (bytes.length !== fileLength(rowCount)) throw new Refusal(`file is ${bytes.length} bytes, header describes ${fileLength(rowCount)}`);
  if (rowCount === 0) throw new Refusal("empty row array");

  const prefix = bytes.subarray(0, bytes.length - SIG_SIZE);
  const signature = bytes.subarray(bytes.length - SIG_SIZE);
  const digest = sha256(prefix);

  let verified = false;

  try {
    verified = secp256k1.verify(signature, digest, hexToBytes(verifyKey), { prehash: false, lowS: false });
  } catch (err) {
    throw new Refusal(`signature could not be read: ${(err as Error).message}`);
  }

  if (!verified) throw new Refusal("signature does not match the pinned key");

  const rows = bytes.subarray(HEADER_SIZE, bytes.length - SIG_SIZE);

  for (let i = 1; i < rowCount; i++) {
    for (let j = 0; j < ROW_LEN; j++) {
      const prev = rows[(i - 1) * ROW_LEN + j];
      const cur = rows[i * ROW_LEN + j];

      if (prev === cur) continue;
      if (prev > cur) throw new Refusal(`rows are not sorted at ${i}`);

      break;
    }
  }

  return { salt, version, rowCount, uidLen, rows, digest, prefix };
}

export interface VerifiedDevice {
  uid: Uint8Array;
  pubkey: Uint8Array;
  row: number;
  hex: string;
}

export function verifyDeviceResponse(db: Allowlist, challenge: Uint8Array, response: Uint8Array): VerifiedDevice {
  if (challenge.length !== 32) throw new Refusal("challenge must be 32 bytes");

  const { entries, fields } = decodeDevAuth(response);
  const expected = [1, 2, 6, 7];

  if (entries.length !== expected.length || !expected.every((key) => entries.includes(key))) {
    throw new Refusal(`response fields must be exactly 1,2,6,7 — found ${entries.sort().join(",")}`);
  }

  if (fields.get(1) !== 2) throw new Refusal(`step must be 2 (device), got ${fields.get(1)}`);

  const uid = fields.get(2) as Uint8Array;
  const signature = fields.get(7) as Uint8Array;

  if (uid.length !== db.uidLen) throw new Refusal(`dev_id is ${uid.length} bytes, database expects ${db.uidLen}`);
  if (signature.length !== 64) throw new Refusal(`auth_sig is ${signature.length} bytes, expected 64`);

  let sig;

  try {
    sig = secp256k1.Signature.fromBytes(signature);
  } catch (err) {
    throw new Refusal(`signature could not be read: ${(err as Error).message}`);
  }

  if (sig.r === 0n || sig.s === 0n || sig.r >= N || sig.s >= N) throw new Refusal("signature out of range");

  if (sig.hasHighS()) sig = new secp256k1.Signature(sig.r, N - sig.s);

  const digest = sha256(concatBytes(uid, challenge));

  // recIds 2 and 3 need the nonce point's x to exceed the curve order, about 2^-128 here: two probes are the complete set
  for (const recId of [0, 1]) {
    let pubkey: Uint8Array;

    try {
      pubkey = sig.addRecoveryBit(recId).recoverPublicKey(digest).toBytes(true);
    } catch {
      continue;
    }

    const at = findRow(db, rowHash(db.salt, uid, pubkey));

    if (at >= 0) return { uid, pubkey, row: at, hex: bytesToHex(pubkey) };
  }

  throw new NotRegistered("no row matches this uid and signature", bytesToHex(uid));
}
