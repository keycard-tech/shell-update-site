// The layout of the two images a Shell is flashed with, per keycard-shell/tools/common.py and keycard-eth-db/tools/shell-db.py.

import { createHash } from "node:crypto";

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
