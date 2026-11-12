export const MAGIC = "SHVR";
export const FORMAT_VERSION = 1;
export const HEADER_SIZE = 64;
export const SIG_SIZE = 64;
export const UID_LEN = 16;
export const SALT_LEN = 16;

// "SHVR" | format u16 | uid_len u8 | reserved u8 | row_count u32 | reserved u32 | salt | build u32 | zero to 64

export const FORMAT_OFFSET = 4;
export const UID_LEN_OFFSET = 6;
export const ROW_COUNT_OFFSET = 8;
export const SALT_OFFSET = 12;
export const BUILD_VERSION_OFFSET = 28;

// A row is a SHA-256 digest, so its length comes from the hash and is never written to the file
export const ROW_LEN = 32;

export const rowsLength = (rowCount: number) => HEADER_SIZE + rowCount * ROW_LEN;
export const fileLength = (rowCount: number) => rowsLength(rowCount) + SIG_SIZE;
