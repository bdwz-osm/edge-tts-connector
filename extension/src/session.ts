import browser from "webextension-polyfill";
import type { Chunk, ChunkMode } from "./chunk";
import { getSettings, type Settings } from "./settings";
import {
  synth,
  fetchAudioBlob,
  RpcError,
  health,
} from "./rpc";
import {
  audioEnsure,
  audioPlay,
  audioPause,
  audioResume,
  audioStop,
  audioSetGain,
  audioKeepalive,
} from "./audioBridge";
import { injectContent, clearContentReady } from "./contentReady";

export type SessionStatus =
  | "idle"
  | "starting"
  | "playing"
  | "paused"
  | "offline"
  | "error";

type BufState = "pending" | "ready" | "err";

type BufEntry = {
  state: BufState;
  id?: string;
  /** Raw MP3 blob — SW has no createObjectURL; bridge/offscreen makes the URL. */
  blob?: Blob;
  error?: string;
  errorCode?: string;
  promise?: Promise<void>;
};

export type Session = {
  tabId: number;
  status: SessionStatus;
  mode: ChunkMode;
  chunks: Chunk[];
  index: number;
  buffer: Map<number, BufEntry>;
  voice: string;
  rate: string;
  pitch: string;
  errorMessage?: string;
  playGen: number;
  audioEpoch: number;
};

const PLAY_TIMEOUT_MS = 45_000;
const PREFETCH_TIMEOUT_MS = 30_000;
const MAX_PARALLEL = 2;

let session: Session | null = null;
let inflightPrefetch = 0;
const listeners = new Set<() => void>();

export function getSession(): Session | null {
  return session;
}

export function onSessionChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn();
}

function setStatus(s: SessionStatus, err?: string) {
  if (!session) return;
  session.status = s;
  if (err !== undefined) session.errorMessage = err;
  notify();
}

async function toast(
  tabId: number,
  level: "info" | "warn" | "error",
  message: string,
) {
  try {
    await browser.tabs.sendMessage(tabId, {
      type: "content/toast",
      level,
      message,
    });
  } catch {
    /* tab gone */
  }
}

async function highlight(tabId: number, chunkIndex: number) {
  try {
    await browser.tabs.sendMessage(tabId, {
      type: "content/highlight",
      chunkIndex,
    });
  } catch {
    /* */
  }
}

async function clearHighlight(tabId: number) {
  try {
    await browser.tabs.sendMessage(tabId, { type: "content/clearHighlight" });
  } catch {
    /* */
  }
}

function dropEntry(e: BufEntry) {
  e.blob = undefined;
}

function clearBuffer(s: Session) {
  for (const e of s.buffer.values()) dropEntry(e);
  s.buffer.clear();
}

export async function destroySession(): Promise<void> {
  const s = session;
  session = null;
  if (!s) {
    notify();
    return;
  }
  s.playGen++;
  await audioStop().catch(() => {});
  await audioKeepalive(false).catch(() => {});
  clearBuffer(s);
  await clearHighlight(s.tabId);
  notify();
}

async function requestChunks(
  tabId: number,
): Promise<{ chunks: Chunk[]; mode: ChunkMode; empty: boolean }> {
  const res = (await browser.tabs.sendMessage(tabId, {
    type: "content/requestChunks",
  })) as { chunks: Chunk[]; mode: ChunkMode; empty: boolean };
  return res;
}

