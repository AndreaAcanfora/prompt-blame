// prompt-blame CLI: the same attribution as the VS Code extension, in a terminal.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { TranscriptIndex } from './core/index';
import { attribute, stats } from './core/attribution';
import { modelName, oneLine, relativeTime } from './core/render';
import type { Edit } from './core/transcripts';

const VERSION = '0.1.0';
const HELP = `prompt-blame ${VERSION} - git blame for AI code (Claude Code)

Usage:
  prompt-blame <file>              show which lines Claude wrote, and the prompt behind them
  prompt-blame <file>:<line>       full prompt, Claude's note and the diff for one line
  prompt-blame stats [dir]         share of each file that is still exactly as Claude wrote it

Options:
  --json               machine-readable output
  --claude-dir <dir>   Claude Code config dir (default: $CLAUDE_CONFIG_DIR or ~/.claude)
  --no-color
`;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const opt = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};

const json = flag('--json');
const noColor = flag('--no-color') || !!process.env.NO_COLOR || !process.stdout.isTTY;
const claudeDir = opt('--claude-dir');
const PALETTE = [39, 208, 170, 114, 220, 75, 204, 141, 79, 215];
const c = (code: string, s: string) => (noColor ? s : `\x1b[${code}m${s}\x1b[0m`);
const dim = (s: string) => c('2', s);
const bold = (s: string) => c('1', s);
const tint = (n: number, s: string) => c(`38;5;${PALETTE[n % PALETTE.length]}`, s);

function repoRoot(p: string): string {
  let dir = fs.statSync(p).isDirectory() ? p : path.dirname(p);
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return dir;
  }
}

async function index(folder: string): Promise<TranscriptIndex> {
  const idx = new TranscriptIndex(claudeDir ? path.join(claudeDir, 'projects') : undefined);
  await idx.refresh([folder]);
  return idx;
}

function editLabel(e: Edit): string {
  return [relativeTime(e.timestamp), modelName(e.model), e.agent ? 'subagent' : '', `session ${e.sessionId.slice(0, 8)}`].filter(Boolean).join(' · ');
}

