import browser from "webextension-polyfill";

const audio = new Audio();
audio.preload = "auto";

let objectUrl: string | null = null;
let keepaliveEl: HTMLAudioElement | null = null;

audio.addEventListener("ended", () => {
  void browser.runtime.sendMessage({ type: "audio/ended" }).catch(() => {});
});

audio.addEventListener("error", () => {
  void browser.runtime
    .sendMessage({
      type: "audio/error",
      message: audio.error?.message ?? "audio error",
    })
    .catch(() => {});
});

browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as { type?: string; [k: string]: unknown };
  if (!msg?.type?.startsWith("audio/")) return;
  return handle(msg);
});

async function handle(msg: { type?: string; [k: string]: unknown }) {
  switch (msg.type) {
    case "audio/ensure":
      return { ok: true };
    case "audio/play": {
      stopKeepalive();
      audio.pause();
      revokeUrl();
      const blob = toBlob(msg);
      objectUrl = URL.createObjectURL(blob);
      audio.src = objectUrl;
      audio.volume = clamp01(Number(msg.volume ?? 1));
      audio.playbackRate = Number(msg.playbackSpeed ?? 1);
      await audio.play();
      return { ok: true };
    }
    case "audio/pause":
      audio.pause();
      return { ok: true };
    case "audio/resume":
      stopKeepalive();
      await audio.play();
      return { ok: true };
    case "audio/stop":
      stopKeepalive();
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      revokeUrl();
      return { ok: true };
    case "audio/setGain":
      if (msg.volume !== undefined) audio.volume = clamp01(Number(msg.volume));
      if (msg.playbackSpeed !== undefined) {
        audio.playbackRate = Number(msg.playbackSpeed);
      }
      return { ok: true };
    case "audio/keepalive":
      if (msg.on) startKeepalive();
      else stopKeepalive();
      return { ok: true };
    default:
      return { ok: false };
  }
}

function toBlob(msg: { [k: string]: unknown }): Blob {
  const mime = String(msg.mimeType ?? "audio/mpeg");
  if (typeof msg.base64 === "string" && msg.base64.length > 0) {
    return base64ToBlob(msg.base64, mime);
  }
  if (msg.buffer instanceof ArrayBuffer) {
    return new Blob([msg.buffer as BlobPart], { type: mime });
  }
  if (ArrayBuffer.isView(msg.buffer)) {
    const src = msg.buffer as ArrayBufferView;
    const bytes = new Uint8Array(src.byteLength);
    bytes.set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength));
    return new Blob([bytes as BlobPart], { type: mime });
  }
  if (msg.blob instanceof Blob) {
    return msg.blob;
  }
  throw new Error("audio/play missing audio payload");
}

function base64ToBlob(b64: string, mime: string): Blob {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes as BlobPart], { type: mime });
}

function revokeUrl() {
  if (!objectUrl) return;
  try {
    URL.revokeObjectURL(objectUrl);
  } catch {
    /* */
  }
  objectUrl = null;
}

function startKeepalive() {
  if (keepaliveEl) return;
  keepaliveEl = new Audio(
    "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==",
  );
  keepaliveEl.loop = true;
  keepaliveEl.volume = 0.01;
  void keepaliveEl.play().catch(() => {});
}

function stopKeepalive() {
  if (!keepaliveEl) return;
  keepaliveEl.pause();
  keepaliveEl.removeAttribute("src");
  keepaliveEl = null;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 1));
}
