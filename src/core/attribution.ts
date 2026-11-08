// Decide which lines of a file are still exactly as an AI edit wrote them.

import type { Edit } from './transcripts';

export interface LineAttribution {
  edit: Edit;
  /** 0..1, how well the surrounding lines agree with this edit. */
  confidence: number;
}

const WINDOW = 3;

export const norm = (l: string) => l.replace(/\s+$/, '').replace(/^\s+/, '');

/** A line too generic to attribute on its own: blank, "}", "});", "end", "</div>", "*\/", ... */
export function isTrivial(line: string): boolean {
  const t = norm(line);
  if (t.length === 0) return true;
  if (/^[\s{}()[\];,.:<>/*#'"`|&=+-]*$/.test(t)) return true;
  return /^(end|fi|done|esac|else|try|finally|return;?|break;?|continue;?|pass|<\/[a-zA-Z0-9-]+>|\/\/|#|"""|''')$/.test(t);
}

/** Lines of `next` that are not in `prev` (line-level LCS diff). */
export function addedLines(prev: string, next: string): string[] {
  const a = prev === '' ? [] : prev.split('\n');
  const b = next.split('\n');
  if (!a.length) return b;
  // Trim common prefix/suffix first: keeps the LCS table small for typical edits.
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const A = a.slice(s, ea);
  const B = b.slice(s, eb);
  if (!A.length) return B;
  if (A.length * B.length > 4_000_000) return B; // pathological: treat all as added
  const n = A.length;
  const m = B.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && A[i] === B[j]) { i++; j++; }
    else if (i < n && dp[i + 1][j] >= dp[i][j + 1]) i++;
    else out.push(B[j++]);
  }
  return out;
}

/**
 * Attribute each line of `lines` to the most plausible edit that wrote it.
 * A line is attributed when its text (ignoring indentation) was added by an edit
 * and is still unchanged. Among candidates, the edit that also wrote the most
 * neighbouring lines wins; ties go to the most recent edit. Trivial lines
 * (blank, braces) are attributed only when both neighbours agree.
 */
export function attribute(lines: string[], edits: Edit[]): (LineAttribution | null)[] {
  const sorted = [...edits].sort((x, y) => (x.timestamp < y.timestamp ? -1 : x.timestamp > y.timestamp ? 1 : 0));
  // normalized line -> edit indexes (in time order) that added it
  const byLine = new Map<string, number[]>();
  const sets: Set<string>[] = sorted.map((e, idx) => {
    const set = new Set<string>();
    for (const c of e.changes) for (const l of addedLines(c.old, c.new)) set.add(norm(l));
    for (const l of set) {
      let arr = byLine.get(l);
      if (!arr) byLine.set(l, (arr = []));
      arr.push(idx);
    }
    return set;
  });

  const normed = lines.map(norm);
  const result: (LineAttribution | null)[] = new Array(lines.length).fill(null);

  for (let i = 0; i < lines.length; i++) {
    if (isTrivial(lines[i])) continue;
    const cands = byLine.get(normed[i]);
    if (!cands) continue;
    let best = -1;
    let bestScore = -1;
    let window = 0;
    for (const idx of cands) {
      let score = 0;
      let seen = 0;
      for (let k = Math.max(0, i - WINDOW); k <= Math.min(lines.length - 1, i + WINDOW); k++) {
        if (k === i || isTrivial(lines[k])) continue;
        seen++;
        if (sets[idx].has(normed[k])) score++;
      }
      // later edits win ties (>=)
      if (score >= bestScore) { best = idx; bestScore = score; window = seen; }
    }
    const confidence = window === 0 ? 1 : Math.min(1, (bestScore + 1) / (window + 1));
    result[i] = { edit: sorted[best], confidence };
  }

  // Trivial lines: attribute when the nearest non-trivial lines above and below come from the same edit.
  for (let i = 0; i < lines.length; i++) {
    if (result[i] || !isTrivial(lines[i]) || normed[i] === '') continue;
    let up = i - 1;
    while (up >= 0 && isTrivial(lines[up]) && !result[up]) up--;
    let down = i + 1;
    while (down < lines.length && isTrivial(lines[down])) down++;
    const a = up >= 0 ? result[up] : null;
    const b = down < lines.length ? result[down] : null;
    // Both neighbours agree, or the line is the first/last of the file right next to an attributed line.
    const edit = a && b ? (a.edit === b.edit ? a.edit : null) : a && down >= lines.length && up === i - 1 ? a.edit : b && up < 0 && down === i + 1 ? b.edit : null;
    if (edit && sets[sorted.indexOf(edit)].has(normed[i])) result[i] = { edit, confidence: Math.min(a?.confidence ?? 1, b?.confidence ?? 1) };
  }
  // Blank lines inside a block written by one edit.
  for (let i = 0; i < lines.length; i++) {
    if (result[i] || normed[i] !== '') continue;
    const a = result[i - 1];
    let down = i + 1;
    while (down < lines.length && normed[down] === '') down++;
    const b = result[down];
    if (a && b && a.edit === b.edit) result[i] = { edit: a.edit, confidence: Math.min(a.confidence, b.confidence) };
  }
  return result;
}

export interface FileStats {
  total: number;
  ai: number;
  /** Lines per session id, most first. */
  sessions: { sessionId: string; lines: number; edits: Edit[] }[];
}

export function stats(lines: string[], attr: (LineAttribution | null)[]): FileStats {
  const total = lines.filter((l) => norm(l) !== '').length;
  let ai = 0;
  const per = new Map<string, { lines: number; edits: Set<Edit> }>();
  attr.forEach((a, i) => {
    if (!a || norm(lines[i]) === '') return;
    ai++;
    let s = per.get(a.edit.sessionId);
    if (!s) per.set(a.edit.sessionId, (s = { lines: 0, edits: new Set() }));
    s.lines++;
    s.edits.add(a.edit);
  });
  const sessions = [...per.entries()]
    .map(([sessionId, v]) => ({ sessionId, lines: v.lines, edits: [...v.edits] }))
    .sort((x, y) => y.lines - x.lines);
  return { total, ai, sessions };
}
