import { CameraDevice } from "html5-qrcode";
import Transport from "@choppu/shelljs/lib/transport";
import { TextStr } from "./text_str";

export namespace UIUtils {
  export function handleUpdateLoadProgress(transport: Transport, loadBar: HTMLProgressElement, progressPercent: HTMLSpanElement, cbFunc: () => void) : void {
    let dataI = 0;

    if (dataI == 0) {
      dataI = 1;
      let pBarProgress = 0;
      transport.on("chunk-loaded", (progress: any) => {
        pBarProgress += progress;
        
        if (pBarProgress >= loadBar.max - progress) {
          transport.off("chunk-loaded", () => {});
          dataI = 0;
          cbFunc();
        } else {
          loadBar.value = pBarProgress;
          progressPercent.innerHTML = `${Math.round((pBarProgress / loadBar.max) * 100)} %`;
        }
      })
    }
  }

  export function addCameraSelectOption(selectField: HTMLSelectElement, cameras: CameraDevice[]) : void {
    for (const camera of cameras) {
      selectField.add(new Option(camera.label != "" ? camera.label : `Camera ${selectField.options.length + 1}`, camera.id));
    }
  }

  export function createElement(type: string, id: string, styleClass: string, parentContainer: HTMLElement, content?: string) : HTMLElement {
    const childContainer = document.createElement(type);
    childContainer.classList.add(styleClass);
    childContainer.id = id;
    childContainer.innerHTML = content ?? "";

    parentContainer.append(childContainer);

    return childContainer;
  }

  export function shortLink(link: string, maxChars: number) : string {
    return link.length <= maxChars ? link.substring(0, maxChars) : link.substring(0, maxChars) + "...";
  }

  export function parseFWVersion(version: string) : number {
    let verArr = Array.from(version.split('.'), Number);
    return (verArr[0] * 1000000) + (verArr[1] * 1000) + verArr[2];
  }

  export interface FirmwareVariant { id: string; label: string; device: number; path: string; hash: string }
  export interface FirmwareContext { version: string; variants: FirmwareVariant[] }

  export function firmwareTitle(context: FirmwareContext, variant: FirmwareVariant) : string {
    return `${context.version}-${variant.label}`;
  }

  export function getOS() : string {
    if(navigator.userAgent.includes('Mac')) {
        return 'mac';
    } else if(navigator.userAgent.includes('Windows')) {
        return 'windows';
    } else if(navigator.userAgent.includes('Linux')) {
        return 'linux';
    } else {
        return '';
    }
  }

  export function handleZoomUI(value: number | null, min: number, max: number, step: number, container: HTMLDivElement, onSliderChangeFunc: (val: string) => void) : void {
    container.innerHTML = "";
    container.classList.add("keycard_shell__zoom-container");

    const zoomSliderContainer = document.createElement("div");
    zoomSliderContainer.classList.add("keycard_shell__zoom-slider-container");

    

    const zoomPromptContainer = document.createElement("div");
    zoomPromptContainer.classList.add("keycard_shell__zoom-prompt-container");
    zoomPromptContainer.innerHTML = `<span class="keycard_shell__zoom-prompt"><span class="keycard_shell__zoom-prompt-warning">ⓘ</span> ${TextStr.zoomPrompt}</span>`

    const zoomMin = document.createElement("span");
    zoomMin.classList.add("keycard_shell__zoom-label");
    zoomMin.innerHTML = `${min}x`;

    zoomSliderContainer.appendChild(zoomMin);

    const zoomMax = document.createElement("span");
    zoomMax.classList.add("keycard_shell__zoom-label");
    zoomMax.classList.add("keycard_shell__zoom-label-right");
    zoomMax.innerHTML = `${max}x`;

    const zoomSlider = document.createElement("input");
    zoomSlider.type = "range";

    // Step unsupported on iOS, adding fallbacks for all properties
    zoomSlider.step = (step || 0.5).toString(); 
    zoomSlider.value = (value || 1.0).toString();
    zoomSlider.min = (min || 1.0).toString();
    zoomSlider.max = (max || 3.0).toString();
    zoomSlider.classList.add("keycard_shell__zoom-slider");

    zoomSliderContainer.appendChild(zoomSlider);
    zoomSliderContainer.appendChild(zoomMax);

    container.append(zoomSliderContainer);
    container.append(zoomPromptContainer);

    zoomSlider.addEventListener("change", () => onSliderChangeFunc(zoomSlider.value));
    zoomSlider.addEventListener('touchmove', () => onSliderChangeFunc(zoomSlider.value));
  }
}