export async function activate(tabId: number, opts?: {
  startIndex?: number;
  chunks?: Chunk[];
  mode?: ChunkMode;
}): Promise<void> {
  await destroySession();

  const settings = await getSettings();
  if (!settings.secret.trim()) {
    throw new Error("Secret not configured — open Options");
  }

  session = {
    tabId,
    status: "starting",
    mode: "page",
    chunks: [],
    index: 0,
    buffer: new Map(),
    voice: settings.voice,
    rate: settings.genSpeed,
    pitch: "+0Hz",
    playGen: 0,
    audioEpoch: 0,
  };
  notify();

  try {
    await health(AbortSignal.timeout(5000));
  } catch {
    setStatus("offline", "Daemon not reachable");
    throw new Error("Daemon not reachable on 127.0.0.1:24765");
  }

  await injectContent(tabId);

  let chunks = opts?.chunks;
  let mode = opts?.mode ?? "page";
  if (!chunks?.length) {
    const data = await requestChunks(tabId);
    chunks = data.chunks;
    mode = data.mode;
  }
  if (!chunks.length) {
    setStatus("error", "No readable text");
    await toast(tabId, "error", "No readable text on this page");
    throw new Error("No readable text");
  }

  session.chunks = chunks;
  session.mode = mode;
  session.index = clampIndex(opts?.startIndex ?? 0, chunks.length);
  notify();

  topUpBuffer();
  await playCurrent();
}

export async function pause(): Promise<void> {
  if (!session || session.status !== "playing") return;
  await audioPause();
  setStatus("paused");
  const settings = await getSettings();
  if (settings.audioKeepalive) await audioKeepalive(true);
}

export async function resume(): Promise<void> {
  if (!session) return;
  if (session.status === "paused" || session.status === "offline") {
    await audioKeepalive(false);
    const entry = session.buffer.get(session.index);
    if (entry?.state === "ready" && entry.blob) {
      await audioEnsure();
      await audioResume();
      setStatus("playing");
      return;
    }
    await playCurrent();
  }
}

export async function stop(): Promise<void> {
  await destroySession();
}

export async function nextChunk(): Promise<void> {
  if (!session) return;
  if (session.index >= session.chunks.length - 1) {
    await destroySession();
    return;
  }
  session.index++;
  session.playGen++;
  await audioStop().catch(() => {});
  topUpBuffer();
  await playCurrent();
}

export async function prevChunk(): Promise<void> {
  if (!session) return;
  if (session.index <= 0) return;
  session.index--;
  session.playGen++;
  await audioStop().catch(() => {});
  topUpBuffer();
  await playCurrent();
}

export async function onAudioEnded(): Promise<void> {
  const s = session;
  if (!s || s.status !== "playing") return;
  if (s.index >= s.chunks.length - 1) {
    await destroySession();
    return;
  }
  s.index++;
  topUpBuffer();
  await playCurrent();
}

export async function onAudioError(message: string): Promise<void> {
  if (!session) return;
  await toast(session.tabId, "error", message || "Playback error");
  await nextChunk();
}

/** Last UI gain — survives chunk boundaries; storage may lag behind drag. */
let playbackGain: { volume: number; playbackSpeed: number } | null = null;

async function ensurePlaybackGain(): Promise<{
  volume: number;
  playbackSpeed: number;
}> {
  if (playbackGain) return playbackGain;
  const s = await getSettings();
  playbackGain = { volume: s.volume, playbackSpeed: s.playbackSpeed };
  return playbackGain;
}

async function resolvePlaybackGain(): Promise<{
  volume: number;
  playbackSpeed: number;
}> {
  return ensurePlaybackGain();
}

export async function applyLiveGain(
  opts: { volume?: number; playbackSpeed?: number },
): Promise<void> {
  const g = await ensurePlaybackGain();
  if (opts.volume !== undefined) g.volume = opts.volume;
  if (opts.playbackSpeed !== undefined) g.playbackSpeed = opts.playbackSpeed;
  await audioSetGain(g);
}

export async function onVoiceOrRateChange(): Promise<void> {
  if (!session) return;
  const settings = await getSettings();
  session.voice = settings.voice;
  session.rate = settings.genSpeed;
  session.pitch = "+0Hz";
  const resume =
    session.status === "playing" || session.status === "paused";
  // Leave "playing" before stop so a spurious audio/ended cannot advance.
  if (session.status === "playing") setStatus("paused");
  session.playGen++;
  session.audioEpoch++;
  await audioStop().catch(() => {});
  clearBuffer(session);
  topUpBuffer();
  if (resume && session) await playCurrent();
}

