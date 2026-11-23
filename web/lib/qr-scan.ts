/**
 * Scan a QR code with the phone's camera, inside the app (the PC's pairing code): no browser in
 * between, so no "not a secure connection" page. The back camera full screen with a frame; the
 * phone's own barcode reader where the WebView has one, else jsQR (Apache-2.0) on the frames.
 * Android asks for the camera the first time. Resolves with the text, or null when cancelled.
 */
import { el, icon } from "./dom.ts";

type Detector = { detect(src: CanvasImageSource): Promise<Array<{ rawValue: string }>> };

export async function scanQr(hint = "Point at the QR code"): Promise<string | null> {
  // Tartan 2: the native scanner (CameraX and ZXing), when there is one.
  const { shellScan } = await import("./shell.ts");
  const native = await shellScan(hint);
  if (native !== undefined) return native;
  return new Promise((resolve) => {
    const video = el("video", { playsinline: true, muted: true, autoplay: true }) as HTMLVideoElement;
    const status = el("p", { class: "qr-hint" }, hint);
    const cancel = el("button", { type: "button", class: "btn tonal" }, icon("close", "ic sm"), "Cancel");
    const dialog = el("dialog", { class: "qr-scan", "aria-label": "Scan a QR code" }, video, el("div", { class: "qr-frame", "aria-hidden": "true" }), el("div", { class: "qr-foot" }, status, cancel));
    let stream: MediaStream | null = null;
    let done = false;
    const finish = (text: string | null) => {
      if (done) return;
      done = true;
      stream?.getTracks().forEach((t) => t.stop());
      dialog.close();
      dialog.remove();
      resolve(text);
    };
    cancel.onclick = () => finish(null);
    dialog.addEventListener("cancel", (e) => {
      e.preventDefault();
      finish(null);
    });
    document.body.append(dialog);
    dialog.showModal();

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
      } catch (e) {
        status.textContent = /denied|NotAllowed/i.test(String((e as Error).name ?? e)) ? "Tartan can't use the camera: allow it in Android's settings for the app, or type the code instead." : "No camera here: type the address and code instead.";
        return;
      }
      if (done) return stream.getTracks().forEach((t) => t.stop());
      video.srcObject = stream;
      await video.play().catch(() => {});
      const Native = (globalThis as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
      const native = Native ? new Native({ formats: ["qr_code"] }) : null;
      const jsqr = native ? null : (await import("jsqr")).default;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      const tick = async () => {
        if (done) return;
        if (video.readyState >= 2 && video.videoWidth) {
          try {
            let text: string | null = null;
            if (native) text = (await native.detect(video))[0]?.rawValue ?? null;
            else {
              const scale = Math.min(1, 720 / video.videoWidth);
              canvas.width = Math.round(video.videoWidth * scale);
              canvas.height = Math.round(video.videoHeight * scale);
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
              text = jsqr!(img.data, img.width, img.height, { inversionAttempts: "dontInvert" })?.data ?? null;
            }
            if (text) return finish(text);
          } catch {
            // a frame that didn't read: the next one
          }
        }
        setTimeout(() => void tick(), 120);
      };
      void tick();
    })();
  });
}
