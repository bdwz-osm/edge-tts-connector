// Chrome offscreen AudioBridge shell — full playback in step 3.
import browser from "webextension-polyfill";

browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as { type?: string };
  if (!msg?.type?.startsWith("audio/")) return;
  // Step 3: audio/play, pause, resume, stop, setGain, keepalive
  return Promise.resolve({ ok: true, stub: true });
});
