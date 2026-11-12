// Ported from keycard-shell-webapp assets/javascript/qr_utils.ts, the page that shipped this flow. The
// canvas drawing is the old one, because that is the QR the Shell's camera is known to resolve; what
// changed is what goes into it — one bytewords part from src/js/shvr/ur.ts rather than a fragment of a
// fountain encoder, and Uint8Array rather than Buffer.

import QRious from "qrious";
import { encodeDevAuthInit } from "./shvr/cbor.ts";

export namespace QRUtils {
  export function displayQr(text: string, qrCanv: QRious, size: number): void {
    qrCanv.set({ size, value: text });
  }

  // The challenge as the firmware asks for it: a two-entry CBOR map, {"1": 1, "6": h'<32 bytes>'}.
  // Pinned byte for byte in test/verify.test.ts, so this cannot drift from the device unnoticed.
  export function encodeChallenge(challenge: Uint8Array): Uint8Array {
    return encodeDevAuthInit(challenge);
  }
}
