import browser from "webextension-polyfill";
import { getSettings, setSettings, type Settings } from "./settings";
import {
  probeConnection,
  clearCache,
  cacheStats,
  getVoices,
  type ConnectionStatus,
} from "./rpc";
import { isRestrictedUrl, restrictedReason } from "./urls";
import type { PopupStatus } from "./messages";
import {
  activate,
  pause,
  resume,
  stop,
  nextChunk,
  prevChunk,
  getSession,
  onAudioEnded,
  onAudioError,
  destroySession,
  handleContentGone,
  applyLiveGain,
  onVoiceOrRateChange,
} from "./session";
import type { Chunk, ChunkMode } from "./chunk";
import { audioKeepalive, setAudioLifecycleHandlers } from "./audioBridge";
import {
  injectContent,
  markContentReady,
  clearContentReady,
} from "./contentReady";
import {
  getRulesStore,
  setRulesStore,
  upsertRule,
  deleteRule,
  exportRulesJson,
  parseImportJson,
  mergeImported,
  type ImportMode,
  type SiteRule,
  defaultHostsForTab,
  findBestRuleForPage,
} from "./siteRules";

declare const __BROWSER__: "chrome" | "firefox";

// Firefox Audio lives in this frame — call session directly (sendMessage won't).
setAudioLifecycleHandlers({
  onEnded: () => {
    void onAudioEnded();
  },
  onError: (message) => {
    void onAudioError(message);
  },
});

const MENU_READ_FROM_HERE = "edge-tts-read-from-here";
const MENU_READ_SELECTION = "edge-tts-read-selection";

type Msg = { type: string; [k: string]: unknown };

function installMenus() {
  void browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: MENU_READ_FROM_HERE,
      title: "etc Speech: Read from here",
      contexts: ["page"],
    });
    browser.contextMenus.create({
      id: MENU_READ_SELECTION,
      title: "etc Speech: Read selection",
      contexts: ["selection"],
    });
  });
}

browser.runtime.onInstalled.addListener(() => {
  installMenus();
  void getRulesStore(); // seed Wikipedia defaults
});

// Event pages / SW restart: menus may already exist; ensure seed.
void getRulesStore();
try {
  installMenus();
} catch {
  /* */
}

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id == null) return;
  if (info.menuItemId === MENU_READ_FROM_HERE) {
    void readFromHere(tab.id, tab.url);
    return;
  }
  if (info.menuItemId === MENU_READ_SELECTION) {
    void readSelection(tab.id, tab.url);
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  clearContentReady(tabId);
  void handleContentGone(tabId);
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    clearContentReady(tabId);
    const s = getSession();
    if (s && s.tabId === tabId) void destroySession();
  }
});

browser.runtime.onMessage.addListener(
  (message: unknown, sender: browser.Runtime.MessageSender) => {
    const msg = message as Msg;
    if (!msg || typeof msg.type !== "string") return;

    // Outbound bridge commands are for the offscreen doc. Returning a Promise
    // here steals the sendMessage response channel from offscreen.
    if (
      msg.type.startsWith("audio/") &&
      msg.type !== "audio/ended" &&
      msg.type !== "audio/error" &&
      msg.type !== "audio/state"
    ) {
      return;
    }

    return handleMessage(msg, sender);
  },
);

