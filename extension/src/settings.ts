import browser from "webextension-polyfill";

export type Settings = {
  secret: string;
  lang: string;
  voice: string;
  genSpeed: string;
  volume: number;
  playbackSpeed: number;
  showInPageToggle: boolean;
  shortcutsEnabled: boolean;
  bufferAhead: number;
  bufferBehind: number;
  audioKeepalive: boolean;
};

export const DEFAULTS: Settings = {
  secret: "",
  lang: "en",
  voice: "en-US-EmmaMultilingualNeural",
  genSpeed: "+0%",
  volume: 1,
  playbackSpeed: 1,
  showInPageToggle: false,
  shortcutsEnabled: false,
  bufferAhead: 8,
  bufferBehind: 1,
  audioKeepalive: false,
};

const KEYS = Object.keys(DEFAULTS) as (keyof Settings)[];

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(KEYS);
  const out = { ...DEFAULTS };
  for (const k of KEYS) {
    if (stored[k] !== undefined && stored[k] !== null) {
      (out as Record<string, unknown>)[k] = stored[k];
    }
  }
  return out;
}

export async function setSettings(
  patch: Partial<Settings>,
): Promise<Settings> {
  const clean: Partial<Settings> = {};
  for (const k of KEYS) {
    if (k in patch && patch[k] !== undefined) {
      (clean as Record<string, unknown>)[k] = patch[k];
    }
  }
  await browser.storage.local.set(clean);
  return getSettings();
}
