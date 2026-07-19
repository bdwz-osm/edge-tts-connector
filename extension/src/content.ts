import browser from "webextension-polyfill";
import {
  chunkPage,
  chunkSelection,
  nearestChunkIndex,
  pickRoot,
  resolveAnchor,
  type Chunk,
  type ChunkMode,
} from "./chunk";

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
  let toastTimer: number | null = null;

  document.addEventListener(
    "contextmenu",
    (e) => {
      lastCtxEl = e.target instanceof Element ? e.target : null;
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
        return Promise.resolve(collectChunks());
      case "content/highlight":
        highlight(msg.chunkIndex as number);
        return Promise.resolve({ ok: true });
      case "content/clearHighlight":
        clearHighlight();
        return Promise.resolve({ ok: true });
      case "content/toast":
        showToast(
          (msg.level as string) ?? "info",
          (msg.message as string) ?? "",
        );
        return Promise.resolve({ ok: true });
      case "content/resolveReadFromHere":
        return Promise.resolve(resolveReadFromHere());
      default:
        return undefined;
    }
  });

  window.addEventListener("pagehide", () => {
    safeSend({ type: "content/gone" });
  });

  safeSend({ type: "content/ready" });

  function collectChunks(): {
    chunks: Chunk[];
    mode: ChunkMode;
    empty: boolean;
  } {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && collapse(sel.toString())) {
      lastChunks = chunkSelection(sel);
      lastMode = "selection";
      lastRoot = document.body;
    } else {
      lastRoot = pickRoot(document);
      lastChunks = chunkPage(document);
      lastMode = "page";
    }
    return {
      chunks: lastChunks,
      mode: lastMode,
      empty: lastChunks.length === 0,
    };
  }

  function resolveReadFromHere(): { chunkIndex: number; chunks: Chunk[]; mode: ChunkMode } {
    const data = collectChunks();
    let chunkIndex = 0;
    if (lastCtxEl && lastRoot && data.mode === "page") {
      chunkIndex = nearestChunkIndex(lastRoot, data.chunks, lastCtxEl);
    }
    return { chunkIndex, chunks: data.chunks, mode: data.mode };
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

/**
 * Fire-and-forget to background. After extension reload the old content
 * script's extension binding is dead — polyfill sendMessage can still throw
 * "Extension context invalidated" as an uncaught error. Use chrome's callback
 * API and swallow lastError.
 */
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

    // Firefox: browser.runtime
    if (!browser.runtime?.id) return;
    void Promise.resolve(browser.runtime.sendMessage(msg)).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    /* context gone */
  }
}
