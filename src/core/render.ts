// Turn a transcript into readable Markdown, focused on one edit.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { changesOf, promptText } from './transcripts';
import { addedLines } from './attribution';

const TEXT_MAX = 3000;

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  const units: [number, string][] = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [86400 * 30, 'month'], [86400 * 365, 'year']];
  let unit = units[0];
  for (const u of units) if (s >= u[0]) unit = u;
  const n = Math.floor(s / unit[0]);
  return `${n} ${unit[1]}${n === 1 ? '' : 's'} ago`;
}

export function oneLine(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function modelName(model?: string): string {
  if (!model || model === '<synthetic>') return 'Claude';
  // claude-opus-4-1-20250805 -> Opus 4.1
  const m = /claude-(?:(\d+)-(?:(\d+)-)?)?(opus|sonnet|haiku|fable)(?:-(\d{1,2})(?!\d)(?:-(\d{1,2})(?!\d))?)?/.exec(model);
  if (!m) return model;
  const family = m[3][0].toUpperCase() + m[3].slice(1);
  const major = m[4] ?? m[1];
  const minor = m[4] ? m[5] : m[2];
  return major ? `${family} ${major}${minor ? '.' + minor : ''}` : family;
}

const fence = (text: string, lang = '') => {
  const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`{3,}/g)].map((m) => m[0].length + 1)));
  return `${ticks}${lang}\n${text}\n${ticks}`;
};

const clip = (t: string, max = TEXT_MAX) => (t.length > max ? t.slice(0, max) + `\n\n*… ${t.length - max} more characters*` : t);

function quote(text: string): string {
  return text.split('\n').map((l) => `> ${l}`).join('\n');
}

export function diffBlock(changes: { old: string; new: string }[]): string {
  const lines: string[] = [];
  for (const c of changes) {
    const added = new Set(addedLines(c.old, c.new));
    const oldSet = new Set(c.new.split('\n'));
    for (const l of c.old ? c.old.split('\n') : []) if (!oldSet.has(l)) lines.push(`- ${l}`);
    for (const l of c.new.split('\n')) lines.push(`${added.has(l) ? '+' : ' '} ${l}`);
    lines.push('');
  }
  const body = lines.join('\n').trimEnd();
  return fence(body.length > 8000 ? body.slice(0, 8000) + '\n…' : body, 'diff');
}

/**
 * Render the conversation around the tool call `focusId` (the turn that produced it,
 * plus `context` prompts before and after).
 */
export function renderConversation(transcript: string, focusId?: string, context = 2): string {
  const raw = fs.readFileSync(transcript, 'utf8');
  type Turn = { prompt?: string; time?: string; parts: string[]; hasFocus: boolean };
  const turns: Turn[] = [{ parts: [], hasFocus: false }];
  let cwd: string | undefined;
  let branch: string | undefined;
  let first: string | undefined;
  let title: string | undefined;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === 'summary' && e.summary) title ??= e.summary;
    if (e.type === 'custom-title' && e.customTitle) title = e.customTitle;
    if (!e.uuid) continue;
    cwd ??= e.cwd;
    branch ??= e.gitBranch;
    first ??= e.timestamp;
    const p = promptText(e);
    if (p) {
      turns.push({ prompt: p, time: e.timestamp, parts: [], hasFocus: false });
      continue;
    }
    const turn = turns[turns.length - 1];
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const c of e.message.content) {
      if (c?.type === 'text' && c.text?.trim()) turn.parts.push(clip(c.text.trim()));
      if (c?.type !== 'tool_use') continue;
      const input = c.input ?? {};
      if (focusId && c.id === focusId) {
        turn.hasFocus = true;
        turn.parts.push(`**👉 This is the edit you asked about:** \`${c.name}\` ${mdPath(input.file_path, cwd)}\n\n${diffBlock(changesOf(c.name, input))}`);
      } else {
        turn.parts.push(`<sub>🔧 \`${c.name}\` ${toolSummary(c.name, input, cwd)}</sub>`);
      }
    }
  }

  let from = 0;
  let to = turns.length - 1;
  const fi = turns.findIndex((t) => t.hasFocus);
  if (fi >= 0) {
    from = Math.max(0, fi - context);
    to = Math.min(turns.length - 1, fi + context);
  }
  const out: string[] = [];
  const firstPrompt = turns.find((t) => t.prompt)?.prompt;
  out.push(`# ${title ? oneLine(title, 100) : firstPrompt ? oneLine(firstPrompt, 60) : 'Claude Code conversation'}`);
  const meta = [first && new Date(first).toLocaleString(), cwd && `\`${cwd}\``, branch && branch !== 'HEAD' && `branch \`${branch}\``, `\`${path.basename(transcript)}\``].filter(Boolean);
  out.push(`<sub>${meta.join(' · ')}</sub>`);
  if (from > 0) out.push(`*${from} earlier prompt${from === 1 ? '' : 's'} not shown.*`);
  for (let i = from; i <= to; i++) {
    const t = turns[i];
    if (!t.prompt && !t.parts.length) continue;
    out.push('---');
    if (t.prompt) out.push(`### 🧑 Prompt${t.time ? ` <sub>${new Date(t.time).toLocaleString()}</sub>` : ''}\n\n${quote(clip(t.prompt))}`);
    if (t.parts.length) out.push(`### ✦ Claude\n\n${t.parts.join('\n\n')}`);
  }
  if (to < turns.length - 1) out.push(`---\n\n*${turns.length - 1 - to} later prompt${turns.length - 1 - to === 1 ? '' : 's'} not shown.*`);
  return out.join('\n\n') + '\n';
}

function mdPath(p: unknown, cwd?: string): string {
  if (typeof p !== 'string') return '';
  const rel = cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p;
  return `\`${rel}\``;
}

function toolSummary(name: string, input: any, cwd?: string): string {
  if (input.file_path) return mdPath(input.file_path, cwd);
  if (name === 'Bash' && typeof input.command === 'string') return `\`${oneLine(input.command, 100).replace(/`/g, "'")}\``;
  if (typeof input.pattern === 'string') return `\`${oneLine(input.pattern, 60).replace(/`/g, "'")}\``;
  if (typeof input.description === 'string') return oneLine(input.description, 100);
  if (typeof input.url === 'string') return input.url;
  return '';
}
