// Ported from keycard-shell-webapp assets/javascript/verify_utils.ts: the same camera plumbing, at the
// same settings (10 fps, a 600px box, square aspect), with the same zoom slider and the same habit of
// switching the camera off before the code is read — that combination is what was tried against real
// Shell screens. What used to be a POST to the site's own verify endpoint is a callback now, because the
// answer is checked here against the mirrored allowlist.

import { CameraDevice, Html5Qrcode } from "html5-qrcode";
import { UIUtils } from "./ui_utils";

export namespace VerifyUtils {
  export async function videoPermissionsGranted(): Promise<boolean> {
    try {
      // 'camera' is not a permission name everywhere — Safari and Firefox throw on it — and a question
      // that could not be asked is not a grant. The caller then shows the enable-camera step, which is
      // the safe answer on a browser this page has never been tried against.
      return (await navigator.permissions.query({ name: "camera" as PermissionName })).state === "granted";
    } catch {
      return false;
    }
  }

  export async function handleCamerasSelector(cameraSelector: HTMLSelectElement): Promise<string> {
    return await Html5Qrcode.getCameras().then((cameras: CameraDevice[]) => {
      UIUtils.addCameraSelectOption(cameraSelector, cameras);
      return cameraSelector.value;
    });
  }

  async function zoom(html5QrCode: Html5Qrcode, zoomVal: number): Promise<void> {
    if (html5QrCode.isScanning) {
      // focusMode is a Chromium constraint the DOM types do not declare; without continuous focus the
      // camera hunts for focus on every zoom change and the QR blurs at exactly the moment it is needed.
      const constraints = { focusMode: "continuous", advanced: [{ zoom: zoomVal } as MediaTrackConstraintSet] } as MediaTrackConstraints;

      // A camera that refuses the constraint leaves the slider doing nothing, which is what a slider
      // beside a working zoom means in every other app: no reason to interrupt a verification for it.
      await html5QrCode.applyVideoConstraints(constraints).catch(() => undefined);
    }
  }

  function handleCameraZoom(html5QrCode: Html5Qrcode, container: HTMLDivElement): void {
    const cameraZoom = html5QrCode.getRunningTrackCameraCapabilities().zoomFeature();

    // parseFloat, not the parseInt the old page used: phone cameras report steps like 0.1, and reading
    // them as integers puts the slider one whole zoom level behind where it was left.
    if (cameraZoom.isSupported()) {
      UIUtils.handleZoomUI(cameraZoom.value(), cameraZoom.min(), cameraZoom.max(), cameraZoom.step(), container, (val: string) => {
        void zoom(html5QrCode, parseFloat(val));
      });
    }
  }

  export async function stopScanning(html5QrCode: Html5Qrcode): Promise<void> {
    if (html5QrCode.isScanning) {
      await html5QrCode.stop();
      html5QrCode.clear();
    }
  }

  export async function startScanning(html5QrCode: Html5Qrcode, cameraId: string, onCode: (text: string) => void, zoomContainer: HTMLDivElement): Promise<void> {
    const config = { fps: 10, qrbox: 600, aspectRatio: 1 };

    // The failure callback is invoked for every frame with no code in it, which is most of them.
    await html5QrCode.start({ deviceId: { exact: cameraId } }, config, async (decodedText: string) => await onCode(decodedText), () => undefined);

    handleCameraZoom(html5QrCode, zoomContainer);
  }
}
