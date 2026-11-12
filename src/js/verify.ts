// Ported from keycard-shell-webapp assets/javascript/device.ts: the same four steps, the same containers,
// the same camera handling. What changed is who answers. The old page posted the device's response to
// keycard.tech and displayed the verdict that came back, then drew a QR of its own for the Shell to scan
// so the Shell could check the site. This page holds the allowlist itself — fetched from this site,
// authenticated against the pinned provisioning key — and answers here. There is no verdict arriving from
// somewhere else, and so nothing for a second QR to say.

import { Html5Qrcode } from "html5-qrcode";
import QRious from "qrious";
import trust from "../../trust.json";
import { Allowlist, loadDatabase, NotRegistered, Refusal, verifyDeviceResponse } from "./shvr/db.ts";
import { DEV_AUTH_TYPE, urDecode, urEncode } from "./shvr/ur.ts";
import { QRUtils } from "./qr_utils";
import { TextStr } from "./text_str";
import { VerifyUtils } from "./verify_utils";

const mediaPrefix = (document.getElementById("device_verify__media-prefix") as HTMLInputElement).value;

const step1Container = document.getElementById("kpro_web__verify-step1") as HTMLDivElement;
const step2Container = document.getElementById("kpro_web__verify-step2") as HTMLDivElement;
const step3Container = document.getElementById("kpro_web__verify-step3") as HTMLDivElement;
const step4Container = document.getElementById("kpro_web__verify-step4") as HTMLDivElement;

const qrCanvas = document.getElementById("device_verify__qr") as HTMLCanvasElement;
const qrLoading = document.getElementById("device_verify__qr-loading") as HTMLDivElement;
const loadingMessage = document.getElementById("device_verify__loading-message") as HTMLSpanElement;
const nextButton = document.getElementById("device_verify__next-button") as HTMLInputElement;

const cameraSelector = document.getElementById("camera-selector") as HTMLSelectElement;
const cameraZoomContainer = document.getElementById("camera-zoom-container") as HTMLDivElement;
const scanningMessage = document.getElementById("device_verify__scanning-message") as HTMLSpanElement;

const verifyResultHeading = document.getElementById("verify-result-heading") as HTMLHeadingElement;
const verifyResultPrompt = document.getElementById("verify-result-prompt") as HTMLParagraphElement;
const resultDetail = document.getElementById("device_verify__result-detail") as HTMLDivElement;
const scanFinishedButtonLink = document.getElementById("device_verify__scan-finished-link") as HTMLLinkElement;
const scanFinishedButton = document.getElementById("device_verify__scan-finished") as HTMLInputElement;

const QR_SIZE = 400;

const html5QrCode = new Html5Qrcode("device_verify__qr-reader");
const verifyQR = new QRious({ element: qrCanvas });

// The challenge is made now, at load, and lives only here: freshness is the one thing standing between a
// captured transcript and an accepted one, so nothing caches, derives or reuses it.
const challenge = crypto.getRandomValues(new Uint8Array(32));

let allowlist: Allowlist | null = null;

function showStep(step: 1 | 2 | 3 | 4): void {
  [step1Container, step2Container, step3Container, step4Container].forEach((container, index) => {
    container.classList.toggle("keycard_shell__display-none", index + 1 !== step);
  });
}

// The sentence is for whoever is holding the Shell. The line under it is for the conversation that
// follows if the sentence was not the one they hoped for: which list was checked, and what it matched.
const allowlistNote = () => (allowlist === null ? "" : ` · allowlist ${allowlist.version}`);

function finish(heading: string, prompt: string, detail: string, button: string, follow: () => void): void {
  void VerifyUtils.stopScanning(html5QrCode);

  verifyResultHeading.innerText = heading;
  verifyResultPrompt.innerText = prompt;
  resultDetail.innerText = detail;
  scanFinishedButton.value = button;
  scanFinishedButtonLink.href = "";
  // onclick rather than addEventListener: the old page added a listener on every failure, so by the
  // third failure the button reloaded the page three times over.
  scanFinishedButtonLink.onclick = follow;

  showStep(4);
}

const tryAgain = (detail: string) => finish(TextStr.verifyErrorHeading, TextStr.verifyErrorPrompt, detail, TextStr.btnTryAgain, () => location.reload());

// The QR is drawn before the allowlist arrives, blurred, and unblurs when the file has authenticated:
// the challenge does not depend on the file, and a Shell that has already answered should not be wasted
// by a slow download. Nothing scans out of a blurred code, and Continue stays disabled until then.
function ready(): void {
  qrCanvas.classList.remove("keycard_shell__qr-blurred");
  qrLoading.classList.add("keycard_shell__display-none");
  nextButton.disabled = false;
}

