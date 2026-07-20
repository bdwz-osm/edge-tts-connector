import browser from "webextension-polyfill";
import type { Settings } from "./settings";
import type { ConnectionStatus } from "./rpc";
import type { ImportMode, RulesStore } from "./siteRules";

const secretInput = document.getElementById("secret") as HTMLInputElement;
const showSecret = document.getElementById("showSecret") as HTMLInputElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const testBtn = document.getElementById("test") as HTMLButtonElement;
const saveMsg = document.getElementById("saveMsg")!;
const pOnline = document.getElementById("p-online")!;
const pVersion = document.getElementById("p-version")!;
const pSecret = document.getElementById("p-secret")!;
const pDetail = document.getElementById("p-detail")!;
const rulesList = document.getElementById("rulesList")!;
const ruleNew = document.getElementById("ruleNew") as HTMLButtonElement;
const ruleImport = document.getElementById("ruleImport") as HTMLButtonElement;
const ruleExport = document.getElementById("ruleExport") as HTMLButtonElement;
const ruleImportFile = document.getElementById(
  "ruleImportFile",
) as HTMLInputElement;
const importModeBox = document.getElementById("importMode")!;
const ruleImportGo = document.getElementById("ruleImportGo") as HTMLButtonElement;

let pendingImportJson: string | null = null;

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

function renderRules(store: RulesStore) {
  rulesList.innerHTML = "";
  if (!store.rules.length) {
    const li = document.createElement("li");
    li.innerHTML = `<div class="meta"><div class="sub">No rules yet.</div></div>`;
    rulesList.appendChild(li);
    return;
  }
  for (const r of store.rules) {
    const li = document.createElement("li");
    if (!r.enabled) li.classList.add("disabled");
    const host = r.hosts[0] ?? "(no host)";
    const extra =
      r.hosts.length > 1 ? ` +${r.hosts.length - 1}` : "";
    const path = r.pathPrefix.trim() ? r.pathPrefix : "(any path)";
    li.innerHTML = `
      <div class="meta">
        <div class="host"></div>
        <div class="sub"></div>
      </div>
      <div class="row-actions">
        <button type="button" class="linkish edit">Edit</button>
        <button type="button" class="linkish del">Delete</button>
      </div>`;
    li.querySelector(".host")!.textContent = `${host}${extra}`;
    li.querySelector(".sub")!.textContent =
      `${path} · ${r.selectors.length} selector${r.selectors.length === 1 ? "" : "s"}` +
      (r.note ? ` · ${r.note}` : "") +
      (r.enabled ? "" : " · off");
    li.querySelector(".edit")!.addEventListener("click", () => {
      void send({ type: "options/openRulesEditor", ruleId: r.id });
    });
    li.querySelector(".del")!.addEventListener("click", () => {
      void (async () => {
        if (!confirm(`Delete rule for ${host}?`)) return;
        const next = await send<RulesStore>({ type: "rules/delete", id: r.id });
        renderRules(next);
      })();
    });
    rulesList.appendChild(li);
  }
}

async function loadRules() {
  try {
    const store = await send<RulesStore>({ type: "rules/getStore" });
    renderRules(store);
  } catch (e) {
    flash(e instanceof Error ? e.message : String(e), "err");
  }
}

async function load() {
  try {
    const settings = await send<Settings>({ type: "options/getSettings" });
    secretInput.value = settings.secret ?? "";
  } catch (e) {
    flash(e instanceof Error ? e.message : String(e), "err");
  }
  await runProbe({ quiet: true });
  await loadRules();
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

ruleNew.addEventListener("click", () => {
  void send({ type: "options/openRulesEditor" });
});

ruleExport.addEventListener("click", () => {
  void (async () => {
    try {
      const { json } = await send<{ json: string }>({ type: "rules/export" });
      const blob = new Blob([json], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "etc-speech-site-rules.json";
      a.click();
      URL.revokeObjectURL(a.href);
      flash("Exported.", "ok");
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), "err");
    }
  })();
});

ruleImport.addEventListener("click", () => {
  ruleImportFile.click();
});

ruleImportFile.addEventListener("change", () => {
  const file = ruleImportFile.files?.[0];
  if (!file) return;
  void file.text().then((text) => {
    pendingImportJson = text;
    importModeBox.classList.remove("hidden");
    flash("Choose merge mode, then Apply import.", "warn");
  });
  ruleImportFile.value = "";
});

ruleImportGo.addEventListener("click", () => {
  void (async () => {
    if (!pendingImportJson) {
      flash("Pick a file first.", "err");
      return;
    }
    const mode =
      (
        document.querySelector(
          'input[name="importMode"]:checked',
        ) as HTMLInputElement | null
      )?.value ?? "merge_union";
    try {
      const store = await send<RulesStore>({
        type: "rules/import",
        json: pendingImportJson,
        mode: mode as ImportMode,
      });
      pendingImportJson = null;
      importModeBox.classList.add("hidden");
      renderRules(store);
      flash("Import applied.", "ok");
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), "err");
    }
  })();
});

void load();
