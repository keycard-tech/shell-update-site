
import { CameraDevice, Html5Qrcode } from "html5-qrcode";
import { UIUtils } from "./ui_utils";

export namespace VerifyUtils {
  export async function videoPermissionsGranted(): Promise<boolean> {
    try {
      // Safari and Firefox throw on a "camera" permission name, and a question that could not be asked is not a grant
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
    if (!html5QrCode.isScanning) return;

    const constraints = { focusMode: "continuous", advanced: [{ zoom: zoomVal } as MediaTrackConstraintSet] } as MediaTrackConstraints;

    await html5QrCode.applyVideoConstraints(constraints).catch(() => undefined);
  }

  function handleCameraZoom(html5QrCode: Html5Qrcode, container: HTMLDivElement): void {
    const cameraZoom = html5QrCode.getRunningTrackCameraCapabilities().zoomFeature();

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

    await html5QrCode.start({ deviceId: { exact: cameraId } }, config, async (decodedText: string) => await onCode(decodedText), () => undefined);

    handleCameraZoom(html5QrCode, zoomContainer);
  }
}