async function handleMessage(
  msg: Msg,
  sender: browser.Runtime.MessageSender,
): Promise<unknown> {
  switch (msg.type) {
    case "popup/getStatus":
      return getPopupStatus();
    case "popup/getSettings":
    case "options/getSettings":
      return getSettings();
    case "popup/setSettings":
    case "options/setSettings": {
      const prev = await getSettings();
      const next = await setSettings(
        (msg.patch ?? msg.settings ?? {}) as Partial<Settings>,
      );
      if (
        prev.volume !== next.volume ||
        prev.playbackSpeed !== next.playbackSpeed
      ) {
        await applyLiveGain({
          volume: next.volume,
          playbackSpeed: next.playbackSpeed,
        });
      }
      if (prev.voice !== next.voice || prev.genSpeed !== next.genSpeed) {
        await onVoiceOrRateChange();
      }
      if (prev.audioKeepalive !== next.audioKeepalive && !next.audioKeepalive) {
        await audioKeepalive(false);
      }
      return next;
    }
    case "popup/liveGain": {
      const opts: { volume?: number; playbackSpeed?: number } = {};
      if (typeof msg.volume === "number") opts.volume = msg.volume;
      if (typeof msg.playbackSpeed === "number") {
        opts.playbackSpeed = msg.playbackSpeed;
      }
      await applyLiveGain(opts);
      return { ok: true };
    }
    case "options/testConnection":
    case "popup/probe":
      return probeNow();
    case "popup/play":
      return doPlay();
    case "popup/pause":
      await pause();
      return { ok: true };
    case "popup/resume":
      await resume();
      return { ok: true };
    case "popup/stop":
      await stop();
      return { ok: true };
    case "popup/next":
      await nextChunk();
      return { ok: true };
    case "popup/prev":
      await prevChunk();
      return { ok: true };
    case "popup/clearCache": {
      const s = await getSettings();
      if (!s.secret) throw new Error("secret not configured");
      await clearCache(s.secret);
      return { ok: true };
    }
    case "popup/cacheStats": {
      const s = await getSettings();
      if (!s.secret) throw new Error("secret not configured");
      return cacheStats(s.secret);
    }
    case "popup/getVoices": {
      const s = await getSettings();
      if (!s.secret) throw new Error("secret not configured");
      return getVoices(s.secret);
    }
    case "popup/openOptions":
      await browser.runtime.openOptionsPage();
      return { ok: true };
    case "popup/openRulesEditor":
    case "options/openRulesEditor":
      return openRulesEditor(
        typeof msg.ruleId === "string" ? msg.ruleId : undefined,
        msg.forActiveTab === true,
      );

    case "rules/getStore":
      return getRulesStore();
    case "rules/setStore":
      return setRulesStore(msg.store as import("./siteRules").RulesStore);
    case "rules/upsert":
      return upsertRule(msg.rule as SiteRule);
    case "rules/delete":
      return deleteRule(String(msg.id ?? ""));
    case "rules/export":
      return { json: exportRulesJson(await getRulesStore()) };
    case "rules/import": {
      const mode = msg.mode as ImportMode;
      const incoming = parseImportJson(String(msg.json ?? ""));
      const store = await getRulesStore();
      const rules = mergeImported(store.rules, incoming, mode);
      return setRulesStore({ ...store, rules });
    }
    case "rules/tabContext":
      return rulesTabContext();

    case "content/ready":
      if (sender.tab?.id != null) markContentReady(sender.tab.id);
      return { ok: true };
    case "content/gone":
      if (sender.tab?.id != null) {
        clearContentReady(sender.tab.id);
        await handleContentGone(sender.tab.id);
      }
      return { ok: true };

    case "audio/ended":
      await onAudioEnded();
      return { ok: true };
    case "audio/error":
      await onAudioError(String(msg.message ?? "audio error"));
      return { ok: true };

    default:
      return undefined;
  }
}

async function rulesTabContext(): Promise<{
  host: string;
  pathname: string;
  hosts: string[];
  matchRuleId: string | null;
}> {
  const tab = await activeTab();
  let host = "";
  let pathname = "";
  if (tab?.id != null && tab.url && !isRestrictedUrl(tab.url)) {
    try {
      await injectContent(tab.id);
      const info = (await browser.tabs.sendMessage(tab.id, {
        type: "content/pageInfo",
      })) as { host: string; pathname: string };
      host = info.host ?? "";
      pathname = info.pathname ?? "";
    } catch {
      try {
        const u = new URL(tab.url);
        host = u.hostname;
        pathname = u.pathname;
      } catch {
        /* */
      }
    }
  }
  const store = await getRulesStore();
  const match = host
    ? findBestRuleForPage(store.rules, host, pathname || "/")
    : null;
  return {
    host,
    pathname: pathname || "/",
    hosts: host ? defaultHostsForTab(host) : [],
    matchRuleId: match?.id ?? null,
  };
}

