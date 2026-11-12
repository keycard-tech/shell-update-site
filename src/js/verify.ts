
import { Html5Qrcode } from "html5-qrcode";
import QRious from "qrious";
import trust from "../../trust.json";
import { Allowlist, loadDatabase, NotRegistered, Refusal, verifyDeviceResponse } from "./shvr/db.ts";
import { encodeDevAuthInit } from "./shvr/cbor.ts";
import { DEV_AUTH_TYPE, urDecode, urEncode } from "./shvr/ur.ts";
import { TextStr } from "./text_str";
import { VerifyUtils } from "./verify_utils";

const mediaPrefix = (document.getElementById("device_verify__media-prefix") as HTMLInputElement).value;

const steps = [
  document.getElementById("kpro_web__verify-step1") as HTMLDivElement,
  document.getElementById("kpro_web__verify-step2") as HTMLDivElement,
  document.getElementById("kpro_web__verify-step3") as HTMLDivElement,
  document.getElementById("kpro_web__verify-step4") as HTMLDivElement,
];

const qrCanvas = document.getElementById("device_verify__qr") as HTMLCanvasElement;
const qrLoading = document.getElementById("device_verify__qr-loading") as HTMLDivElement;
const loadingMessage = document.getElementById("device_verify__loading-message") as HTMLSpanElement;
const nextButton = document.getElementById("device_verify__next-button") as HTMLInputElement;
const scanButton = document.getElementById("device_verify__scan-button") as HTMLInputElement;

const cameraSelector = document.getElementById("camera-selector") as HTMLSelectElement;
const cameraZoomContainer = document.getElementById("camera-zoom-container") as HTMLDivElement;
const scanningMessage = document.getElementById("device_verify__scanning-message") as HTMLSpanElement;

const resultHeading = document.getElementById("verify-result-heading") as HTMLHeadingElement;
const resultPrompt = document.getElementById("verify-result-prompt") as HTMLParagraphElement;
const resultDetail = document.getElementById("device_verify__result-detail") as HTMLDivElement;
const finishedLink = document.getElementById("device_verify__scan-finished-link") as HTMLLinkElement;
const finishedButton = document.getElementById("device_verify__scan-finished") as HTMLInputElement;

const QR_SIZE = 400;
const HIDE = "keycard_shell__display-none";

const html5QrCode = new Html5Qrcode("device_verify__qr-reader");
const verifyQR = new QRious({ element: qrCanvas });

const challenge = crypto.getRandomValues(new Uint8Array(32));

let allowlist: Allowlist | null = null;

const fetched = async (path: string): Promise<Response> => {
  const response = await fetch(mediaPrefix + path, { cache: "no-store" });

  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);

  return response;
};

const showStep = (step: number): void => steps.forEach((container, index) => container.classList.toggle(HIDE, index + 1 !== step));

// The build version the header carries is upstream's build date, written YYYYMMDD
const updatedOn = (version: number): string => `${version}`.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");

function finish(heading: string, prompt: string, reason: string, button: string, follow: () => void): void {
  void VerifyUtils.stopScanning(html5QrCode);

  const updated = allowlist === null ? "" : TextStr.producedUnitsListUpdated(updatedOn(allowlist.version));

  resultHeading.innerText = heading;
  resultPrompt.innerText = prompt;
  resultDetail.innerText = [reason, updated].filter(Boolean).join(" · ");
  finishedButton.value = button;
  finishedLink.href = "";
  finishedLink.onclick = follow;

  showStep(4);
}

const tryAgain = (reason: string) => finish(TextStr.verifyErrorHeading, TextStr.verifyErrorPrompt, reason, TextStr.btnTryAgain, () => location.reload());

function ready(): void {
  qrCanvas.classList.remove("keycard_shell__qr-blurred");
  qrLoading.classList.add(HIDE);
  nextButton.disabled = false;
}

function blocked(reason: string): void {
  loadingMessage.innerText = reason;
  nextButton.value = TextStr.btnTryAgain;
  nextButton.disabled = false;
  nextButton.onclick = () => location.reload();
}

async function loadAllowlist(): Promise<void> {
  let named: { variants: { path: string }[] };

  try {
    named = await (await fetched("get-units.json")).json();

    if (named.variants?.[0]?.path === undefined) throw new Error("get-units.json names no file");
    allowlist = loadDatabase(new Uint8Array(await (await fetched(named.variants[0].path)).arrayBuffer()), trust.unitsVerifyKey);
  } catch (err) {
    return blocked(`${err instanceof Refusal ? TextStr.allowlistRefused : TextStr.allowlistAbsent} ${err}`);
  }

  ready();
}

async function handleCode(text: string): Promise<void> {
  await VerifyUtils.stopScanning(html5QrCode);

  if (allowlist === null) return tryAgain("the produced units list had not been verified when this code arrived");

  let payload: Uint8Array;

  try {
    payload = urDecode(text, DEV_AUTH_TYPE);
  } catch (err) {
    return tryAgain(String(err));
  }

  try {
    verifyDeviceResponse(allowlist, challenge, payload);

    finish(TextStr.verifyAuthenticHeading, TextStr.verifyAuthenticPrompt, "", TextStr.btnDone, () => {
      window.location.assign("./");
    });
  } catch (err) {
    if (err instanceof NotRegistered) {
      return finish(TextStr.verifyNotRegisteredHeading, TextStr.verifyNotRegisteredPrompt, "", TextStr.btnLearnMore, () => {
        window.location.assign("https://keycard.tech/help/verify-keycard-shell-authenticity");
      });
    }

    return tryAgain(err instanceof Refusal ? err.message : String(err));
  }
}

async function startCamera(cameraId: string): Promise<void> {
  if (allowlist === null) return;

  showStep(3);
  scanningMessage.innerText = TextStr.scanning;

  try {
    await VerifyUtils.startScanning(html5QrCode, cameraId, (text) => void handleCode(text), cameraZoomContainer);
  } catch (err) {
    void VerifyUtils.stopScanning(html5QrCode);
    tryAgain(String(err));
  }
}

const scanWithSelectedCamera = async (): Promise<void> => startCamera(await VerifyUtils.handleCamerasSelector(cameraSelector));

cameraSelector.addEventListener("change", async () => {
  await VerifyUtils.stopScanning(html5QrCode);
  await startCamera(cameraSelector.value);
});

nextButton.addEventListener("click", async () => {
  if (nextButton.onclick !== null) return; // blocked() turned this button into a reload

  if (await VerifyUtils.videoPermissionsGranted()) {
    steps[0].classList.add(HIDE);
    await scanWithSelectedCamera();
  } else {
    showStep(2);
  }
});

scanButton.addEventListener("click", () => void scanWithSelectedCamera());

window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  tryAgain(String(event.reason));
});

verifyQR.set({ size: QR_SIZE, value: urEncode(DEV_AUTH_TYPE, encodeDevAuthInit(challenge)) });
void loadAllowlist();
