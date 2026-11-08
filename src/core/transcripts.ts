// Reads Claude Code transcripts (~/.claude/projects/<project>/<session>.jsonl)
// and extracts every file edit together with the prompt that led to it.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface Prompt {
  /** What the user typed (or the task given to a subagent). */
  text: string;
  uuid: string;
  timestamp: string;
}

export interface Edit {
  /** tool_use id, unique per edit. */
  id: string;
  sessionId: string;
  transcript: string;
  /** uuid of the transcript entry holding the tool call. */
  uuid: string;
  timestamp: string;
  /** Absolute path of the edited file. */
  file: string;
  tool: 'Edit' | 'Write' | 'MultiEdit';
  /** Pairs of (old, new) text. For Write, old is ''. */
  changes: { old: string; new: string }[];
  model?: string;
  gitBranch?: string;
  cwd?: string;
  /** Set when the edit was made by a subagent. */
  agent?: string;
  prompt?: Prompt;
  /** What Claude said right before making the edit. */
  note?: string;
}

export interface Session {
  id: string;
  transcript: string;
  cwd?: string;
  title?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const NOTE_MAX = 1200;
const PROMPT_MAX = 4000;

/** Claude Code's config dir. */
export function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Project folders are named after the session's cwd with every non-alphanumeric char replaced by '-'. */
export function encodeProjectPath(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Transcript files that may contain edits to files under `folder`: sessions started
 * in the folder, in a subfolder, or in a parent folder.
 */
export function findTranscripts(folder: string, base = path.join(claudeDir(), 'projects')): string[] {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(base);
  } catch {
    return [];
  }
  const enc = encodeProjectPath(path.resolve(folder));
  const out: string[] = [];
  for (const d of dirs) {
    const related = enc === d || enc.startsWith(d + '-') || d.startsWith(enc + '-');
    if (!related) continue;
    const dir = path.join(base, d);
    for (const f of safeReaddir(dir)) {
      if (f.endsWith('.jsonl')) out.push(path.join(dir, f));
      const sub = path.join(dir, f, 'subagents');
      for (const s of safeReaddir(sub)) if (s.endsWith('.jsonl')) out.push(path.join(sub, s));
    }
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

interface Node {
  parent: string | null;
  prompt?: Prompt;
  note?: string;
}

/** Text of a real user prompt, or null for tool results, meta messages and the like. */
export function promptText(entry: any): string | null {
  if (entry.type !== 'user' || entry.isMeta || entry.isCompactSummary || entry.toolUseResult !== undefined) return null;
  const content = entry.message?.content;
  let text: string | null = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((c: any) => c?.type === 'tool_result')) return null;
    const parts = content.filter((c: any) => c?.type === 'text').map((c: any) => c.text);
    if (parts.length) text = parts.join('\n');
  }
  if (text == null) return null;
  // Slash commands: "<command-name>/review</command-name><command-args>42</command-args>"
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
    return `${cmd[1].trim()}${args && args[1].trim() ? ' ' + args[1].trim() : ''}`;
  }
  if (/^\s*<(local-command-|system-reminder|bash-|task-notification)/.test(text)) return null;
  if (text.startsWith('[Request interrupted')) return null;
  text = text.trim();
  return text ? text.slice(0, PROMPT_MAX) : null;
}

function assistantText(entry: any): string | null {
  if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) return null;
  const t = entry.message.content.filter((c: any) => c?.type === 'text' && c.text?.trim()).map((c: any) => c.text.trim());
  return t.length ? t.join('\n\n') : null;
}

/** The (old, new) text pairs of an Edit / Write / MultiEdit tool call. */
export function changesOf(tool: string, input: any): { old: string; new: string }[] {
  if (tool === 'Write' && typeof input?.content === 'string') return [{ old: '', new: input.content }];
  if (tool === 'Edit' && typeof input?.new_string === 'string') return [{ old: input.old_string ?? '', new: input.new_string }];
  if (tool === 'MultiEdit' && Array.isArray(input?.edits)) {
    return input.edits.filter((x: any) => typeof x?.new_string === 'string').map((x: any) => ({ old: x.old_string ?? '', new: x.new_string }));
  }
  return [];
}

export interface ParsedTranscript {
  session: Session;
  edits: Edit[];
}

