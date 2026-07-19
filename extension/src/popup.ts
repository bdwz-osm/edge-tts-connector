import browser from "webextension-polyfill";
import type { PopupStatus } from "./messages";

const statusEl = document.getElementById("status")!;
const bannerEl = document.getElementById("banner")!;
const versionEl = document.getElementById("version")!;
const refreshBtn = document.getElementById("refresh") as HTMLButtonElement;
const optionsBtn = document.getElementById("options") as HTMLButtonElement;

function setStatusClass(kind: "online" | "offline" | "bad-secret" | "unknown") {
  statusEl.className = `status ${kind}`;
}

function showBanner(text: string | null, warn = false) {
  if (!text) {
    bannerEl.classList.add("hidden");
    bannerEl.textContent = "";
    return;
  }
  bannerEl.textContent = text;
  bannerEl.classList.remove("hidden");
  bannerEl.classList.toggle("warn", warn);
}

async function load() {
  statusEl.textContent = "…";
  setStatusClass("unknown");
  try {
    const st = (await browser.runtime.sendMessage({
      type: "popup/getStatus",
    })) as PopupStatus;

    const c = st.connection;
    versionEl.textContent = c.version ? `daemon v${c.version}` : "";

    if (!c.online) {
      statusEl.textContent = "Offline";
      setStatusClass("offline");
      showBanner("Daemon not reachable on 127.0.0.1:24765. Run ./server.sh start.");
      return;
    }

    if (!c.secretConfigured) {
      statusEl.textContent = "No secret";
      setStatusClass("bad-secret");
      showBanner("Set the auth secret in Options (from server start / config.toml).", true);
      return;
    }

    if (c.secretOk === false) {
      statusEl.textContent = "Bad secret";
      setStatusClass("bad-secret");
      showBanner("Secret rejected (401). Paste the current secret from config.toml.", true);
      return;
    }

    statusEl.textContent = "Online";
    setStatusClass("online");

    if (st.restricted) {
      showBanner(st.restrictedMessage ?? "Restricted page", true);
    } else if (c.errorCode === "voices_unavailable") {
      showBanner("Voice list unavailable; reading may still work.", true);
    } else {
      showBanner(null);
    }
  } catch (e) {
    statusEl.textContent = "Error";
    setStatusClass("offline");
    showBanner(e instanceof Error ? e.message : String(e));
  }
}

refreshBtn.addEventListener("click", () => {
  void load();
});

optionsBtn.addEventListener("click", () => {
  void browser.runtime.sendMessage({ type: "popup/openOptions" });
});

void load();
