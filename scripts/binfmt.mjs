// Image layouts per keycard-shell tools/common.py and keycard-eth-db tools/shell-db.py; the Node counterpart of src/js/shvr/db.ts, kept independent so the check asks whether shell-units' own reader accepts what we mirrored

import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
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
} from "../src/js/shvr/format.ts";

export { SIG_SIZE };

const PAGE_SIZE = 8192;
const FW_PAGE_COUNT = 76;
const FW_IV_SIZE = 588;
const FW_VERSION_OFFSET = FW_IV_SIZE + SIG_SIZE;

// keycard-eth-db writes its header with struct.pack("<HHI", 0x4532, 4, version)
export const DB_MAGIC = 0x4532;
export const DB_FORMAT = 4;

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const sha256Bytes = (data) => createHash("sha256").update(data).digest();

// The digest the bootloader verifies: the image padded to 76 pages, minus its signature bytes — not a sha256sum of the file
export const flashImage = (image) => {
  const padded = Buffer.alloc(PAGE_SIZE * FW_PAGE_COUNT, 0xff);

  image.copy(padded);

  return sha256(Buffer.concat([padded.subarray(0, FW_IV_SIZE), padded.subarray(FW_IV_SIZE + SIG_SIZE)]));
};

export const firmwareVersion = (image) => [...image.subarray(FW_VERSION_OFFSET, FW_VERSION_OFFSET + 3)].join(".");

export const databaseMagic = (file) => asBuffer(file).readUInt16LE(0);
export const databaseFormat = (file) => asBuffer(file).readUInt16LE(2);
export const databaseVersion = (file) => String(asBuffer(file).readUInt32LE(4));

// Buffer methods read these formats, so a plain Uint8Array is viewed as a Buffer rather than mishandled
const asBuffer = (file) => (Buffer.isBuffer(file) ? file : Buffer.from(file.buffer, file.byteOffset, file.byteLength));

export const unitsHeader = (file) => {
  const bytes = asBuffer(file);

  if (bytes.length < HEADER_SIZE + SIG_SIZE) throw new Error("too short to be an allowlist");

  const magic = bytes.subarray(0, MAGIC.length).toString("ascii");

  if (magic !== MAGIC) throw new Error(`magic is ${JSON.stringify(magic)}, not ${MAGIC}`);

  const format = bytes.readUInt16LE(FORMAT_OFFSET);

  if (format !== FORMAT_VERSION) throw new Error(`format version is ${format}, not ${FORMAT_VERSION}`);

  const uidLen = bytes[UID_LEN_OFFSET];

  if (uidLen !== UID_LEN) throw new Error(`uid length is ${uidLen}, not ${UID_LEN}`);
  if (bytes[UID_LEN_OFFSET + 1] !== 0 || bytes.subarray(BUILD_VERSION_OFFSET + 4, HEADER_SIZE).some((byte) => byte !== 0)) {
    throw new Error("reserved header bytes are not zero");
  }

  const rowCount = bytes.readUInt32LE(ROW_COUNT_OFFSET);

  if (bytes.length !== fileLength(rowCount)) throw new Error(`${bytes.length} bytes, header describes ${fileLength(rowCount)}`);
  if (rowCount === 0) throw new Error("empty row array");

  // row_count counts padding rows and is not a device count: reported to whoever runs the sync, never to a visitor
  return { version: String(bytes.readUInt32LE(BUILD_VERSION_OFFSET)), rowCount, salt: bytes.subarray(SALT_OFFSET, SALT_OFFSET + SALT_LEN).toString("hex") };
};

// Every rule shell-units' own reader applies before it will search a file
export const readUnits = (file, verifyKey) => {
  const bytes = asBuffer(file);
  const header = unitsHeader(bytes);
  const signature = bytes.subarray(bytes.length - SIG_SIZE);

  let verified = false;

  try {
    verified = secp256k1.verify(signature, sha256Bytes(bytes.subarray(0, bytes.length - SIG_SIZE)), Buffer.from(verifyKey, "hex"), { prehash: false, lowS: false });
  } catch (err) {
    throw new Error(`signature could not be read: ${err.message}`);
  }

  if (!verified) throw new Error("signature does not match the pinned key");

  const rows = bytes.subarray(HEADER_SIZE, bytes.length - SIG_SIZE);

  for (let row = 1; row < header.rowCount; row++) {
    // Padding rows repeat, so only a decrease is a violation
    if (rows.compare(rows, row * ROW_LEN, (row + 1) * ROW_LEN, (row - 1) * ROW_LEN, row * ROW_LEN) > 0) throw new Error(`rows are not sorted at ${row}`);
  }

  return header;
};
