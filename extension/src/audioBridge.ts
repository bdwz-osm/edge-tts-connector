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

function getFfAudio(): HTMLAudioElement {
  if (!ffAudio) {
    ffAudio = new Audio();
    ffAudio.preload = "auto";
    ffAudio.addEventListener("ended", () => {
      void browser.runtime.sendMessage({ type: "audio/ended" }).catch(() => {});
    });
    ffAudio.addEventListener("error", () => {
      void browser.runtime
        .sendMessage({
          type: "audio/error",
          message: ffAudio?.error?.message ?? "audio error",
        })
        .catch(() => {});
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
      if (!/already exists|only one offscreen/i.test(msg)) throw e;
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
  if (!on) stopFfKeepalive();
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
