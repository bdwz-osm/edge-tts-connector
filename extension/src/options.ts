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
  } else if (!c.online) {
    pDetail.textContent = c.error ?? "unreachable";
    pDetail.className = "err";
  } else if (c.secretOk === false) {
    pDetail.textContent = c.error ?? "unauthorized";
    pDetail.className = "err";
  } else if (c.secretOk === true) {
    pDetail.textContent = "ok";
    pDetail.className = "ok";
  } else {
    pDetail.textContent = c.error ?? "daemon up; set secret to verify auth";
    pDetail.className = c.error ? "err" : "warn";
  }
}

function paintTesting() {
  pOnline.textContent = "…";
  pOnline.className = "";
  pVersion.textContent = "…";
  pVersion.className = "";
  pSecret.textContent = "…";
  pSecret.className = "";
  pDetail.textContent = "testing…";
  pDetail.className = "warn";
}

async function send<T>(msg: Record<string, unknown>): Promise<T> {
  return (await browser.runtime.sendMessage(msg)) as T;
}

async function load() {
  try {
    const settings = await send<Settings>({ type: "options/getSettings" });
    secretInput.value = settings.secret ?? "";
  } catch (e) {
    flash(e instanceof Error ? e.message : String(e), "err");
  }
  await runProbe({ quiet: true });
}

async function runProbe(opts?: { quiet?: boolean }) {
  testBtn.disabled = true;
  paintTesting();
  try {
    const c = await send<ConnectionStatus>({
      type: "options/testConnection",
    });
    paintProbe(c);
    if (!opts?.quiet) {
      if (!c.online) {
        flash(c.error ?? "Daemon unreachable", "err");
      } else if (c.secretOk === false) {
        flash("Daemon reachable, but secret was rejected (401).", "err");
      } else if (!c.secretConfigured) {
        flash("Daemon reachable. Save a secret to verify auth.", "warn");
      } else if (c.secretOk === true) {
        flash(
          c.errorCode === "voices_unavailable"
            ? "Connected (voice list unavailable)."
            : "Connected.",
          "ok",
        );
      } else {
        flash(c.error ?? "Daemon reachable; auth not verified.", "warn");
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    paintProbe({
      online: false,
      version: null,
      secretOk: null,
      secretConfigured: secretInput.value.trim().length > 0,
      error: msg,
      errorCode: "offline",
    });
    if (!opts?.quiet) flash(msg, "err");
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
      await send({
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
    testBtn.disabled = true;
    try {
      // Probe uses stored secret; save first if input dirty.
      let settings: Settings;
      try {
        settings = await send<Settings>({ type: "options/getSettings" });
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e), "err");
        return;
      }
      if (secretInput.value.trim() !== (settings.secret ?? "")) {
        await send({
          type: "options/setSettings",
          patch: { secret: secretInput.value.trim() },
        });
        flash("Saved secret, testing…", "ok");
      } else {
        flash("Testing…", "warn");
      }
      await runProbe();
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), "err");
    } finally {
      testBtn.disabled = false;
    }
  })();
});

void load();
