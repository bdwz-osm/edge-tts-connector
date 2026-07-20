import { Readability } from "@mozilla/readability";
import { HARD_MAX, SOFT_MAX, splitSoft } from "./splitText";

export type Chunk = {
  i: number;
  text: string;
  anchor: number[];
};

export type ChunkMode = "page" | "selection";

export type ChunkPageResult = {
  chunks: Chunk[];
  root: Element;
  readabilityFailed: boolean;
};

export { SOFT_MAX, HARD_MAX, splitSoft };

const BLOCK_SEL =
  "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figcaption, dt, dd";

const EXCLUDE_SEL = [
  "nav",
  "aside",
  "footer",
  "header",
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "[aria-hidden='true']",
  "[role='navigation']",
  "[role='complementary']",
  "[role='banner']",
  "[role='contentinfo']",
].join(",");

export type ChunkOptions = {
  /** Per-site CSS destroy selectors (TTS skip + pre-Readability strip on clone). */
  destroySelectors?: string[];
};

function validSelectors(doc: Document, selectors: string[]): string[] {
  const out: string[] = [];
  for (const s of selectors) {
    const t = s.trim();
    if (!t) continue;
    try {
      doc.querySelector(t);
      out.push(t);
    } catch {
      /* invalid */
    }
  }
  return out;
}

function matchesDestroy(el: Element, selectors: string[]): boolean {
  for (const sel of selectors) {
    try {
      if (el.matches(sel)) return true;
      if (el.closest(sel)) return true;
    } catch {
      /* */
    }
  }
  return false;
}

function isExcluded(el: Element, destroy: string[]): boolean {
  if (el.closest(EXCLUDE_SEL)) return true;
  return matchesDestroy(el, destroy);
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function textLen(el: Element): number {
  return collapseWs(el.textContent ?? "").length;
}

function linkTextLen(el: Element): number {
  let n = 0;
  for (const a of el.querySelectorAll("a")) {
    n += collapseWs(a.textContent ?? "").length;
  }
  return n;
}

const CODE_ROOT_SKIP =
  "pre, code, .sourceCode, .highlight, .syntax, .hljs, [class*='highlight']";

export function pickRoot(doc: Document, destroy: string[] = []): Element {
  const body = doc.body;
  if (!body) return doc.documentElement;

  for (const sel of ["article", "[role='main']", "main"]) {
    const el = doc.querySelector(sel);
    if (el && textLen(el) > 200 && !isExcluded(el, destroy)) return el;
  }

  let best: Element = body;
  let bestScore = textLen(body) - 2 * linkTextLen(body);

  for (const el of body.querySelectorAll("div, section, main")) {
    if (isExcluded(el, destroy)) continue;
    if (el.matches(CODE_ROOT_SKIP)) continue;
    if (el.querySelector(":scope > pre, :scope > code") && textLen(el) < 500) {
      continue;
    }
    const tl = textLen(el);
    if (tl < 200) continue;
    const score = tl - 2 * linkTextLen(el);
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
}

function isVisible(el: Element): boolean {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return true;
  return style.display !== "none" && style.visibility !== "hidden";
}

/** Visible text under el; skips global EXCLUDE, destroy selectors, hidden. */
export function visibleText(el: Element, destroy: string[] = []): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? "";
      if (t.trim()) parts.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const e = node as Element;
    if (isExcluded(e, destroy) || !isVisible(e)) return;
    for (const child of Array.from(e.childNodes)) walk(child);
  };
  walk(el);
  return collapseWs(parts.join(" "));
}

function stripDestroy(root: ParentNode, selectors: string[]): void {
  for (const sel of selectors) {
    try {
      for (const el of [...root.querySelectorAll(sel)]) {
        el.remove();
      }
    } catch {
      /* invalid selector */
    }
  }
}

/**
 * Parallel-stamp clone nodes so Readability's HTML can map back to live DOM.
 */
function stampParallel(
  live: Element,
  cloned: Element,
  map: Map<string, Element>,
  counter: { n: number },
): void {
  const id = `e${counter.n++}`;
  cloned.setAttribute("data-etc-nid", id);
  map.set(id, live);
  const lk = live.children;
  const ck = cloned.children;
  const n = Math.min(lk.length, ck.length);
  for (let i = 0; i < n; i++) {
    stampParallel(lk[i]!, ck[i]!, map, counter);
  }
}

