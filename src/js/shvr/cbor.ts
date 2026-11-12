import { Refusal } from "./errors.ts";

class CborError extends Refusal {}

class Reader {
  b: Uint8Array;
  o = 0;

  constructor(bytes: Uint8Array) {
    this.b = bytes;
  }

  get done(): boolean {
    return this.o === this.b.length;
  }

  byte(): number {
    if (this.o >= this.b.length) throw new CborError("truncated");

    return this.b[this.o++];
  }

  // The additional info low byte of a head; `a` carries the major type and short
  head(major: number): number {
    const ib = this.byte();

    if (ib >> 5 !== major) throw new CborError(`expected major type ${major}, got ${ib >> 5}`);

    const low = ib & 0x1f;

    if (low === 31) throw new CborError("indefinite length is not canonical");
    if (low < 24) return low;

    const n = 1 << (low - 24);

    if (n > 8) throw new CborError("reserved additional info");
    if (this.o + n > this.b.length) throw new CborError("truncated head");

    let v = 0;

    for (let i = 0; i < n; i++) v = v * 256 + this.b[this.o + i];
    if (v < 2 ** (8 * (n - 1))) throw new CborError("non-minimal integer encoding");

    this.o += n;

    return v;
  }

  uint(): number {
    return this.head(0);
  }

  bytes(): Uint8Array {
    const n = this.head(2);

    if (this.o + n > this.b.length) throw new CborError("truncated byte string");

    const out = this.b.subarray(this.o, this.o + n);

    this.o += n;

    return out;
  }

  map(onEntry: (key: number, reader: Reader) => void): number {
    const n = this.head(5);

    for (let i = 0; i < n; i++) onEntry(this.uint(), this);

    return n;
  }

  tagged(tag: number): void {
    const v = this.head(6);

    if (v !== tag) throw new CborError(`expected tag ${tag}, got ${v}`);
  }
}

export type DevAuthFields = Map<number, Uint8Array | number>;

export function decodeDevAuth(bytes: Uint8Array): { entries: number[]; fields: DevAuthFields } {
  const r = new Reader(bytes);
  const seen: number[] = [];
  const found: DevAuthFields = new Map();

  r.map((key, reader) => {
    if (found.has(key)) throw new CborError(`duplicate map key ${key}`);

    let value: Uint8Array | number;

    if (key === 1) {
      value = reader.uint();
    } else if (key === 2) {
      reader.tagged(37);
      value = reader.bytes();
    } else if (key === 3 || key === 4 || key === 5) {
      value = reader.uint();
      found.set(key, value);
      seen.push(key);

      return;
    } else if (key === 6 || key === 7) {
      value = reader.bytes();
    } else {
      throw new CborError(`unknown map key ${key}`);
    }

    found.set(key, value);
    seen.push(key);
  });

  if (!r.done) throw new CborError("trailing bytes after the map");

  return { entries: seen, fields: found };
}

export function encodeDevAuthInit(challenge: Uint8Array): Uint8Array {
  const body: number[] = [0xa2, 0x01, 0x01, 0x06, 0x58, 0x20];

  body.push(...challenge);

  return Uint8Array.from(body);
}