async function blame(file: string): Promise<number> {
  const abs = path.resolve(file);
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const idx = await index(repoRoot(abs));
  const attr = attribute(lines, idx.editsFor(abs));
  // One number per prompt (a prompt can lead to several edits).
  const key = (e: Edit) => e.prompt?.uuid ?? e.id;
  const order: Edit[] = [];
  for (const a of attr) if (a && !order.some((o) => key(o) === key(a.edit))) order.push(a.edit);
  order.sort((x, y) => (x.timestamp < y.timestamp ? -1 : 1));
  const byKey = new Map(order.map((e, i) => [key(e), i + 1]));
  const num = { get: (e: Edit) => byKey.get(key(e)) };

  if (json) {
    const out = {
      file: abs,
      lines: attr.map((a, i) => ({ line: i + 1, edit: a ? a.edit.id : null, prompt: a ? num.get(a.edit) : null, confidence: a?.confidence })),
      edits: order.map((e) => ({ id: e.id, session: e.sessionId, time: e.timestamp, model: e.model, prompt: e.prompt?.text, note: e.note, transcript: e.transcript })),
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  }

  const w = String(lines.length).length;
  const tagW = String(order.length).length + 1;
  let prev: Edit | null = null;
  lines.forEach((l, i) => {
    const a = attr[i];
    const n = a ? num.get(a.edit)! : 0;
    const tag = a ? (prev && key(a.edit) === key(prev) ? ' '.repeat(tagW) : `#${n}`.padEnd(tagW)) : ' '.repeat(tagW);
    prev = a ? a.edit : null;
    const gutter = a ? tint(n - 1, `${tag} ▌`) : `${' '.repeat(tagW)}  `;
    console.log(`${gutter}${dim(String(i + 1).padStart(w))}  ${a ? l : dim(l)}`);
  });
  const st = stats(lines, attr);
  console.log('');
  console.log(bold(`${st.ai} of ${st.total} non-blank lines (${pct(st.ai, st.total)}) are exactly as Claude wrote them`) + dim(`  [${idx.transcriptCount} transcripts scanned]`));
  for (const e of order) {
    const n = num.get(e)!;
    console.log(`\n${tint(n - 1, bold(`#${n}`))}  ${dim(editLabel(e))}`);
    console.log(`    ${e.prompt ? `“${oneLine(e.prompt.text, 110)}”` : dim('(prompt not found)')}`);
  }
  return 0;
}

async function show(file: string, line: number): Promise<number> {
  const abs = path.resolve(file);
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const idx = await index(repoRoot(abs));
  const a = attribute(lines, idx.editsFor(abs))[line - 1];
  if (!a) {
    console.log(json ? 'null' : `${file}:${line} was not written by Claude, or was changed since (no matching edit in ${idx.transcriptCount} transcripts)`);
    return 1;
  }
  const e = a.edit;
  if (json) {
    process.stdout.write(JSON.stringify({ ...e, confidence: a.confidence }, null, 2) + '\n');
    return 0;
  }
  console.log(bold(`${file}:${line}`) + dim(`  ${editLabel(e)}${e.gitBranch && e.gitBranch !== 'HEAD' ? ` · branch ${e.gitBranch}` : ''}`));
  console.log(`\n${bold('Prompt')}\n${e.prompt?.text ?? dim('(not found)')}`);
  if (e.note) console.log(`\n${bold('Claude')}\n${e.note}`);
  console.log(`\n${bold(e.tool)} ${dim(e.file)}`);
  for (const ch of e.changes) {
    for (const l of ch.old ? ch.old.split('\n') : []) console.log(c('31', `- ${l}`));
    for (const l of ch.new.split('\n')) console.log(c('32', `+ ${l}`));
  }
  console.log(dim(`\nTranscript: ${e.transcript}`));
  return 0;
}

async function statsCmd(dir: string): Promise<number> {
  const root = path.resolve(dir);
  const idx = await index(root);
  const rows: { file: string; ai: number; total: number }[] = [];
  for (const f of idx.filesUnder(root)) {
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const st = stats(lines, attribute(lines, idx.editsFor(f)));
    if (st.ai) rows.push({ file: path.relative(root, f), ai: st.ai, total: st.total });
  }
  rows.sort((x, y) => y.ai - x.ai);
  if (json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return 0;
  }
  if (!rows.length) {
    console.log(`No lines written by Claude found under ${root} (${idx.transcriptCount} transcripts scanned).`);
    return 0;
  }
  const ai = rows.reduce((s, r) => s + r.ai, 0);
  const total = rows.reduce((s, r) => s + r.total, 0);
  for (const r of rows) console.log(`${pct(r.ai, r.total).padStart(5)}  ${bar(r.ai / r.total)}  ${String(r.ai).padStart(5)}/${String(r.total).padEnd(5)}  ${r.file}`);
  console.log(bold(`\n${ai} of ${total} lines in ${rows.length} files touched by Claude are exactly as it wrote them (${pct(ai, total)})`));
  return 0;
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '0%');
const bar = (f: number) => {
  const n = Math.round(f * 20);
  return c('36', '█'.repeat(n)) + dim('░'.repeat(20 - n));
};

async function main(): Promise<number> {
  if (flag('--version') || flag('-v')) {
    console.log(VERSION);
    return 0;
  }
  if (!args.length || flag('--help') || flag('-h')) {
    process.stdout.write(HELP);
    return args.length ? 0 : 2;
  }
  if (args[0] === 'stats') return statsCmd(args[1] ?? '.');
  const m = /^(.*):(\d+)$/.exec(args[0]);
  if (m && fs.existsSync(m[1])) return show(m[1], Number(m[2]));
  if (!fs.existsSync(args[0])) {
    console.error(`prompt-blame: no such file: ${args[0]}`);
    return 2;
  }
  return blame(args[0]);
}

main().then(
  (code) => (process.exitCode = code),
  (e) => {
    console.error(`prompt-blame: ${e?.message ?? e}`);
    process.exitCode = 1;
  },
);
