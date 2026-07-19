// Shared AudioBridge types / helpers — implemented in step 3 (Chrome offscreen / FF bg).

export type AudioPlayPayload = {
  blobUrl: string;
  volume: number;
  playbackSpeed: number;
};

export type AudioMessage =
  | { type: "audio/ensure" }
  | { type: "audio/play"; blobUrl: string; volume: number; playbackSpeed: number }
  | { type: "audio/pause" }
  | { type: "audio/resume" }
  | { type: "audio/stop" }
  | { type: "audio/setGain"; volume?: number; playbackSpeed?: number }
  | { type: "audio/keepalive"; on: boolean }
  | { type: "audio/ended" }
  | { type: "audio/error"; message: string }
  | { type: "audio/state"; playing: boolean };
