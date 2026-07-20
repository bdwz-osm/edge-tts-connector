import browser from "webextension-polyfill";

export const RULES_STORAGE_KEY = "siteRules";
export const RULES_DRAFT_KEY = "siteRuleDraft";
export const RULES_SEED_VERSION = 1;

export type SiteRule = {
  id: string;
  /** Exact hosts and/or `*.example.com` patterns (subdomains + apex). */
  hosts: string[];
  /** Empty = whole host; otherwise pathname must start with this. */
  pathPrefix: string;
  selectors: string[];
  enabled: boolean;
  note?: string;
  /** Built-in seed id; stable across upgrades. */
  seedId?: string;
};

export type RulesStore = {
  version: 1;
  seedVersion: number;
  rules: SiteRule[];
};

export type RuleDraft = {
  ruleId: string | null;
  hostsText: string;
  pathPrefix: string;
  selectorsText: string;
  note: string;
  enabled: boolean;
  updatedAt: number;
};

export type ImportMode = "replace_all" | "merge_union" | "merge_replace_key";

const WIKIPEDIA_SEED: SiteRule = {
  id: "seed-wikipedia-footnotes",
  seedId: "wikipedia-footnotes",
  hosts: ["*.wikipedia.org"],
  pathPrefix: "",
  selectors: [
    "sup.reference",
    "sup[id^='cite_ref']",
    ".mw-editsection",
    "span.mw-cite-backlink",
  ],
  enabled: true,
  note: "Footnote markers and section edit links",
};

function emptyStore(): RulesStore {
  return { version: 1, seedVersion: 0, rules: [] };
}

export function newRuleId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** Normalize hostname: lowercase, strip trailing dot. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Default hosts for a new rule from the active tab:
 * exact host + www/non-www twin when applicable.
 */
export function defaultHostsForTab(hostname: string): string[] {
  const h = normalizeHost(hostname);
  if (!h) return [];
  const out = new Set<string>([h]);
  if (h.startsWith("www.")) out.add(h.slice(4));
  else if (h.split(".").length === 2) out.add(`www.${h}`);
  return [...out];
}

/** `*.example.com` matches example.com and any subdomain. */
export function hostMatches(pattern: string, hostname: string): boolean {
  const p = normalizeHost(pattern);
  const h = normalizeHost(hostname);
  if (!p || !h) return false;
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    if (!base) return false;
    return h === base || h.endsWith(`.${base}`);
  }
  return h === p;
}

export function pathMatches(prefix: string, pathname: string): boolean {
  const p = prefix.trim();
  if (!p) return true;
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  let pref = p.startsWith("/") ? p : `/${p}`;
  if (path === pref || path === pref.replace(/\/$/, "")) return true;
  if (!pref.endsWith("/")) pref = `${pref}/`;
  return path.startsWith(pref);
}

export function ruleKey(rule: Pick<SiteRule, "hosts" | "pathPrefix">): string {
  const hosts = [...rule.hosts].map(normalizeHost).filter(Boolean).sort();
  return `${hosts.join(",")}\n${rule.pathPrefix.trim()}`;
}

export function ruleMatches(
  rule: SiteRule,
  hostname: string,
  pathname: string,
): boolean {
  if (!rule.enabled) return false;
  if (!rule.hosts.some((h) => hostMatches(h, hostname))) return false;
  return pathMatches(rule.pathPrefix, pathname);
}

/** Most specific match: longest pathPrefix among host matches; then first. */
export function matchRules(
  rules: SiteRule[],
  hostname: string,
  pathname: string,
): SiteRule[] {
  return rules
    .filter((r) => ruleMatches(r, hostname, pathname))
    .sort((a, b) => b.pathPrefix.trim().length - a.pathPrefix.trim().length);
}

