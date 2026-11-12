declare module "qrious" {
  export interface QRiousOptions {
    element?: HTMLCanvasElement | HTMLImageElement | null;
    value?: string;
    size?: number;
    padding?: number | null;
    level?: "L" | "M" | "Q" | "H";
    foreground?: string;
    background?: string;
    mime?: string;
  }

  export default class QRious {
    constructor(options?: QRiousOptions);
    set(options: QRiousOptions): void;
    update(): void;
    toDataURL(mime?: string): string;
    readonly canvas: HTMLCanvasElement;
    value: string;
    size: number;
    padding: number | null;
  }
}