/**
 * Incremental transcript parser: feed it the file as it grows.
 * Edits whose tool call failed are dropped.
 */
export class TranscriptParser {
  private nodes = new Map<string, Node>();
  private edits: Edit[] = [];
  private failed = new Set<string>();
  private rest = '';
  private lastPrompt?: Prompt;
  private lastNote?: string;
  private readonly isSubagent: boolean;
  readonly session: Session;

  constructor(readonly file: string) {
    this.isSubagent = path.basename(path.dirname(file)) === 'subagents';
    this.session = { id: path.basename(file, '.jsonl'), transcript: file };
  }

  feed(chunk: string): void {
    const text = this.rest + chunk;
    const lines = text.split('\n');
    this.rest = lines.pop() ?? '';
    for (const line of lines) this.line(line);
  }

  /** Call at the end of the file: parses a last line without a newline, if complete. */
  flush(): void {
    if (this.rest.trim()) {
      try {
        JSON.parse(this.rest);
        this.line(this.rest);
        this.rest = '';
      } catch {
        // still being written
      }
    }
  }

  result(): ParsedTranscript {
    const edits = this.edits.filter((e) => !this.failed.has(e.id));
    const session = { ...this.session };
    if (!session.title) session.title = edits[0]?.prompt?.text.split('\n')[0].slice(0, 80);
    return { session, edits };
  }

  private line(line: string): void {
    if (!line.trim()) return;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    const session = this.session;
    if (e.type === 'summary' && e.summary && !session.title) session.title = e.summary;
    if (e.type === 'custom-title' && e.customTitle) session.title = e.customTitle;
    if (!e.uuid) return;
    if (e.sessionId) session.id = e.sessionId;
    if (e.cwd && !session.cwd) session.cwd = e.cwd;
    if (e.timestamp) {
      session.firstTimestamp ??= e.timestamp;
      session.lastTimestamp = e.timestamp;
    }

    const node: Node = { parent: e.parentUuid ?? e.logicalParentUuid ?? null };
    const p = promptText(e);
    if (p) {
      node.prompt = { text: p, uuid: e.uuid, timestamp: e.timestamp };
      this.lastPrompt = node.prompt;
      this.lastNote = undefined;
    }
    const note = assistantText(e);
    if (note) {
      node.note = note.length > NOTE_MAX ? note.slice(0, NOTE_MAX) + '…' : note;
      this.lastNote = node.note;
    }
    this.nodes.set(e.uuid, node);

    if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) if (c?.type === 'tool_result' && c.is_error) this.failed.add(c.tool_use_id);
    }
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) return;
    for (const c of e.message.content) {
      if (c?.type !== 'tool_use' || !EDIT_TOOLS.has(c.name)) continue;
      const input = c.input ?? {};
      if (typeof input.file_path !== 'string') continue;
      const changes = changesOf(c.name, input);
      if (!changes.length) continue;
      const { prompt, note } = this.context(e.uuid);
      this.edits.push({
        id: c.id,
        sessionId: session.id,
        transcript: this.file,
        uuid: e.uuid,
        timestamp: e.timestamp,
        file: path.resolve(e.cwd ?? '/', input.file_path),
        tool: c.name,
        changes,
        model: e.message.model,
        gitBranch: e.gitBranch,
        cwd: e.cwd,
        agent: this.isSubagent || e.isSidechain ? e.agentId ?? path.basename(this.file, '.jsonl').replace(/^agent-/, '') : undefined,
        prompt,
        note,
      });
    }
  }

  /** Walk up the conversation tree to the prompt that started this turn. */
  private context(uuid: string): { prompt?: Prompt; note?: string } {
    let note: string | undefined;
    let cur: string | null = uuid;
    for (let hops = 0; cur && hops < 10000; hops++) {
      const n = this.nodes.get(cur);
      if (!n) break;
      if (!note && n.note) note = n.note;
      if (n.prompt) return { prompt: n.prompt, note };
      cur = n.parent;
    }
    // Chain broken (e.g. by compaction): fall back to file order.
    return { prompt: this.lastPrompt, note: note ?? this.lastNote };
  }
}

export function parseTranscript(file: string, text: string): ParsedTranscript {
  const p = new TranscriptParser(file);
  p.feed(text);
  p.flush();
  return p.result();
}