function isLeafBlock(el: Element): boolean {
  return el.matches(BLOCK_SEL) && !el.querySelector(BLOCK_SEL);
}

/** Deepest element that contains every node; capped at `limit`. */
function commonAncestor(nodes: Element[], limit: Element): Element {
  if (!nodes.length) return limit;
  let anc: Element = nodes[0]!;
  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i]!;
    while (anc && !anc.contains(n)) {
      if (anc === limit) return limit;
      anc = anc.parentElement ?? limit;
    }
  }
  return anc ?? limit;
}

type ArticleMeta = {
  title?: string;
  byline?: string;
};

type RootResolve = {
  root: Element;
  failed: boolean;
  meta: ArticleMeta;
};

/**
 * Readability picks article text on a clone. Map back to a *container* on the
 * live DOM — never a single paragraph. Flat pandoc pages (Beej) have no
 * article/main wrapper: LCA of article nodes is body → pickRoot (body).
 */
function resolveReadabilityRoot(
  doc: Document,
  destroy: string[],
): RootResolve {
  const body = doc.body;
  if (!body) {
    return { root: doc.documentElement, failed: true, meta: {} };
  }

  const fallback = (meta: ArticleMeta = {}): RootResolve => ({
    root: pickRoot(doc, destroy),
    failed: true,
    meta,
  });

  try {
    const clone = doc.cloneNode(true) as Document;
    const cloneBody = clone.body;
    if (!cloneBody) return fallback();

    const map = new Map<string, Element>();
    stampParallel(body, cloneBody, map, { n: 0 });
    stripDestroy(clone, destroy);

    const article = new Readability(clone).parse();
    const meta: ArticleMeta = {
      title: collapseWs(article?.title ?? "") || undefined,
      byline: collapseWs(article?.byline ?? "") || undefined,
    };
    const articleLen = article?.textContent?.trim().length ?? 0;
    if (!article?.content || articleLen < 40) return fallback(meta);

    const wrap = doc.implementation.createHTMLDocument("");
    wrap.body.innerHTML = article.content;
    const lives: Element[] = [];
    for (const node of wrap.body.querySelectorAll("[data-etc-nid]")) {
      const id = node.getAttribute("data-etc-nid");
      if (!id) continue;
      const live = map.get(id);
      if (live && body.contains(live) && !isExcluded(live, destroy)) {
        lives.push(live);
      }
    }

    if (lives.length < 2) {
      return { root: pickRoot(doc, destroy), failed: false, meta };
    }

    let root = commonAncestor(lives, body);

    // Climb out of leaf blocks (a lone <p> must not be the chunk root).
    while (root !== body && isLeafBlock(root)) {
      root = root.parentElement ?? body;
    }

    // Structural article/main wins when present and substantial.
    for (const sel of ["article", "[role='main']", "main"]) {
      const el = doc.querySelector(sel);
      if (
        el &&
        body.contains(el) &&
        textLen(el) > 200 &&
        !isExcluded(el, destroy) &&
        textLen(el) >= articleLen * 0.5
      ) {
        return { root: el, failed: false, meta };
      }
    }

    const bodyLen = textLen(body);
    const rootLen = textLen(root);
    // Too small vs body/article, leaf, or itself excluded/destroy → pickRoot.
    if (
      root === body ||
      isLeafBlock(root) ||
      isExcluded(root, destroy) ||
      rootLen < 200 ||
      (bodyLen > 0 && rootLen < bodyLen * 0.35) ||
      rootLen < articleLen * 0.5
    ) {
      return { root: pickRoot(doc, destroy), failed: false, meta };
    }

    return { root, failed: false, meta };
  } catch {
    return fallback();
  }
}

/** Title/h1 just outside content root (hero above <article>, etc.). */
function findLeadTitleEl(root: Element, destroy: string[]): Element | null {
  if (root.querySelector("h1")) return null;
  let cur: Element | null = root;
  const body = root.ownerDocument?.body;
  while (cur && cur !== body) {
    let sib = cur.previousElementSibling;
    while (sib) {
      if (!isExcluded(sib, destroy)) {
        if (sib.matches("h1")) {
          const t = visibleText(sib, destroy);
          if (t.length >= 8 && t.length <= 300) return sib;
        }
        const h1 = sib.querySelector("h1");
        if (h1 && !isExcluded(h1, destroy)) {
          const t = visibleText(h1, destroy);
          if (t.length >= 8 && t.length <= 300) return h1;
        }
      }
      sib = sib.previousElementSibling;
    }
    cur = cur.parentElement;
  }
  return null;
}