function clampIndex(i: number, len: number): number {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(len - 1, i));
}

function windowBounds(s: Session, settings: Settings) {
  const lo = Math.max(0, s.index - settings.bufferBehind);
  const hi = Math.min(s.chunks.length - 1, s.index + settings.bufferAhead);
  return { lo, hi };
}

function topUpBuffer() {
  if (!session) return;
  void (async () => {
    const s = session!;
    const settings = await getSettings();
    const { lo, hi } = windowBounds(s, settings);

    for (const [i, e] of [...s.buffer.entries()]) {
      if (i < lo || i > hi) {
        dropEntry(e);
        s.buffer.delete(i);
      }
    }

    const order: number[] = [];
    order.push(s.index);
    for (let d = 1; d <= settings.bufferAhead; d++) {
      const j = s.index + d;
      if (j <= hi) order.push(j);
    }
    for (let d = 1; d <= settings.bufferBehind; d++) {
      const j = s.index - d;
      if (j >= lo) order.push(j);
    }

    for (const i of order) {
      ensureChunk(i, i === s.index ? "play" : "prefetch");
    }
    notify();
  })();
}

function ensureChunk(i: number, priority: "play" | "prefetch") {
  const s = session;
  if (!s || i < 0 || i >= s.chunks.length) return;
  const existing = s.buffer.get(i);
  if (existing && (existing.state === "ready" || existing.state === "pending")) {
    return;
  }
  if (priority === "prefetch" && inflightPrefetch >= MAX_PARALLEL) return;

  const entry: BufEntry = { state: "pending" };
  s.buffer.set(i, entry);

  const run = async () => {
    if (priority === "prefetch") inflightPrefetch++;
    const ac = new AbortController();
    const ms = priority === "play" ? PLAY_TIMEOUT_MS : PREFETCH_TIMEOUT_MS;
    const timer = setTimeout(() => ac.abort(), ms);
    try {
      const settings = await getSettings();
      const chunk = s.chunks[i]!;
      const ready = await synth(
        settings.secret,
        {
          text: chunk.text,
          voice: s.voice,
          rate: s.rate,
          pitch: s.pitch,
          priority,
        },
        ac.signal,
      );
      const blob = await fetchAudioBlob(
        settings.secret,
        ready.voice,
        ready.id,
        ac.signal,
      );
      if (session !== s) return;
      entry.id = ready.id;
      entry.blob = blob;
      entry.state = "ready";
    } catch (e) {
      if (session !== s) return;
      entry.state = "err";
      if (e instanceof RpcError) {
        entry.error = e.message;
        entry.errorCode = e.code;
      } else if (e instanceof Error && e.name === "AbortError") {
        entry.error = "timeout";
        entry.errorCode = "timeout";
      } else {
        entry.error = e instanceof Error ? e.message : String(e);
        entry.errorCode = "internal";
      }
    } finally {
      clearTimeout(timer);
      if (priority === "prefetch") inflightPrefetch = Math.max(0, inflightPrefetch - 1);
      entry.promise = undefined;
      notify();
      // retry other prefetches
      if (priority === "prefetch" && session === s) topUpBuffer();
    }
  };

  entry.promise = run();
}

async function waitReady(i: number, gen: number): Promise<BufEntry | null> {
  const s = session;
  if (!s || gen !== s.playGen) return null;

  ensureChunk(i, "play");
  let entry = s.buffer.get(i);
  if (!entry) return null;

  const deadline = Date.now() + PLAY_TIMEOUT_MS;
  while (entry.state === "pending") {
    if (session !== s || gen !== s.playGen) return null;
    if (Date.now() > deadline) {
      entry.state = "err";
      entry.errorCode = "timeout";
      entry.error = "timeout";
      break;
    }
    await Promise.race([
      entry.promise ?? sleep(50),
      sleep(100),
    ]);
    entry = s.buffer.get(i)!;
  }
  return entry;
}