async function openRulesEditor(
  ruleId?: string,
  forActiveTab?: boolean,
): Promise<{ ok: boolean }> {
  const url = new URL(browser.runtime.getURL("rules.html"));
  if (ruleId) url.searchParams.set("id", ruleId);
  if (forActiveTab) {
    // Capture page tab *before* rules.html becomes active (else host is empty).
    const ctx = await rulesTabContext();
    url.searchParams.set("tab", "1");
    if (ctx.host) {
      url.searchParams.set("host", ctx.host);
      url.searchParams.set("path", ctx.pathname);
      url.searchParams.set("hosts", ctx.hosts.join(","));
    }
    if (ctx.matchRuleId && !ruleId) {
      url.searchParams.set("id", ctx.matchRuleId);
    }
  }
  await browser.tabs.create({ url: url.toString() });
  return { ok: true };
}

async function readFromHere(
  tabId: number,
  url: string | undefined,
): Promise<void> {
  if (isRestrictedUrl(url)) return;
  try {
    await injectContent(tabId);
    let startIndex = 0;
    let chunks: Chunk[] | undefined;
    let mode: ChunkMode = "page";
    let readabilityFailed = false;
    try {
      const r = (await browser.tabs.sendMessage(tabId, {
        type: "content/resolveReadFromHere",
      })) as {
        chunkIndex: number;
        chunks: Chunk[];
        mode: ChunkMode;
        readabilityFailed?: boolean;
      };
      startIndex = r.chunkIndex ?? 0;
      chunks = r.chunks;
      mode = "page";
      readabilityFailed = Boolean(r.readabilityFailed);
    } catch {
      /* activate will chunk */
    }
    await activate(tabId, {
      startIndex,
      chunks,
      mode,
      readabilityFailed,
    });
  } catch {
    /* session toasts */
  }
}

async function readSelection(
  tabId: number,
  url: string | undefined,
): Promise<void> {
  if (isRestrictedUrl(url)) return;
  try {
    await injectContent(tabId);
    let chunks: Chunk[] | undefined;
    try {
      const r = (await browser.tabs.sendMessage(tabId, {
        type: "content/requestSelectionChunks",
      })) as {
        chunks: Chunk[];
        empty: boolean;
      };
      chunks = r.chunks;
    } catch {
      /* */
    }
    await activate(tabId, {
      startIndex: 0,
      chunks,
      mode: "selection",
    });
  } catch {
    /* */
  }
}

async function doPlay(): Promise<{ ok: boolean; error?: string }> {
  const tab = await activeTab();
  if (!tab?.id) return { ok: false, error: "No active tab" };
  if (isRestrictedUrl(tab.url)) {
    return { ok: false, error: restrictedReason(tab.url) };
  }
  const s = getSession();
  if (s && s.tabId === tab.id && s.status === "paused") {
    await resume();
    return { ok: true };
  }
  if (s && s.tabId === tab.id && s.status === "playing") {
    return { ok: true };
  }
  try {
    // Always full page — selection is menu-only.
    await activate(tab.id, { mode: "page" });
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function probeNow(): Promise<ConnectionStatus> {
  const s = await getSettings();
  return probeConnection(s.secret, AbortSignal.timeout(8000));
}

async function getPopupStatus(): Promise<PopupStatus> {
  const [settings, connection, tab] = await Promise.all([
    getSettings(),
    probeNow(),
    activeTab(),
  ]);
  const url = tab?.url;
  const restricted = isRestrictedUrl(url);
  const sess = getSession();
  return {
    connection,
    settings,
    session: {
      active: Boolean(sess),
      status: sess?.status ?? "idle",
      index: sess?.index ?? 0,
      total: sess?.chunks.length ?? 0,
      mode: sess?.mode ?? null,
      tabId: sess?.tabId ?? null,
      errorMessage: sess?.errorMessage ?? null,
    },
    restricted,
    restrictedMessage: restricted ? restrictedReason(url) : null,
    browser: typeof __BROWSER__ !== "undefined" ? __BROWSER__ : "chrome",
  };
}

async function activeTab(): Promise<browser.Tabs.Tab | undefined> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}