// No step of its own for a site that cannot serve its own file: the message goes where the loading
// message was, and the one button becomes the retry.
function blocked(reason: string): void {
  loadingMessage.innerText = reason;
  nextButton.value = TextStr.btnTryAgain;
  nextButton.disabled = false;
  nextButton.onclick = () => location.reload();
}

async function loadAllowlist(): Promise<void> {
  let served: { version: string; variants: { id: string; path: string; hash: string }[] };

  try {
    const document = await fetch(`${mediaPrefix}get-units.json`, { cache: "no-store" });

    if (!document.ok) throw new Error(`get-units.json: HTTP ${document.status}`);

    served = await document.json();

    if (served.variants?.[0]?.path === undefined) throw new Error("get-units.json names no file");
  } catch (err) {
    // Nothing to check against. Not a device's problem, and not something to send a Shell to scan.
    return blocked(`${TextStr.allowlistAbsent} ${err}`);
  }

  try {
    const file = await fetch(mediaPrefix + served.variants[0].path, { cache: "no-store" });

    if (!file.ok) throw new Error(`${served.variants[0].path}: HTTP ${file.status}`);

    allowlist = loadDatabase(new Uint8Array(await file.arrayBuffer()), trust.unitsVerifyKey);
  } catch (err) {
    // A refusal is the file failing its own signature or its format, which is a different fact from the
    // file not being there, and neither is a fact about any Shell.
    return blocked(`${TextStr.allowlistRefused} ${err}`);
  }

  ready();
}

async function handleCode(text: string): Promise<void> {
  // The light goes out before anything is computed: no reason to hold a camera open through a verdict,
  // and no way for a second scan to arrive over the top of the first.
  await VerifyUtils.stopScanning(html5QrCode);

  if (allowlist === null) return tryAgain("the allowlist had not been verified when this code arrived");

  let payload: Uint8Array;

  try {
    payload = urDecode(text, DEV_AUTH_TYPE);
  } catch (err) {
    return tryAgain(String(err));
  }

  try {
    const device = verifyDeviceResponse(allowlist, challenge, payload);

    // The key that matched is what a support conversation is actually about, and it is nowhere else.
    finish(TextStr.verifyAuthenticHeading, TextStr.verifyAuthenticPrompt, `pubkey ${device.hex}${allowlistNote()}`, TextStr.btnDone, () => {
      window.location.assign("./");
    });
  } catch (err) {
    if (err instanceof NotRegistered) {
      // A well-formed response, correctly signed, from a key with no row: the device said what a device
      // says, and this list has nothing for it. Not the same sentence as a fault in the exchange.
      return finish(TextStr.verifyNotRegisteredHeading, TextStr.verifyNotRegisteredPrompt, `uid ${err.uid}${allowlistNote()}`, TextStr.btnLearnMore, () => {
        window.location.assign("https://keycard.tech/docs/overview");
      });
    }

    if (err instanceof Refusal) {
      return tryAgain(`${err.message}${allowlistNote()}`);
    }

    return tryAgain(String(err));
  }
}

async function startScanning(cameraId: string): Promise<void> {
  // Continue is disabled until the allowlist authenticates, so this is not reachable by clicking; it
  // stays checked because the camera changing hands fires the same handler from the selector.
  if (allowlist === null) return;

  showStep(3);
  scanningMessage.innerText = TextStr.scanning;

  try {
    await VerifyUtils.startScanning(html5QrCode, cameraId, (text) => void handleCode(text), cameraZoomContainer);
  } catch (err) {
    // Denied, unplugged, or already held by another app: the same dead end whatever the reason, and the
    // one thing not to do is leave the page sitting on a camera that never started.
    void VerifyUtils.stopScanning(html5QrCode);
    tryAgain(String(err));
  }
}

cameraSelector.addEventListener("change", async () => {
  await VerifyUtils.stopScanning(html5QrCode);
  await startScanning(cameraSelector.value);
});

nextButton.addEventListener("click", async () => {
  if (nextButton.onclick !== null) return; // the blocked path turned this button into a reload

  if (await VerifyUtils.videoPermissionsGranted()) {
    step1Container.classList.add("keycard_shell__display-none");
    await startScanning(await VerifyUtils.handleCamerasSelector(cameraSelector));
  } else {
    showStep(2);
  }
});

(document.getElementById("device_verify__scan-button") as HTMLInputElement).addEventListener("click", async () => {
  await startScanning(await VerifyUtils.handleCamerasSelector(cameraSelector));
});

// A verifier whose failures are invisible gets guessed at, and the guess is usually that the Shell is
// broken: handleCode is async, so anything thrown inside it is a rejected promise, silent by itself.
window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  tryAgain(String(event.reason));
});

QRUtils.displayQr(urEncode(DEV_AUTH_TYPE, QRUtils.encodeChallenge(challenge)), verifyQR, QR_SIZE);
void loadAllowlist();