/** Byline/author block near title or immediately before content root. */
function findLeadBylineEl(
  root: Element,
  titleEl: Element | null,
  destroy: string[],
): Element | null {
  // Prefer a local header/hero wrapper around the title; else its parent.
  const scope =
    titleEl?.closest(
      "header, [class*='hero' i], [class*='headline' i], [class*='post-header' i], [class*='article-header' i], [class*='entry-header' i]",
    ) ??
    titleEl?.parentElement ??
    null;

  const tryEl = (el: Element | null): Element | null => {
    if (!el || isExcluded(el, destroy)) return null;
    if (
      el.matches(
        ".byline, [class*='byline'], [itemprop='author'], .author, .by-line",
      )
    ) {
      return el;
    }
    const inner = el.querySelector(
      ".byline, [class*='byline'], [itemprop='author'], .author, [rel='author']",
    );
    return inner && !isExcluded(inner, destroy) ? inner : null;
  };

  if (scope) {
    const hit = tryEl(scope) ?? tryEl(scope.querySelector(".byline"));
    if (hit) return hit;
  }

  let cur: Element | null = root;
  const body = root.ownerDocument?.body;
  while (cur && cur !== body) {
    let sib = cur.previousElementSibling;
    while (sib) {
      const hit = tryEl(sib);
      if (hit) return hit;
      sib = sib.previousElementSibling;
    }
    cur = cur.parentElement;
  }
  return null;
}