async function playCurrent(): Promise<void> {
  const s = session;
  if (!s) return;
  const gen = ++s.playGen;
  const settings = await getSettings();

  await audioKeepalive(false);
  await highlight(s.tabId, s.index);
  topUpBuffer();

  let entry = await waitReady(s.index, gen);
  if (!s || session !== s || gen !== s.playGen) return;

  if (!entry || entry.state !== "ready" || !entry.blob) {
    await handlePlayFailure(entry, gen);
    return;
  }

  try {
    await audioEnsure();
    const epoch = ++s.audioEpoch;
    // Prefer live cache (knob may be ahead of storage).
    if (!playbackGain) {
      playbackGain = {
        volume: settings.volume,
        playbackSpeed: settings.playbackSpeed,
      };
    }
    const gain = playbackGain;
    await audioPlay({
      blob: entry.blob,
      volume: gain.volume,
      playbackSpeed: gain.playbackSpeed,
    });
    if (session === s && gen === s.playGen && s.audioEpoch === epoch) {
      setStatus("playing");
    }
  } catch (e) {
    if (session !== s || gen !== s.playGen) return;
    await toast(
      s.tabId,
      "error",
      e instanceof Error ? e.message : "Playback failed",
    );
    await skipAndContinue(gen);
  }
}

async function handlePlayFailure(
  entry: BufEntry | null | undefined,
  gen: number,
): Promise<void> {
  const s = session;
  if (!s || gen !== s.playGen) return;
  const code = entry?.errorCode ?? "internal";
  const msg = entry?.error ?? "Synthesis failed";

  if (code === "unauthorized") {
    setStatus("error", "Bad secret");
    await toast(s.tabId, "error", "Bad secret (401)");
    return;
  }
  if (code === "upstream_offline" || code === "offline" || code === "timeout") {
    // timeout on play: treat as soft fail skip? Spec: offline → pause+banner
    if (code === "upstream_offline" || code === "offline") {
      setStatus("offline", msg);
      await toast(s.tabId, "warn", "Upstream offline — paused");
      await audioPause().catch(() => {});
      return;
    }
  }
  if (code === "busy") {
    // one client retry
    s.buffer.delete(s.index);
    ensureChunk(s.index, "play");
    const retry = await waitReady(s.index, gen);
    if (session !== s || gen !== s.playGen) return;
    if (retry?.state === "ready" && retry.blob) {
      const gain = await resolvePlaybackGain();
      const epoch = ++s.audioEpoch;
      await audioEnsure();
      if (session !== s || gen !== s.playGen) return;
      await audioPlay({
        blob: retry.blob,
        volume: gain.volume,
        playbackSpeed: gain.playbackSpeed,
      });
      if (session === s && gen === s.playGen && s.audioEpoch === epoch) {
        setStatus("playing");
      }
      return;
    }
    // retry failed — fall through to toast + skip
  }

  // 502 reject/transient exhausted / other → toast + skip
  await toast(s.tabId, "warn", msg);
  await skipAndContinue(gen);
}

async function skipAndContinue(gen: number): Promise<void> {
  const s = session;
  if (!s || gen !== s.playGen) return;
  if (s.index >= s.chunks.length - 1) {
    await destroySession();
    return;
  }
  s.index++;
  topUpBuffer();
  await playCurrent();
}

export async function handleContentGone(tabId: number): Promise<void> {
  clearContentReady(tabId);
  if (session?.tabId === tabId) await destroySession();
}

export async function jumpToIndex(index: number): Promise<void> {
  if (!session) return;
  session.index = clampIndex(index, session.chunks.length);
  session.playGen++;
  await audioStop().catch(() => {});
  clearBuffer(session);
  topUpBuffer();
  await playCurrent();
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
