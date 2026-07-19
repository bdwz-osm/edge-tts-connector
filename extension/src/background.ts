import browser from "webextension-polyfill";
import { getSettings, setSettings, type Settings } from "./settings";
import {
  probeConnection,
  clearCache,
  cacheStats,
  type ConnectionStatus,
} from "./rpc";
import { isRestrictedUrl, restrictedReason } from "./urls";
import type { PopupStatus } from "./messages";

declare const __BROWSER__: "chrome" | "firefox";

const MENU_READ_FROM_HERE = "edge-tts-read-from-here";

type Msg = { type: string; [k: string]: unknown };

browser.runtime.onInstalled.addListener(() => {
  void browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: MENU_READ_FROM_HERE,
      title: "etc Speech: Read From Here",
      contexts: ["page", "selection"],
    });
  });
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_READ_FROM_HERE || !tab?.id) return;
  // Step 3: inject + read-from-here. Shell: ignore if restricted.
  if (isRestrictedUrl(tab.url)) return;
  void tab.id;
});

browser.runtime.onMessage.addListener(
  (message: unknown, sender: browser.Runtime.MessageSender) => {
    const msg = message as Msg;
    if (!msg || typeof msg.type !== "string") return;
    return handleMessage(msg, sender);
  },
);

async function handleMessage(
  msg: Msg,
  _sender: browser.Runtime.MessageSender,
): Promise<unknown> {
  switch (msg.type) {
    case "popup/getStatus":
      return getPopupStatus();
    case "popup/getSettings":
    case "options/getSettings":
      return getSettings();
    case "popup/setSettings":
    case "options/setSettings":
      return setSettings((msg.patch ?? msg.settings ?? {}) as Partial<Settings>);
    case "options/testConnection":
    case "popup/probe":
      return probeNow();
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
    case "popup/openOptions":
      await browser.runtime.openOptionsPage();
      return { ok: true };
    case "content/ready":
    case "content/chunks":
    case "content/readFromHere":
    case "content/fab":
    case "content/gone":
      // Step 3+
      return { ok: true };
    default:
      return undefined;
  }
}

async function probeNow(): Promise<ConnectionStatus> {
  const s = await getSettings();
  return probeConnection(s.secret);
}

async function getPopupStatus(): Promise<PopupStatus> {
  const [settings, connection, tab] = await Promise.all([
    getSettings(),
    probeNow(),
    activeTab(),
  ]);
  const url = tab?.url;
  const restricted = isRestrictedUrl(url);
  return {
    connection,
    settings,
    session: { active: false, status: "idle" },
    restricted,
    restrictedMessage: restricted ? restrictedReason(url) : null,
    browser: typeof __BROWSER__ !== "undefined" ? __BROWSER__ : "chrome",
  };
}

async function activeTab(): Promise<browser.Tabs.Tab | undefined> {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}
