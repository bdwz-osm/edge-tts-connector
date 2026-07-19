export type Chunk = {
  i: number;
  text: string;
  anchor: number[];
};

export type ChunkMode = "page" | "selection";

export const SOFT_MAX = 500;
export const HARD_MAX = 2000;

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

function isExcluded(el: Element): boolean {
  return Boolean(el.closest(EXCLUDE_SEL));
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

export function pickRoot(doc: Document): Element {
  const body = doc.body;
  if (!body) return doc.documentElement;

  for (const sel of ["article", "[role='main']", "main"]) {
    const el = doc.querySelector(sel);
    if (el && textLen(el) > 200 && !isExcluded(el)) return el;
  }

  let best: Element | null = null;
  let bestScore = -Infinity;
  for (const el of body.querySelectorAll("div, section, main")) {
    if (isExcluded(el)) continue;
    const score = textLen(el) - 2 * linkTextLen(el);
    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best ?? body;
}

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) {
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (!style) return true;
    return style.display !== "none" && style.visibility !== "hidden";
  }
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (!style) return true;
  if (style.display === "none" || style.visibility === "hidden") return false;
  return true;
}

/** Visible text under el; skips excluded subtrees and hidden nodes. */
export function visibleText(el: Element): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? "";
      if (t.trim()) parts.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const e = node as Element;
    if (isExcluded(e) || !isVisible(e)) return;
    for (const child of Array.from(e.childNodes)) walk(child);
  };
  walk(el);
  return collapseWs(parts.join(" "));
}

const SENTENCE_RE = /(?<=[.!?…])\s+|(?<=[。！？；;])/;

export function splitSoft(text: string): string[] {
  const t = collapseWs(text);
  if (!t) return [];
  if (t.length <= SOFT_MAX) return [t];

  const sentences = t.split(SENTENCE_RE).filter(Boolean);
  const out: string[] = [];
  let buf = "";

  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = "";
    }
  };

  const hardSlice = (s: string) => {
    for (let i = 0; i < s.length; i += HARD_MAX) {
      out.push(s.slice(i, i + HARD_MAX));
    }
  };

  for (const raw of sentences) {
    const s = collapseWs(raw);
    if (!s) continue;
    if (s.length > SOFT_MAX) {
      flush();
      if (s.length > HARD_MAX) hardSlice(s);
      else out.push(s);
      continue;
    }
    const next = buf ? `${buf} ${s}` : s;
    if (next.length <= SOFT_MAX) buf = next;
    else {
      flush();
      buf = s;
    }
  }
  flush();
  return out;
}

/** Element-child indices from root to el (inclusive path ends at el). */
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

export function chunkPage(doc: Document): Chunk[] {
  const root = pickRoot(doc);
  const chunks: Chunk[] = [];
  let i = 0;

  for (const el of root.querySelectorAll(BLOCK_SEL)) {
    if (isExcluded(el) || !root.contains(el)) continue;
    // Only leaf blocks — containers (blockquote>p, li>p) would duplicate text.
    if (el.querySelector(BLOCK_SEL)) continue;
    const t = visibleText(el);
    if (!t) continue;
    const anchor = childIndexPath(root, el);
    for (const part of splitSoft(t)) {
      chunks.push({ i, text: part.slice(0, HARD_MAX), anchor });
      i++;
    }
  }

  if (chunks.length === 0) {
    // visibleText already skips EXCLUDE + hidden subtrees.
    const t = visibleText(root);
    for (const part of splitSoft(t)) {
      chunks.push({ i, text: part.slice(0, HARD_MAX), anchor: [] });
      i++;
    }
  }

  return chunks;
}

export function chunkSelection(sel: Selection): Chunk[] {
  const t = collapseWs(sel.toString());
  if (!t) return [];
  let anchor: number[] = [];
  if (sel.rangeCount > 0) {
    const node = sel.getRangeAt(0).commonAncestorContainer;
    const el =
      node.nodeType === Node.ELEMENT_NODE
        ? (node as Element)
        : node.parentElement;
    if (el?.ownerDocument) {
      const root = pickRoot(el.ownerDocument);
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

/** Nearest chunk index for a target element under root. */
export function nearestChunkIndex(
  root: Element,
  chunks: Chunk[],
  target: Element,
): number {
  if (!chunks.length) return 0;

  const anyAnchored = chunks.some((c) => c.anchor.length > 0);
  if (!anyAnchored) {
    // Fallback mode (all anchor: []): map by text offset within root.
    return nearestByTextOffset(root, chunks, target);
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

/** Cumulative visible-text offsets → chunk index (fallback RFH). */
function nearestByTextOffset(
  root: Element,
  chunks: Chunk[],
  target: Element,
): number {
  const full = visibleText(root);
  if (!full) return 0;
  const targetText = visibleText(target);
  let offset = 0;
  if (targetText && full.includes(targetText)) {
    offset = full.indexOf(targetText);
  } else {
    // Walk preceding visible text length before target within root.
    offset = visibleTextOffsetBefore(root, target);
  }
  let acc = 0;
  for (let i = 0; i < chunks.length; i++) {
    const len = chunks[i]!.text.length;
    if (offset < acc + len) return i;
    acc += len + 1; // splitSoft joins with spaces roughly
  }
  return chunks.length - 1;
}

function visibleTextOffsetBefore(root: Element, target: Element): number {
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
      if (parent && !isExcluded(parent) && isVisible(parent)) {
        const t = collapseWs(node.textContent ?? "");
        if (t) offset += t.length + 1;
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const e = node as Element;
    if (isExcluded(e) || !isVisible(e)) return;
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
