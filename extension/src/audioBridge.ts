import browser from "webextension-polyfill";

declare const __BROWSER__: "chrome" | "firefox";

export type AudioPlayPayload = {
  blob: Blob;
  volume: number;
  playbackSpeed: number;
};

const isChrome = typeof __BROWSER__ !== "undefined" && __BROWSER__ === "chrome";

let ffAudio: HTMLAudioElement | null = null;
let ffObjectUrl: string | null = null;
let ffKeepalive: HTMLAudioElement | null = null;
let chromeOffscreenReady: Promise<void> | null = null;

/** FF plays in-background; runtime.sendMessage does not re-enter the same frame. */
let endedHandler: (() => void) | null = null;
let errorHandler: ((message: string) => void) | null = null;

export function setAudioLifecycleHandlers(handlers: {
  onEnded: () => void;
  onError: (message: string) => void;
}): void {
  endedHandler = handlers.onEnded;
  errorHandler = handlers.onError;
}

function getFfAudio(): HTMLAudioElement {
  if (!ffAudio) {
    ffAudio = new Audio();
    ffAudio.preload = "auto";
    ffAudio.addEventListener("ended", () => {
      endedHandler?.();
    });
    ffAudio.addEventListener("error", () => {
      errorHandler?.(ffAudio?.error?.message ?? "audio error");
    });
  }
  return ffAudio;
}

function revokeFfUrl() {
  if (!ffObjectUrl) return;
  try {
    URL.revokeObjectURL(ffObjectUrl);
  } catch {
    /* */
  }
  ffObjectUrl = null;
}

async function ensureChromeOffscreen(): Promise<void> {
  const chromeApi = (
    globalThis as unknown as {
      chrome?: {
        offscreen?: {
          hasDocument?: () => Promise<boolean>;
          createDocument: (opts: {
            url: string;
            reasons: string[];
            justification: string;
          }) => Promise<void>;
        };
        runtime: { getURL: (p: string) => string };
      };
    }
  ).chrome;
  const offscreen = chromeApi?.offscreen;
  if (!offscreen || !chromeApi) return;

  if (chromeOffscreenReady) return chromeOffscreenReady;
  chromeOffscreenReady = (async () => {
    try {
      const has = offscreen.hasDocument
        ? await offscreen.hasDocument()
        : false;
      if (has) return;
      await offscreen.createDocument({
        url: chromeApi.runtime.getURL("offscreen.html"),
        reasons: ["AUDIO_PLAYBACK", "BLOBS"],
        justification: "TTS playback",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Chrome: "Only a single offscreen document may be created."
      if (
        !/already exists|only one offscreen|single offscreen/i.test(msg)
      ) {
        throw e;
      }
    }
  })();
  try {
    await chromeOffscreenReady;
  } finally {
    chromeOffscreenReady = null;
  }
}

async function sendToOffscreen(msg: Record<string, unknown>): Promise<unknown> {
  await ensureChromeOffscreen();
  return browser.runtime.sendMessage(msg);
}

export async function audioEnsure(): Promise<void> {
  if (isChrome) await ensureChromeOffscreen();
  else getFfAudio();
}

export async function audioPlay(p: AudioPlayPayload): Promise<void> {
  if (isChrome) {
    // SW cannot createObjectURL. Send base64 — survives extension messaging
    // reliably (Blob/ArrayBuffer clone to offscreen has been flaky).
    const buffer = await p.blob.arrayBuffer();
    await sendToOffscreen({
      type: "audio/play",
      base64: arrayBufferToBase64(buffer),
      mimeType: p.blob.type || "audio/mpeg",
      volume: p.volume,
      playbackSpeed: p.playbackSpeed,
    });
    return;
  }
  stopFfKeepalive();
  const a = getFfAudio();
  a.pause();
  revokeFfUrl();
  ffObjectUrl = URL.createObjectURL(p.blob);
  a.src = ffObjectUrl;
  a.volume = clamp01(p.volume);
  a.playbackRate = p.playbackSpeed;
  await a.play();
}

export async function audioPause(): Promise<void> {
  if (isChrome) {
    await sendToOffscreen({ type: "audio/pause" });
    return;
  }
  getFfAudio().pause();
}

export async function audioResume(): Promise<void> {
  if (isChrome) {
    await sendToOffscreen({ type: "audio/resume" });
    return;
  }
  stopFfKeepalive();
  await getFfAudio().play();
}

export async function audioStop(): Promise<void> {
  if (isChrome) {
    await sendToOffscreen({ type: "audio/stop" });
    return;
  }
  stopFfKeepalive();
  const a = getFfAudio();
  a.pause();
  a.removeAttribute("src");
  a.load();
  revokeFfUrl();
}

export async function audioSetGain(opts: {
  volume?: number;
  playbackSpeed?: number;
}): Promise<void> {
  if (isChrome) {
    await sendToOffscreen({ type: "audio/setGain", ...opts });
    return;
  }
  const a = getFfAudio();
  if (opts.volume !== undefined) a.volume = clamp01(opts.volume);
  if (opts.playbackSpeed !== undefined) a.playbackRate = opts.playbackSpeed;
}

export async function audioKeepalive(on: boolean): Promise<void> {
  if (isChrome) {
    await sendToOffscreen({ type: "audio/keepalive", on });
    return;
  }
  if (on) startFfKeepalive();
  else stopFfKeepalive();
}

function startFfKeepalive() {
  if (ffKeepalive) return;
  ffKeepalive = new Audio(
    "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==",
  );
  ffKeepalive.loop = true;
  ffKeepalive.volume = 0.01;
  void ffKeepalive.play().catch(() => {});
}

function stopFfKeepalive() {
  if (!ffKeepalive) return;
  ffKeepalive.pause();
  ffKeepalive.removeAttribute("src");
  ffKeepalive = null;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(
      null,
      sub as unknown as number[],
    );
  }
  return btoa(binary);
}
