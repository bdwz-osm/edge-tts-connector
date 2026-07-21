import browser from "webextension-polyfill";
import {
  chunkPage,
  chunkSelection,
  childIndexPath,
  nearestChunkIndex,
  resolveAnchor,
  type Chunk,
  type ChunkMode,
} from "./chunk";
import { getRulesStore, selectorsForPage } from "./siteRules";

declare global {
  interface Window {
    __ETC_SPEECH__?: boolean;
  }
}

if (!window.__ETC_SPEECH__) {
  window.__ETC_SPEECH__ = true;
  boot();
}

function boot() {
  const HIGHLIGHT = "edge-tts-highlight";
  let lastChunks: Chunk[] = [];
  let lastMode: ChunkMode = "page";
  let lastRoot: Element | null = null;
  let lastCtxEl: Element | null = null;
  let lastDestroy: string[] = [];
  /** Bumps on each collect so concurrent awaits don't clobber each other's last*. */
  let collectSeq = 0;
  let toastTimer: number | null = null;
  /** Open port while reading — keeps Firefox MV3 event page from dying mid-TTS. */
  let playbackPort: browser.Runtime.Port | null = null;

  document.addEventListener(
    "contextmenu",
    (e) => {
      lastCtxEl = e.target instanceof Element ? e.target : null;
      // Mirror to background — Chromium often has no content script on the
      // first right-click after extension load (cold tab); RFH still gets a path.
      if (lastCtxEl) {
        const path = childIndexPath(document.documentElement, lastCtxEl);
        safeSend({ type: "content/ctxTarget", path });
      }
    },
    true,
  );

  browser.runtime.onMessage.addListener((message: unknown) => {
    const msg = message as { type?: string; [k: string]: unknown };
    if (!msg?.type) return;
    switch (msg.type) {
      case "content/ping":
        return Promise.resolve({ ok: true });
      case "content/requestChunks":
        // Page only — selection is a separate verb.
        return collectPageChunks();
      case "content/requestSelectionChunks":
        return collectSelectionChunks();
      case "content/highlight":
        highlight(msg.chunkIndex as number);
        return Promise.resolve({ ok: true });
      case "content/clearHighlight":
        clearHighlight();
        return Promise.resolve({ ok: true });
      case "content/holdPort":
        setHoldPort(Boolean(msg.on));
        return Promise.resolve({ ok: true });
      case "content/toast":
        showToast(
          (msg.level as string) ?? "info",
          (msg.message as string) ?? "",
        );
        return Promise.resolve({ ok: true });
      case "content/resolveReadFromHere":
        return resolveReadFromHere(
          Array.isArray(msg.fallbackPath)
            ? (msg.fallbackPath as number[])
            : msg.fallbackPath === null
              ? null
              : undefined,
        );
      case "content/pageInfo":
        return Promise.resolve({
          host: location.hostname,
          pathname: location.pathname,
          href: location.href,
        });
      default:
        return undefined;
    }
  });

  window.addEventListener("pagehide", (e) => {
    // bfcache: page may come back; don't treat as tab death / Stop.
    if (e.persisted) return;
    setHoldPort(false);
    safeSend({ type: "content/gone" });
  });

  safeSend({ type: "content/ready" });

  function setHoldPort(on: boolean) {
    if (on) {
      if (playbackPort) return;
      try {
        if (!browser.runtime?.id) return;
        playbackPort = browser.runtime.connect({ name: "etc-playback" });
        playbackPort.onDisconnect.addListener(() => {
          playbackPort = null;
        });
      } catch {
        playbackPort = null;
      }
      return;
    }
    if (!playbackPort) return;
    try {
      playbackPort.disconnect();
    } catch {
      /* */
    }
    playbackPort = null;
  }

  async function destroySelectors(): Promise<string[]> {
    try {
      const store = await getRulesStore();
      return selectorsForPage(
        store.rules,
        location.hostname,
        location.pathname,
      );
    } catch {
      return [];
    }
  }

  async function collectPageChunks(): Promise<{
    chunks: Chunk[];
    mode: ChunkMode;
    empty: boolean;
    readabilityFailed: boolean;
    root: Element | null;
    destroy: string[];
  }> {
    const seq = ++collectSeq;
    const destroy = await destroySelectors();
    const result = chunkPage(document, { destroySelectors: destroy });
    // Only the latest collect owns highlight state.
    if (seq === collectSeq) {
      lastDestroy = destroy;
      lastRoot = result.root;
      lastChunks = result.chunks;
      lastMode = "page";
    }
    return {
      chunks: result.chunks,
      mode: "page",
      empty: result.chunks.length === 0,
      readabilityFailed: result.readabilityFailed,
      root: result.root,
      destroy,
    };
  }

  async function collectSelectionChunks(): Promise<{
    chunks: Chunk[];
    mode: ChunkMode;
    empty: boolean;
    readabilityFailed: boolean;
  }> {
    const seq = ++collectSeq;
    const destroy = await destroySelectors();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !collapse(sel.toString())) {
      if (seq === collectSeq) {
        lastChunks = [];
        lastMode = "selection";
        lastRoot = null;
        lastDestroy = destroy;
      }
      return {
        chunks: [],
        mode: "selection",
        empty: true,
        readabilityFailed: false,
      };
    }
    const chunks = chunkSelection(sel, { destroySelectors: destroy });
    if (seq === collectSeq) {
      lastChunks = chunks;
      lastMode = "selection";
      lastRoot = null;
      lastDestroy = destroy;
    }
    return {
      chunks,
      mode: "selection",
      empty: chunks.length === 0,
      readabilityFailed: false,
    };
  }

  async function resolveReadFromHere(
    fallbackPath?: number[] | null,
  ): Promise<{
    chunkIndex: number;
    chunks: Chunk[];
    mode: ChunkMode;
    readabilityFailed: boolean;
  }> {
    // Snapshot before any await — concurrent collects must not steal context.
    let ctxEl = lastCtxEl;
    // Cold inject wiped in-page lastCtxEl; bg may still have path from earlier
    // contextmenu (or from a previous content instance on this tab).
    if (!ctxEl && fallbackPath !== undefined && fallbackPath !== null) {
      ctxEl = resolveAnchor(document.documentElement, fallbackPath);
    }
    const data = await collectPageChunks();
    let chunkIndex = 0;
    if (ctxEl && data.root) {
      chunkIndex = nearestChunkIndex(
        data.root,
        data.chunks,
        ctxEl,
        data.destroy,
      );
    }
    return {
      chunkIndex,
      chunks: data.chunks,
      mode: "page",
      readabilityFailed: data.readabilityFailed,
    };
  }

  function clearHighlight() {
    for (const el of document.querySelectorAll(`.${HIGHLIGHT}`)) {
      el.classList.remove(HIGHLIGHT);
    }
  }

  function highlight(chunkIndex: number) {
    clearHighlight();
    const chunk = lastChunks[chunkIndex];
    if (!chunk || !lastRoot) return;
    if (!chunk.anchor.length) return;
    const el = resolveAnchor(lastRoot, chunk.anchor);
    if (!el) return;
    el.classList.add(HIGHLIGHT);
    try {
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
    } catch {
      /* ignore */
    }
  }

  function showToast(level: string, message: string) {
    if (!message) return;
    let host = document.getElementById("etc-speech-toast");
    if (!host) {
      host = document.createElement("div");
      host.id = "etc-speech-toast";
      Object.assign(host.style, {
        position: "fixed",
        bottom: "16px",
        right: "16px",
        zIndex: "2147483647",
        maxWidth: "320px",
        padding: "10px 14px",
        borderRadius: "8px",
        fontFamily: "system-ui,sans-serif",
        fontSize: "13px",
        lineHeight: "1.35",
        boxShadow: "0 4px 20px rgba(0,0,0,.35)",
        color: "#f4f4f5",
        pointerEvents: "none",
      });
      document.documentElement.appendChild(host);
    }
    host.textContent = message;
    host.style.background =
      level === "error"
        ? "rgba(180,30,50,.92)"
        : level === "warn"
          ? "rgba(160,110,20,.92)"
          : "rgba(30,30,40,.92)";
    host.style.display = "block";
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      host!.style.display = "none";
    }, 4000);
  }
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function safeSend(msg: Record<string, unknown>): void {
  try {
    const chromeRt = (
      globalThis as unknown as {
        chrome?: {
          runtime?: {
            id?: string;
            sendMessage: (
              message: unknown,
              responseCallback?: (response: unknown) => void,
            ) => void;
            lastError?: { message?: string };
          };
        };
      }
    ).chrome?.runtime;

    if (chromeRt) {
      if (!chromeRt.id) return;
      chromeRt.sendMessage(msg, () => {
        void chromeRt.lastError;
      });
      return;
    }

    if (!browser.runtime?.id) return;
    void Promise.resolve(browser.runtime.sendMessage(msg)).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    /* context gone */
  }
}
