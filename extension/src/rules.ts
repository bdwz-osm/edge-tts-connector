import browser from "webextension-polyfill";
import type { RulesStore, SiteRule, RuleDraft } from "./siteRules";
import {
  newRuleId,
  parseHostsText,
  parseSelectorLines,
  defaultHostsForTab,
  RULES_DRAFT_KEY,
} from "./siteRules";

const hostsEl = document.getElementById("hosts") as HTMLTextAreaElement;
const pathEl = document.getElementById("pathPrefix") as HTMLInputElement;
const selEl = document.getElementById("selectors") as HTMLTextAreaElement;
const noteEl = document.getElementById("note") as HTMLInputElement;
const enabledEl = document.getElementById("enabled") as HTMLInputElement;
const titleEl = document.getElementById("title")!;
const msgEl = document.getElementById("msg")!;
const draftHint = document.getElementById("draftHint")!;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const revertBtn = document.getElementById("revert") as HTMLButtonElement;

const params = new URLSearchParams(location.search);
const wantTab = params.get("tab") === "1";
const urlId = params.get("id");
const paramHost = params.get("host") ?? "";
const paramPath = params.get("path") ?? "";
const paramHosts = (params.get("hosts") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let ruleId: string | null = urlId;
let baseline: SiteRule | null = null;
let draftTimer: ReturnType<typeof setTimeout> | null = null;
/** Prefill snapshot for Revert when creating from a tab. */
let tabPrefill: Partial<SiteRule> | null = null;

async function send<T>(msg: Record<string, unknown>): Promise<T> {
  return (await browser.runtime.sendMessage(msg)) as T;
}

function flash(text: string, kind: "ok" | "err" | "warn") {
  msgEl.hidden = false;
  msgEl.textContent = text;
  msgEl.className = `msg ${kind}`;
}

function ruleFromForm(): SiteRule {
  return {
    id: ruleId ?? newRuleId(),
    hosts: parseHostsText(hostsEl.value),
    pathPrefix: pathEl.value.trim(),
    selectors: parseSelectorLines(selEl.value),
    enabled: enabledEl.checked,
    note: noteEl.value.trim() || undefined,
    seedId: baseline?.seedId,
  };
}

function fillForm(
  r: Partial<SiteRule> & { hostsText?: string; selectorsText?: string },
) {
  hostsEl.value = r.hostsText ?? (r.hosts ?? []).join("\n");
  pathEl.value = r.pathPrefix ?? "";
  selEl.value = r.selectorsText ?? (r.selectors ?? []).join("\n");
  noteEl.value = r.note ?? "";
  enabledEl.checked = r.enabled !== false;
}

function scheduleDraft() {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    draftTimer = null;
    void saveDraft();
  }, 250);
}

function flushDraft() {
  if (!draftTimer) return;
  clearTimeout(draftTimer);
  draftTimer = null;
  void saveDraft();
}

async function saveDraft() {
  const draft: RuleDraft = {
    ruleId,
    hostsText: hostsEl.value,
    pathPrefix: pathEl.value,
    selectorsText: selEl.value,
    note: noteEl.value,
    enabled: enabledEl.checked,
    updatedAt: Date.now(),
  };
  await browser.storage.local.set({ [RULES_DRAFT_KEY]: draft });
  draftHint.textContent = "Draft saved";
}

window.addEventListener("pagehide", flushDraft);
window.addEventListener("beforeunload", flushDraft);

async function clearDraft() {
  await browser.storage.local.remove(RULES_DRAFT_KEY);
}

function hostsFromParams(): string[] {
  if (paramHosts.length) return paramHosts;
  if (paramHost) return defaultHostsForTab(paramHost);
  return [];
}

/** Restore draft only when it looks like work on this same target. */
function draftApplies(
  draft: RuleDraft | undefined,
  targetRuleId: string | null,
): draft is RuleDraft {
  if (!draft || Date.now() - draft.updatedAt >= 864e5) return false;
  if (draft.ruleId !== targetRuleId) return false;
  // Don't clobber a fresh tab prefill with an empty leftover draft.
  if (targetRuleId === null && wantTab) {
    const dh = draft.hostsText.trim();
    if (!dh && !draft.selectorsText.trim()) return false;
  }
  return true;
}

