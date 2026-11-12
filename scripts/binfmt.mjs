// The layout of the images a Shell is flashed with, per keycard-shell/tools/common.py and
// keycard-eth-db/tools/shell-db.py, and of the SHVR allowlist, per keycard-tech/shell-units
// docs/format.md and tools/shvr.py.

import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";

export const PAGE_SIZE = 8192;
export const FW_PAGE_COUNT = 76;
export const FW_IV_SIZE = 588;
export const SIG_SIZE = 64;

// The firmware header is the signature over the image, then four version bytes: major, minor, patch, flags.
export const FW_VERSION_OFFSET = FW_IV_SIZE + SIG_SIZE;
export const FW_FLAGS = FW_VERSION_OFFSET + 3;

// keycard-eth-db writes the database header with struct.pack("<HHI", 0x4532, 4, version).
export const DB_MAGIC = 0x4532;
export const DB_FORMAT = 4;

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const sha256Bytes = (data) => createHash("sha256").update(data).digest();

// The digest the bootloader verifies: the image padded to 76 pages minus its 64 signature bytes, not a sha256sum of the file.
export const flashImage = (image) => {
  const padded = Buffer.alloc(PAGE_SIZE * FW_PAGE_COUNT, 0xff);
  image.copy(padded);

  return sha256(Buffer.concat([padded.subarray(0, FW_IV_SIZE), padded.subarray(FW_IV_SIZE + SIG_SIZE)]));
};

export const firmwareVersion = (image) => [...image.subarray(FW_VERSION_OFFSET, FW_VERSION_OFFSET + 3)].join(".");
export const firmwareFlags = (image) => image[FW_FLAGS];

export const databaseMagic = (file) => file.readUInt16LE(0);
export const databaseFormat = (file) => file.readUInt16LE(2);
export const databaseVersion = (file) => String(file.readUInt32LE(4));

// The SHVR allowlist, per keycard-tech/shell-units docs/format.md and tools/shvr.py. Row length is the
// output size of SHA-256 and so is not written to the file: another hash function would be another format.
export const UNITS_MAGIC = "SHVR";
export const UNITS_FORMAT = 1;
export const UNITS_HEADER_SIZE = 64;
export const UNITS_INDEX_LEN = 32;
export const UNITS_UID_LEN = 16;

// The six fields the header writes — magic, format version, uid_len, row_count, salt, build version — with
// the refusals in the order the spec reads them. The rest of the 64 bytes stay zero, so giving one a meaning
// is a version bump rather than a reader silently reinterpreting a file an older reader accepted. No crypto,
// so the fields stay readable without the pinned key.
export const unitsHeader = (file) => {
  if (file.length < UNITS_HEADER_SIZE + SIG_SIZE) throw new Error("too short to be an allowlist");
  if (file.subarray(0, 4).toString("ascii") !== UNITS_MAGIC) throw new Error(`magic is ${JSON.stringify(file.subarray(0, 4).toString("ascii"))}, not ${UNITS_MAGIC}`);

  const format = file.readUInt16LE(4);
  if (format !== UNITS_FORMAT) throw new Error(`format version is ${format}, not ${UNITS_FORMAT}`);

  const uidLen = file[6];
  if (uidLen !== UNITS_UID_LEN) throw new Error(`uid length is ${uidLen}, not ${UNITS_UID_LEN}`);
  if (file[7] !== 0 || file.subarray(32, UNITS_HEADER_SIZE).some((byte) => byte !== 0)) {
    throw new Error("reserved header bytes are not zero");
  }

  const rowCount = file.readUInt32LE(8);
  const expected = UNITS_HEADER_SIZE + rowCount * UNITS_INDEX_LEN + SIG_SIZE;
  if (file.length !== expected) throw new Error(`${file.length} bytes, header describes ${expected}`);
  if (rowCount === 0) throw new Error("empty row array");

  // row_count includes padding rows and is not a device count; it is reported to whoever runs the sync,
  // never to a visitor.
  return { version: String(file.readUInt32LE(28)), rowCount, salt: file.subarray(12, 28).toString("hex") };
};

// Every rule shell-units' own reader applies before it will search a file, so that the file we mirror is
// one a browser will not refuse. The signature is the only attestation that a row was provisioned, so a
// file that does not verify against the pinned key carries no information at all.
export const readUnits = (file, verifyKey) => {
  const header = unitsHeader(file);
  const prefix = file.subarray(0, file.length - SIG_SIZE);
  const signature = file.subarray(file.length - SIG_SIZE);

  let verified = false;
  try {
    verified = secp256k1.verify(signature, sha256Bytes(prefix), Buffer.from(verifyKey, "hex"), { prehash: false, lowS: false });
  } catch (err) {
    throw new Error(`signature could not be read: ${err.message}`);
  }
  if (!verified) throw new Error("signature does not match the pinned key");

  const rows = file.subarray(UNITS_HEADER_SIZE, UNITS_HEADER_SIZE + header.rowCount * UNITS_INDEX_LEN);
  for (let row = 1; row < header.rowCount; row++) {
    // Padding rows repeat, so only a decrease is a violation.
    const descending = rows.compare(rows, row * UNITS_INDEX_LEN, (row + 1) * UNITS_INDEX_LEN, (row - 1) * UNITS_INDEX_LEN, row * UNITS_INDEX_LEN);
    if (descending > 0) throw new Error(`rows are not sorted at ${row}`);
  }

  return header;
};
