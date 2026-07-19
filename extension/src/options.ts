import browser from "webextension-polyfill";
import type { Settings } from "./settings";
import type { ConnectionStatus } from "./rpc";

const secretInput = document.getElementById("secret") as HTMLInputElement;
const showSecret = document.getElementById("showSecret") as HTMLInputElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const testBtn = document.getElementById("test") as HTMLButtonElement;
const saveMsg = document.getElementById("saveMsg")!;
const pOnline = document.getElementById("p-online")!;
const pVersion = document.getElementById("p-version")!;
const pSecret = document.getElementById("p-secret")!;
const pDetail = document.getElementById("p-detail")!;

function flash(text: string, kind: "ok" | "err" | "warn") {
  saveMsg.hidden = false;
  saveMsg.textContent = text;
  saveMsg.className = `msg ${kind}`;
}

function paintProbe(c: ConnectionStatus) {
  pOnline.textContent = c.online ? "reachable" : "unreachable";
  pOnline.className = c.online ? "ok" : "err";

  pVersion.textContent = c.version ?? "—";
  pVersion.className = "";

  if (!c.secretConfigured) {
    pSecret.textContent = "not set";
    pSecret.className = "warn";
  } else if (c.secretOk === true) {
    pSecret.textContent = "accepted";
    pSecret.className = "ok";
  } else if (c.secretOk === false) {
    pSecret.textContent = "rejected (401)";
    pSecret.className = "err";
  } else {
    pSecret.textContent = c.online ? "not verified" : "—";
    pSecret.className = "warn";
  }

  if (c.errorCode === "voices_unavailable") {
    pDetail.textContent = "secret ok; voice list unavailable";
    pDetail.className = "warn";
  } else {
    pDetail.textContent = c.error ?? (c.online ? "ok" : "—");
    pDetail.className = c.error && c.errorCode !== "voices_unavailable" ? "err" : "";
  }
}

async function load() {
  const settings = (await browser.runtime.sendMessage({
    type: "options/getSettings",
  })) as Settings;
  secretInput.value = settings.secret ?? "";
  await runProbe();
}

async function runProbe() {
  testBtn.disabled = true;
  try {
    const c = (await browser.runtime.sendMessage({
      type: "options/testConnection",
    })) as ConnectionStatus;
    paintProbe(c);
  } catch (e) {
    paintProbe({
      online: false,
      version: null,
      secretOk: null,
      secretConfigured: secretInput.value.trim().length > 0,
      error: e instanceof Error ? e.message : String(e),
      errorCode: "offline",
    });
  } finally {
    testBtn.disabled = false;
  }
}

showSecret.addEventListener("change", () => {
  secretInput.type = showSecret.checked ? "text" : "password";
});

saveBtn.addEventListener("click", () => {
  void (async () => {
    saveBtn.disabled = true;
    try {
      await browser.runtime.sendMessage({
        type: "options/setSettings",
        patch: { secret: secretInput.value.trim() },
      });
      flash("Saved.", "ok");
      await runProbe();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), "err");
    } finally {
      saveBtn.disabled = false;
    }
  })();
});

testBtn.addEventListener("click", () => {
  void (async () => {
    // Probe uses stored secret; save first if input dirty.
    const settings = (await browser.runtime.sendMessage({
      type: "options/getSettings",
    })) as Settings;
    if (secretInput.value.trim() !== (settings.secret ?? "")) {
      await browser.runtime.sendMessage({
        type: "options/setSettings",
        patch: { secret: secretInput.value.trim() },
      });
      flash("Saved, then testing…", "ok");
    }
    await runProbe();
  })();
});

void load();
