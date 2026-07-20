export const SOFT_MAX = 500;
export const HARD_MAX = 2000;

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Strong sentence boundaries. */
const SENTENCE_RE = /(?<=[.!?…])\s+|(?<=[。！？；])|(?<=;)\s+/;

/** Weaker clause breaks (only when still over SOFT_MAX). */
const CLAUSE_RE = /(?<=:)\s+|(?<=—)\s+|(?<=–)\s+|(?<=,)\s+/;

/**
 * Pack pieces into chunks ≤ max, joining with single spaces.
 * Oversized single pieces are passed through for a later rung.
 */
function pack(parts: string[], max: number): string[] {
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = "";
    }
  };
  for (const raw of parts) {
    const s = collapseWs(raw);
    if (!s) continue;
    if (s.length > max) {
      flush();
      out.push(s);
      continue;
    }
    const next = buf ? `${buf} ${s}` : s;
    if (next.length <= max) buf = next;
    else {
      flush();
      buf = s;
    }
  }
  flush();
  return out;
}

/** Split at last whitespace ≤ max; repeat. No space → hard slices of max. */
function wrapWhitespace(s: string, max: number): string[] {
  const t = collapseWs(s);
  if (!t) return [];
  if (t.length <= max) return [t];
  const out: string[] = [];
  let rest = t;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut < 1) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

function hardSlice(s: string, max: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += max) {
    out.push(s.slice(i, i + max));
  }
  return out;
}

/**
 * Ladder: sentence → clause → whitespace wrap at SOFT_MAX → HARD_MAX hard slice.
 * Prefer breaking near whitespace even on the hard rung when possible.
 */
export function splitSoft(text: string): string[] {
  const t = collapseWs(text);
  if (!t) return [];
  if (t.length <= SOFT_MAX) return [t];

  let parts = pack(t.split(SENTENCE_RE), SOFT_MAX);

  const refine = (re: RegExp): void => {
    const next: string[] = [];
    for (const p of parts) {
      if (p.length <= SOFT_MAX) next.push(p);
      else next.push(...pack(p.split(re), SOFT_MAX));
    }
    parts = next;
  };

  if (parts.some((p) => p.length > SOFT_MAX)) refine(CLAUSE_RE);

  const afterClause: string[] = [];
  for (const p of parts) {
    if (p.length <= SOFT_MAX) afterClause.push(p);
    else afterClause.push(...wrapWhitespace(p, SOFT_MAX));
  }
  parts = afterClause;

  const final: string[] = [];
  for (const p of parts) {
    if (p.length <= HARD_MAX) {
      final.push(p);
      continue;
    }
    // Prefer whitespace near HARD_MAX, else blind slice.
    const wrapped = wrapWhitespace(p, HARD_MAX);
    for (const w of wrapped) {
      if (w.length <= HARD_MAX) final.push(w);
      else final.push(...hardSlice(w, HARD_MAX));
    }
  }
  return final;
}
