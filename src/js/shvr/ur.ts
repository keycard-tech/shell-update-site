import { decodeBytewords, encodeBytewords } from "@blockchaincommons/uniform-resources/bytewords";

export { decodeBytewords, encodeBytewords };

export const DEV_AUTH_TYPE = "DEV-AUTH";

export function urEncode(type: string, payload: Uint8Array): string {
  return `UR:${type}/${encodeBytewords(payload, "minimal")}`;
}

export function urDecode(text: string, expectedType: string): Uint8Array {
  const match = /^(UR):([a-z0-9-]+)\/([a-z]+)$/i.exec(text.trim());

  if (!match) throw new Error("not a UR: expected UR:<type>/<bytewords>");
  if (match[2].toUpperCase() !== expectedType.toUpperCase()) throw new Error(`expected UR:${expectedType}/, got UR:${match[2]}/`);

  try {
    return decodeBytewords(match[3].toLowerCase(), "minimal");
  } catch (err) {
    throw new Error(`bytewords payload rejected: ${err instanceof Error ? err.message : String(err)}`);
  }
}