function authorNamesFromByline(byline: Element, destroy: string[]): string {
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const t = collapseWs(s);
    if (!t || t.length > 80) return;
    // Skip pure dates / separators.
    if (/^\d|^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(t)) {
      return;
    }
    if (seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    names.push(t);
  };

  // Schema.org / rel=author / common CMS author URL patterns — not site-specific classes.
  const nameSels = [
    "[itemprop='name']",
    "[itemprop='author'] [itemprop='name']",
    "[itemprop='author']",
    "a[rel='author']",
    "a[href*='/author/'] span",
    "a[href*='/author/']",
    "a[href*='/authors/'] span",
    "a[href*='/authors/']",
    "[class*='author' i] a span",
    "[class*='author' i] a",
  ];
  for (const sel of nameSels) {
    try {
      for (const el of byline.querySelectorAll(sel)) {
        if (isExcluded(el, destroy)) continue;
        push(el.textContent ?? "");
      }
    } catch {
      /* */
    }
  }
  if (names.length) return names.join(", ");

  // Last resort: short byline text without times.
  const raw = visibleText(byline, destroy);
  const cleaned = raw
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/gi, "")
    .replace(/\bat\s+\d{1,2}:\d{2}\s*(am|pm)?\b/gi, "")
    .replace(/[·•|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length <= 80 ? cleaned : "";
}

function cleanDocTitle(doc: Document): string {
  const t = collapseWs(doc.title ?? "");
  if (!t) return "";
  // "Article Title | Site" / "Article Title - Site"
  const parts = t.split(/\s+[|\-–—]\s+/);
  if (parts.length >= 2 && parts[0]!.length >= 8) return parts[0]!;
  return t.length <= 300 ? t : t.slice(0, 300);
}

function textsRoughlyEqual(a: string, b: string): boolean {
  const norm = (s: string) =>
    collapseWs(s)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/gi, "");
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * Title + author often live in a hero/header *outside* the content root
 * (article body). Prepend when missing. Prefer live nodes; else Readability
 * title/byline; else cleaned document.title.
 */
function leadInChunks(
  doc: Document,
  root: Element,
  destroy: string[],
  meta: ArticleMeta,
): Chunk[] {
  const out: Chunk[] = [];
  let i = 0;
  const bodyTextSample = visibleText(root, destroy).slice(0, 400);

  // Title already under root (e.g. Beej h1) → chunker will read it in order.
  const titleInRoot = root.querySelector("h1");
  let titleText = "";
  let titleEl: Element | null = titleInRoot;

  if (titleInRoot && !isExcluded(titleInRoot, destroy)) {
    titleText = visibleText(titleInRoot, destroy);
  } else {
    titleEl = findLeadTitleEl(root, destroy);
    if (titleEl) titleText = visibleText(titleEl, destroy);
    if (!titleText && meta.title) {
      titleText = meta.title;
      titleEl = null;
    }
    if (!titleText) {
      titleText = cleanDocTitle(doc);
      titleEl = null;
    }

    if (
      titleText &&
      titleText.length >= 8 &&
      !textsRoughlyEqual(
        titleText,
        bodyTextSample.slice(0, titleText.length + 10),
      )
    ) {
      // Outside root → no anchor (highlight root is the article).
      for (const part of splitSoft(titleText)) {
        out.push({ i: i++, text: part.slice(0, HARD_MAX), anchor: [] });
      }
    }
  }

  const bylineInRoot = root.querySelector(
    ".byline, [class*='byline'], [itemprop='author'], .author",
  );
  let author = "";
  let bylineEl: Element | null = null;
  if (bylineInRoot && !isExcluded(bylineInRoot, destroy)) {
    bylineEl = bylineInRoot;
    author = authorNamesFromByline(bylineInRoot, destroy);
  }
  if (!author) {
    bylineEl = findLeadBylineEl(root, titleEl, destroy);
    if (bylineEl) author = authorNamesFromByline(bylineEl, destroy);
  }
  if (!author && meta.byline) {
    author = collapseWs(meta.byline);
    bylineEl = null;
  }

  // Only prepend author when missing from root walk (or we want it first).
  const authorAlreadyInBody =
    author &&
    bodyTextSample.toLowerCase().includes(author.toLowerCase().slice(0, 24));
  if (
    author &&
    !authorAlreadyInBody &&
    !textsRoughlyEqual(author, titleText)
  ) {
    const spoken = /^by\b/i.test(author) ? author : `by ${author}`;
    const useAnchor =
      bylineEl && root.contains(bylineEl)
        ? childIndexPath(root, bylineEl)
        : [];
    out.push({ i: i++, text: spoken.slice(0, HARD_MAX), anchor: useAnchor });
  }

  return out;
}

/** Element-child indices from root to el. */
export function childIndexPath(root: Element, el: Element): number[] {
  if (root === el) return [];
  if (!root.contains(el)) return [];
  const path: number[] = [];
  let cur: Element | null = el;
  while (cur && cur !== root) {
    const parent: Element | null = cur.parentElement;
    if (!parent) return [];
    const kids = Array.from(parent.children);
    const idx = kids.indexOf(cur);
    if (idx < 0) return [];
    path.push(idx);
    cur = parent;
  }
  if (cur !== root) return [];
  path.reverse();
  return path;
}

export function resolveAnchor(root: Element, path: number[]): Element | null {
  let cur: Element = root;
  for (const idx of path) {
    const kids = Array.from(cur.children);
    if (idx < 0 || idx >= kids.length) return null;
    cur = kids[idx]!;
  }
  return cur;
}

function buildChunks(
  root: Element,
  destroy: string[],
  startIndex = 0,
): Chunk[] {
  const chunks: Chunk[] = [];
  let i = startIndex;

  for (const el of root.querySelectorAll(BLOCK_SEL)) {
    if (isExcluded(el, destroy) || !root.contains(el)) continue;
    if (el.querySelector(BLOCK_SEL)) continue;
    const t = visibleText(el, destroy);
    if (!t) continue;
    const anchor = childIndexPath(root, el);
    for (const part of splitSoft(t)) {
      chunks.push({ i, text: part.slice(0, HARD_MAX), anchor });
      i++;
    }
  }

  if (chunks.length === 0 && startIndex === 0) {
    const t = visibleText(root, destroy);
    for (const part of splitSoft(t)) {
      chunks.push({ i, text: part.slice(0, HARD_MAX), anchor: [] });
      i++;
    }
  }
  return chunks;
}

function reindex(chunks: Chunk[]): Chunk[] {
  return chunks.map((c, i) => ({ ...c, i }));
}

export function chunkPage(
  doc: Document,
  opts?: ChunkOptions,
): ChunkPageResult {
  const destroy = validSelectors(doc, opts?.destroySelectors ?? []);
  const { root, failed, meta } = resolveReadabilityRoot(doc, destroy);
  const lead = leadInChunks(doc, root, destroy, meta);
  const body = buildChunks(root, destroy, lead.length);
  // Drop body chunks that duplicate lead title/author.
  const leadTexts = new Set(lead.map((c) => collapseWs(c.text).toLowerCase()));
  const filtered = body.filter((c) => {
    const t = collapseWs(c.text).toLowerCase();
    if (leadTexts.has(t)) return false;
    for (const lt of leadTexts) {
      if (lt.length >= 12 && (t === lt || t.startsWith(lt + " "))) return false;
    }
    return true;
  });
  const chunks = reindex([...lead, ...filtered]);
  return { chunks, root, readabilityFailed: failed };
}

export function chunkSelection(
  sel: Selection,
  opts?: ChunkOptions,
): Chunk[] {
  const baseDoc =
    sel.rangeCount > 0
      ? sel.getRangeAt(0).commonAncestorContainer.ownerDocument
      : null;
  const doc = baseDoc ?? document;
  const destroy = validSelectors(doc, opts?.destroySelectors ?? []);
  let t = collapseWs(sel.toString());
  if (!t) return [];

  // Re-extract from range DOM so destroy selectors strip footnote chips etc.
  if (sel.rangeCount > 0) {
    try {
      const range = sel.getRangeAt(0);
      const frag = range.cloneContents();
      const holder = doc.createElement("div");
      holder.appendChild(frag);
      stripDestroy(holder, destroy);
      const extracted = collapseWs(holder.textContent ?? "");
      if (extracted) t = extracted;
    } catch {
      /* keep selection string */
    }
  }

  let anchor: number[] = [];
  if (sel.rangeCount > 0) {
    const node = sel.getRangeAt(0).commonAncestorContainer;
    const el =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement;
    if (el?.ownerDocument) {
      const root = pickRoot(el.ownerDocument, destroy);
      if (root.contains(el)) anchor = childIndexPath(root, el);
    }
  }
  const chunks: Chunk[] = [];
  let i = 0;
  for (const part of splitSoft(t)) {
    chunks.push({ i, text: part.slice(0, HARD_MAX), anchor });
    i++;
  }
  return chunks;
}

export function nearestChunkIndex(
  root: Element,
  chunks: Chunk[],
  target: Element,
  destroy: string[] = [],
): number {
  if (!chunks.length) return 0;

  const anyAnchored = chunks.some((c) => c.anchor.length > 0);
  if (!anyAnchored) {
    return nearestByTextOffset(root, chunks, target, destroy);
  }

  let cur: Element | null = target;
  while (cur && root.contains(cur)) {
    const path = childIndexPath(root, cur);
    const key = path.join(",");
    const exact = chunks.findIndex((c) => c.anchor.join(",") === key);
    if (exact >= 0) return exact;
    cur = cur.parentElement;
  }
  for (let i = 0; i < chunks.length; i++) {
    const el = resolveAnchor(root, chunks[i]!.anchor);
    if (el && el.contains(target)) return i;
  }
  return 0;
}

function nearestByTextOffset(
  root: Element,
  chunks: Chunk[],
  target: Element,
  destroy: string[],
): number {
  const full = visibleText(root, destroy);
  if (!full) return 0;
  const targetText = visibleText(target, destroy);
  let offset = 0;
  if (targetText && full.includes(targetText)) {
    offset = full.indexOf(targetText);
  } else {
    offset = visibleTextOffsetBefore(root, target, destroy);
  }
  let acc = 0;
  for (let i = 0; i < chunks.length; i++) {
    const len = chunks[i]!.text.length;
    if (offset < acc + len) return i;
    acc += len + 1;
  }
  return chunks.length - 1;
}

function visibleTextOffsetBefore(
  root: Element,
  target: Element,
  destroy: string[],
): number {
  if (!root.contains(target)) return 0;
  let offset = 0;
  let found = false;
  const walk = (node: Node) => {
    if (found) return;
    if (node === target) {
      found = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      if (parent && !isExcluded(parent, destroy) && isVisible(parent)) {
        const t = collapseWs(node.textContent ?? "");
        if (t) offset += t.length + 1;
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const e = node as Element;
    if (isExcluded(e, destroy) || !isVisible(e)) return;
    if (e === target) {
      found = true;
      return;
    }
    for (const child of Array.from(e.childNodes)) {
      walk(child);
      if (found) return;
    }
  };
  walk(root);
  return offset;
}