export function selectorsForPage(
  rules: SiteRule[],
  hostname: string,
  pathname: string,
): string[] {
  const matched = matchRules(rules, hostname, pathname);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of matched) {
    for (const s of r.selectors) {
      const t = String(s).trim();
      // Comment lines only stripped at parse time; "#" is a valid CSS id prefix.
      if (!t) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

export function parseSelectorLines(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    // Whole-line comments only. CSS id selectors (`#comments`) stay.
    if (t.startsWith("//") || t === "#" || t.startsWith("# ")) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function parseHostsText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const t = normalizeHost(line.replace(/^https?:\/\//, "").split("/")[0] ?? "");
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function ensureSeeds(store: RulesStore): RulesStore {
  if (store.seedVersion >= RULES_SEED_VERSION) return store;
  const rules = [...store.rules];
  const hasWiki = rules.some((r) => r.seedId === WIKIPEDIA_SEED.seedId);
  if (!hasWiki) {
    rules.push({ ...WIKIPEDIA_SEED, id: WIKIPEDIA_SEED.id });
  }
  return {
    version: 1,
    seedVersion: RULES_SEED_VERSION,
    rules,
  };
}

function coerceStore(raw: unknown): RulesStore {
  if (!raw || typeof raw !== "object") return ensureSeeds(emptyStore());
  const o = raw as Partial<RulesStore>;
  const rules = Array.isArray(o.rules)
    ? o.rules.filter(isSiteRule)
    : [];
  return ensureSeeds({
    version: 1,
    seedVersion: typeof o.seedVersion === "number" ? o.seedVersion : 0,
    rules,
  });
}

function isStringArray(a: unknown): a is string[] {
  return Array.isArray(a) && a.every((x) => typeof x === "string");
}

function isSiteRule(x: unknown): x is SiteRule {
  if (!x || typeof x !== "object") return false;
  const r = x as SiteRule;
  return (
    typeof r.id === "string" &&
    isStringArray(r.hosts) &&
    typeof r.pathPrefix === "string" &&
    isStringArray(r.selectors) &&
    typeof r.enabled === "boolean"
  );
}

export async function getRulesStore(): Promise<RulesStore> {
  const got = await browser.storage.local.get(RULES_STORAGE_KEY);
  const store = coerceStore(got[RULES_STORAGE_KEY]);
  // Persist seeds if we just injected them.
  const prev = got[RULES_STORAGE_KEY] as RulesStore | undefined;
  if (
    !prev ||
    prev.seedVersion !== store.seedVersion ||
    prev.rules?.length !== store.rules.length
  ) {
    await browser.storage.local.set({ [RULES_STORAGE_KEY]: store });
  }
  return store;
}

export async function setRulesStore(store: RulesStore): Promise<RulesStore> {
  const next: RulesStore = {
    version: 1,
    seedVersion: store.seedVersion,
    rules: store.rules.filter(isSiteRule),
  };
  await browser.storage.local.set({ [RULES_STORAGE_KEY]: next });
  return next;
}

export async function upsertRule(rule: SiteRule): Promise<RulesStore> {
  const store = await getRulesStore();
  const idx = store.rules.findIndex((r) => r.id === rule.id);
  const rules = [...store.rules];
  if (idx >= 0) rules[idx] = rule;
  else rules.push(rule);
  return setRulesStore({ ...store, rules });
}

export async function deleteRule(id: string): Promise<RulesStore> {
  const store = await getRulesStore();
  return setRulesStore({
    ...store,
    rules: store.rules.filter((r) => r.id !== id),
  });
}

export function exportRulesJson(store: RulesStore): string {
  return JSON.stringify(
    {
      version: 1 as const,
      rules: store.rules.map((r) => ({
        id: r.id,
        hosts: r.hosts,
        pathPrefix: r.pathPrefix,
        selectors: r.selectors,
        enabled: r.enabled,
        note: r.note,
        seedId: r.seedId,
      })),
    },
    null,
    2,
  );
}

export function parseImportJson(text: string): SiteRule[] {
  const data = JSON.parse(text) as { rules?: unknown };
  if (!Array.isArray(data.rules)) throw new Error("Invalid file: missing rules[]");
  const rules = data.rules.filter(isSiteRule);
  if (!rules.length && data.rules.length) {
    throw new Error("Invalid file: no usable rules");
  }
  return rules.map((r) => ({
    ...r,
    id: r.id || newRuleId(),
    hosts: r.hosts.map((h) => normalizeHost(String(h))).filter(Boolean),
    pathPrefix: r.pathPrefix ?? "",
    selectors: r.selectors.map((s) => String(s).trim()).filter(Boolean),
    enabled: r.enabled !== false,
  }));
}

export function mergeImported(
  existing: SiteRule[],
  incoming: SiteRule[],
  mode: ImportMode,
): SiteRule[] {
  if (mode === "replace_all") {
    return incoming.map((r) => ({ ...r, id: r.id || newRuleId() }));
  }

  const byKey = new Map<string, SiteRule>();
  for (const r of existing) byKey.set(ruleKey(r), { ...r });

  for (const inc of incoming) {
    const key = ruleKey(inc);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...inc, id: inc.id || newRuleId() });
      continue;
    }
    if (mode === "merge_replace_key") {
      byKey.set(key, { ...inc, id: prev.id });
      continue;
    }
    // merge_union
    const sel = new Set([...prev.selectors, ...inc.selectors]);
    const hosts = new Set([
      ...prev.hosts.map(normalizeHost),
      ...inc.hosts.map(normalizeHost),
    ]);
    byKey.set(key, {
      ...prev,
      hosts: [...hosts].filter(Boolean),
      selectors: [...sel].filter(Boolean),
      enabled: prev.enabled || inc.enabled,
      note: inc.note?.trim() ? inc.note : prev.note,
      seedId: prev.seedId ?? inc.seedId,
    });
  }
  return [...byKey.values()];
}

export async function getRuleDraft(): Promise<RuleDraft | null> {
  const got = await browser.storage.local.get(RULES_DRAFT_KEY);
  const d = got[RULES_DRAFT_KEY];
  if (!d || typeof d !== "object") return null;
  return d as RuleDraft;
}

export async function setRuleDraft(draft: RuleDraft | null): Promise<void> {
  if (!draft) {
    await browser.storage.local.remove(RULES_DRAFT_KEY);
    return;
  }
  await browser.storage.local.set({ [RULES_DRAFT_KEY]: draft });
}

/** Best existing rule for editor open-from-tab. */
export function findBestRuleForPage(
  rules: SiteRule[],
  hostname: string,
  pathname: string,
): SiteRule | null {
  const m = matchRules(rules, hostname, pathname);
  return m[0] ?? null;
}