async function load() {
  const store = await send<RulesStore>({ type: "rules/getStore" });
  const draftGot = await browser.storage.local.get(RULES_DRAFT_KEY);
  const draft = draftGot[RULES_DRAFT_KEY] as RuleDraft | undefined;

  // Prefer URL context (captured before this tab became active).
  if (wantTab && !ruleId) {
    const hosts = hostsFromParams();
    if (hosts.length) {
      ruleId = null;
      titleEl.textContent = "New site rule";
      tabPrefill = {
        hosts,
        pathPrefix: "",
        selectors: [],
        enabled: true,
      };
      fillForm(tabPrefill);
      baseline = null;
      if (draftApplies(draft, null)) {
        fillForm({
          hostsText: draft.hostsText,
          pathPrefix: draft.pathPrefix,
          selectorsText: draft.selectorsText,
          note: draft.note,
          enabled: draft.enabled,
        });
        flash("Restored unsaved draft.", "warn");
      }
      bind();
      return;
    }
    // Fallback: ask background (may fail if this tab is now active).
    try {
      const ctx = await send<{
        host: string;
        pathname: string;
        hosts: string[];
        matchRuleId: string | null;
      }>({ type: "rules/tabContext" });
      if (ctx.matchRuleId) {
        ruleId = ctx.matchRuleId;
      } else if (ctx.hosts.length) {
        ruleId = null;
        titleEl.textContent = "New site rule";
        tabPrefill = {
          hosts: ctx.hosts,
          pathPrefix: "",
          selectors: [],
          enabled: true,
        };
        fillForm(tabPrefill);
        baseline = null;
        if (draftApplies(draft, null)) {
          fillForm({
            hostsText: draft.hostsText,
            pathPrefix: draft.pathPrefix,
            selectorsText: draft.selectorsText,
            note: draft.note,
            enabled: draft.enabled,
          });
          flash("Restored unsaved draft.", "warn");
        }
        bind();
        return;
      }
    } catch {
      /* */
    }
  }

  if (ruleId) {
    const found = store.rules.find((r) => r.id === ruleId) ?? null;
    if (found) {
      baseline = { ...found };
      titleEl.textContent = found.hosts[0] ?? "Site rule";
      fillForm(found);
      if (draftApplies(draft, ruleId)) {
        fillForm({
          hostsText: draft.hostsText,
          pathPrefix: draft.pathPrefix,
          selectorsText: draft.selectorsText,
          note: draft.note,
          enabled: draft.enabled,
        });
        flash("Restored unsaved draft.", "warn");
      }
    } else {
      flash("Rule not found.", "err");
      ruleId = null;
      titleEl.textContent = "New site rule";
      const hosts = hostsFromParams();
      tabPrefill = {
        hosts,
        pathPrefix: paramPath || "",
        selectors: [],
        enabled: true,
      };
      fillForm(tabPrefill);
    }
  } else {
    titleEl.textContent = "New site rule";
    baseline = null;
    const hosts = hostsFromParams();
    tabPrefill = {
      hosts,
      pathPrefix: "",
      selectors: [],
      enabled: true,
    };
    fillForm(tabPrefill);
    if (draftApplies(draft, null)) {
      fillForm({
        hostsText: draft.hostsText,
        pathPrefix: draft.pathPrefix,
        selectorsText: draft.selectorsText,
        note: draft.note,
        enabled: draft.enabled,
      });
    }
  }
  bind();
}

function bind() {
  for (const el of [hostsEl, pathEl, selEl, noteEl, enabledEl]) {
    el.addEventListener("input", scheduleDraft);
    el.addEventListener("change", scheduleDraft);
  }

  revertBtn.addEventListener("click", () => {
    void (async () => {
      await clearDraft();
      if (baseline) fillForm(baseline);
      else if (tabPrefill) fillForm(tabPrefill);
      else fillForm({ hosts: [], pathPrefix: "", selectors: [], enabled: true, note: "" });
      flash("Reverted.", "ok");
    })();
  });

  saveBtn.addEventListener("click", () => {
    void (async () => {
      const rule = ruleFromForm();
      if (!rule.hosts.length) {
        flash("Add at least one host.", "err");
        return;
      }
      saveBtn.disabled = true;
      try {
        await send({ type: "rules/upsert", rule });
        ruleId = rule.id;
        baseline = { ...rule };
        await clearDraft();
        const u = new URL(location.href);
        u.searchParams.set("id", rule.id);
        u.searchParams.delete("tab");
        history.replaceState(null, "", u.toString());
        titleEl.textContent = rule.hosts[0] ?? "Site rule";
        flash("Saved.", "ok");
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e), "err");
      } finally {
        saveBtn.disabled = false;
      }
    })();
  });
}

void load();
