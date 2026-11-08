import * as vscode from 'vscode';
import * as path from 'node:path';
import { TranscriptIndex } from './core/index';
import { attribute, stats, type FileStats, type LineAttribution } from './core/attribution';
import { modelName, oneLine, relativeTime, renderConversation } from './core/render';
import { claudeDir, type Edit } from './core/transcripts';

const SCHEME = 'prompt-blame';
const COLORS = ['#3b82f6', '#f97316', '#a855f7', '#22c55e', '#eab308', '#06b6d4', '#ec4899', '#84cc16'];

interface FileState {
  version: number;
  attr: (LineAttribution | null)[];
  stats: FileStats;
  /** prompt -> color slot */
  colors: Map<string, number>;
}

let index: TranscriptIndex;
const cache = new Map<string, FileState>();
let highlightOn = false;
let lineDecoration: vscode.TextEditorDecorationType;
let highlightDecorations: vscode.TextEditorDecorationType[] = [];
let status: vscode.StatusBarItem;
let refreshTimer: NodeJS.Timeout | undefined;
let refreshing: Promise<void> | undefined;

const promptKey = (e: Edit) => e.prompt?.uuid ?? e.id;
const cfg = () => vscode.workspace.getConfiguration('promptBlame');

export function activate(context: vscode.ExtensionContext): void {
  const dir = cfg().get<string>('claudeDir') || claudeDir();
  index = new TranscriptIndex(path.join(dir, 'projects'));
  highlightOn = context.workspaceState.get('highlight', cfg().get<boolean>('highlight', false));

  lineDecoration = vscode.window.createTextEditorDecorationType({
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 3em', fontStyle: 'italic' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  highlightDecorations = COLORS.map((color) =>
    vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: color,
      backgroundColor: color + '1c',
      overviewRulerColor: color + 'aa',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    }),
  );

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'promptBlame.toggleHighlight';

  context.subscriptions.push(
    lineDecoration,
    ...highlightDecorations,
    status,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new ConversationProvider()),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, { provideHover }),
    vscode.commands.registerCommand('promptBlame.toggleHighlight', async () => {
      highlightOn = !highlightOn;
      await context.workspaceState.update('highlight', highlightOn);
      updateAll();
    }),
    vscode.commands.registerCommand('promptBlame.openConversation', openConversation),
    vscode.commands.registerCommand('promptBlame.copyPrompt', copyPrompt),
    vscode.commands.registerCommand('promptBlame.fileReport', fileReport),
    vscode.commands.registerCommand('promptBlame.refresh', async () => {
      cache.clear();
      await refresh(true);
      vscode.window.setStatusBarMessage(`Prompt Blame: ${index.transcriptCount} Claude Code transcripts scanned`, 4000);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => updateAll()),
    vscode.window.onDidChangeVisibleTextEditors(() => updateAll()),
    vscode.window.onDidChangeTextEditorSelection((e) => updateCurrentLine(e.textEditor)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) scheduleUpdate();
    }),
    vscode.workspace.onDidSaveTextDocument(() => refresh()),
    vscode.window.onDidChangeWindowState((s) => s.focused && refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => refresh(true)),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('promptBlame') && updateAll()),
  );

  const interval = Math.max(2, cfg().get<number>('refreshSeconds', 5)) * 1000;
  refreshTimer = setInterval(() => refresh(), interval);
  context.subscriptions.push({ dispose: () => refreshTimer && clearInterval(refreshTimer) });
  refresh(true);
}

export function deactivate(): void {}

// ------------------------------------------------------------------ state

function folders(): string[] {
  const f = (vscode.workspace.workspaceFolders ?? []).filter((w) => w.uri.scheme === 'file').map((w) => w.uri.fsPath);
  const doc = vscode.window.activeTextEditor?.document;
  if (doc?.uri.scheme === 'file' && !vscode.workspace.getWorkspaceFolder(doc.uri)) f.push(path.dirname(doc.uri.fsPath));
  return f;
}

function refresh(force = false): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = index
    .refresh(folders())
    .then((changed) => {
      if (changed || force) {
        cache.clear();
        updateAll();
      }
    })
    .catch(() => undefined)
    .finally(() => (refreshing = undefined));
  return refreshing;
}

function stateFor(doc: vscode.TextDocument): FileState | undefined {
  if (doc.uri.scheme !== 'file') return undefined;
  const key = doc.uri.fsPath;
  const hit = cache.get(key);
  if (hit && hit.version === doc.version) return hit;
  const edits = index.editsFor(key);
  if (!edits.length) {
    cache.delete(key);
    return undefined;
  }
  const lines: string[] = [];
  for (let i = 0; i < doc.lineCount; i++) lines.push(doc.lineAt(i).text);
  const attr = attribute(lines, edits);
  const st = stats(lines, attr);
  // One color per prompt, in the order they were written.
  const colors = new Map<string, number>();
  const keys = [...new Set(attr.filter((a): a is LineAttribution => !!a).sort((a, b) => (a.edit.timestamp < b.edit.timestamp ? -1 : 1)).map((a) => promptKey(a.edit)))];
  keys.forEach((k, i) => colors.set(k, i % COLORS.length));
  const state = { version: doc.version, attr, stats: st, colors };
  cache.set(key, state);
  return state;
}

// ------------------------------------------------------------------ rendering

let updateTimer: NodeJS.Timeout | undefined;
function scheduleUpdate(): void {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(updateAll, 300);
}

function updateAll(): void {
  for (const ed of vscode.window.visibleTextEditors) updateHighlights(ed);
  const active = vscode.window.activeTextEditor;
  if (active) updateCurrentLine(active);
  updateStatus();
}

function updateHighlights(ed: vscode.TextEditor): void {
  const st = highlightOn ? stateFor(ed.document) : undefined;
  const ranges: vscode.DecorationOptions[][] = COLORS.map(() => []);
  if (st) {
    st.attr.forEach((a, i) => {
      if (!a) return;
      ranges[st.colors.get(promptKey(a.edit)) ?? 0].push({ range: new vscode.Range(i, 0, i, 0) });
    });
  }
  highlightDecorations.forEach((d, i) => ed.setDecorations(d, ranges[i]));
}

function updateCurrentLine(ed: vscode.TextEditor): void {
  if (ed !== vscode.window.activeTextEditor) return;
  const st = cfg().get<boolean>('currentLine', true) ? stateFor(ed.document) : undefined;
  const line = ed.selection.active.line;
  const a = st?.attr[line];
  if (!a || ed.selections.length > 1) {
    ed.setDecorations(lineDecoration, []);
    return;
  }
  const e = a.edit;
  const text = `✦ ${modelName(e.model)}${e.agent ? ' (subagent)' : ''}, ${relativeTime(e.timestamp)} · ${e.prompt ? `“${oneLine(e.prompt.text, 70)}”` : 'prompt not found'}`;
  const end = ed.document.lineAt(line).range.end;
  ed.setDecorations(lineDecoration, [{ range: new vscode.Range(end, end), renderOptions: { after: { contentText: text } } }]);
}

function updateStatus(): void {
  const doc = vscode.window.activeTextEditor?.document;
  const st = doc && stateFor(doc);
  if (!st || !st.stats.total) {
    status.hide();
    return;
  }
  const pct = Math.round((st.stats.ai / st.stats.total) * 100);
  status.text = `$(sparkle) ${pct}% AI`;
  const md = new vscode.MarkdownString(
    `**Prompt Blame**\n\n${st.stats.ai} of ${st.stats.total} non-blank lines are exactly as Claude wrote them, from ${st.stats.sessions.length} session${st.stats.sessions.length === 1 ? '' : 's'}.\n\n` +
      `Click to ${highlightOn ? 'hide' : 'highlight'} AI lines · [File report](command:promptBlame.fileReport)`,
  );
  md.isTrusted = { enabledCommands: ['promptBlame.fileReport'] };
  status.tooltip = md;
  status.show();
}

// ------------------------------------------------------------------ hover

function provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
  if (!cfg().get<boolean>('hover', true)) return undefined;
  const st = stateFor(doc);
  const a = st?.attr[pos.line];
  if (!a) return undefined;
  const e = a.edit;
  const args = encodeURIComponent(JSON.stringify([e.transcript, e.id]));
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: ['promptBlame.openConversation', 'promptBlame.copyPrompt', 'promptBlame.toggleHighlight'] };
  md.supportHtml = false;
  const when = new Date(e.timestamp);
  md.appendMarkdown(`**✦ Written by ${modelName(e.model)}${e.agent ? ' (subagent)' : ''}** · ${relativeTime(e.timestamp)} · ${when.toLocaleString()}`);
  if (e.gitBranch && e.gitBranch !== 'HEAD') md.appendMarkdown(` · \`${e.gitBranch}\``);
  md.appendMarkdown('\n\n---\n\n**Prompt**\n\n');
  md.appendMarkdown(e.prompt ? blockquote(clip(e.prompt.text, 700)) : '_The prompt for this edit was not found in the transcript._');
  if (e.note) {
    md.appendMarkdown('\n\n**Claude**\n\n');
    md.appendMarkdown(blockquote(clip(e.note, 500)));
  }
  if (a.confidence < 0.5) md.appendMarkdown('\n\n_Low confidence: the lines around this one come from other edits or were changed._');
  md.appendMarkdown(
    `\n\n---\n\n[$(comment-discussion) Open conversation](command:promptBlame.openConversation?${args})` +
      `  ·  [$(copy) Copy prompt](command:promptBlame.copyPrompt?${args})` +
      `  ·  [$(eye) ${highlightOn ? 'Hide' : 'Highlight'} AI lines](command:promptBlame.toggleHighlight)`,
  );
  return new vscode.Hover(md, new vscode.Range(pos.line, 0, pos.line, doc.lineAt(pos.line).text.length));
}

const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + '…' : t);

function blockquote(text: string): string {
  // Escape markdown that would break the hover, keep line breaks.
  return text
    .split('\n')
    .map((l) => '> ' + l.replace(/([\\`*_{}[\]<>#|])/g, '\\$1'))
    .join('  \n');
}

// ------------------------------------------------------------------ commands

function editAtCursor(): Edit | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return undefined;
  return stateFor(ed.document)?.attr[ed.selection.active.line]?.edit;
}

function findEdit(transcript?: string, id?: string): Pick<Edit, 'id' | 'transcript' | 'prompt'> | undefined {
  if (!transcript || !id) return editAtCursor();
  const doc = vscode.window.activeTextEditor?.document;
  return (doc && index.editsFor(doc.uri.fsPath).find((e) => e.id === id)) || { id, transcript };
}

async function openConversation(transcript?: string, id?: string): Promise<void> {
  const e = findEdit(transcript, id);
  if (!e) {
    vscode.window.showInformationMessage('Prompt Blame: the line under the cursor was not written by Claude (or was changed since).');
    return;
  }
  const uri = vscode.Uri.from({ scheme: SCHEME, path: `/Claude conversation ${path.basename(e.transcript, '.jsonl').slice(0, 8)}.md`, query: new URLSearchParams({ t: e.transcript, e: e.id }).toString() });
  await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
}

async function copyPrompt(transcript?: string, id?: string): Promise<void> {
  const e = findEdit(transcript, id);
  if (!e?.prompt) {
    vscode.window.showInformationMessage('Prompt Blame: no prompt found for this line.');
    return;
  }
  await vscode.env.clipboard.writeText(e.prompt.text);
  vscode.window.setStatusBarMessage('Prompt copied', 2000);
}

async function fileReport(): Promise<void> {
  const doc = vscode.window.activeTextEditor?.document;
  const st = doc && stateFor(doc);
  if (!doc || !st) {
    vscode.window.showInformationMessage('Prompt Blame: no lines written by Claude in this file.');
    return;
  }
  const uri = vscode.Uri.from({ scheme: SCHEME, path: `/AI report ${path.basename(doc.uri.fsPath)}-report.md`, query: new URLSearchParams({ report: doc.uri.fsPath }).toString() });
  await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
}

function renderReport(file: string): string {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
  const st = doc && stateFor(doc);
  if (!st) return `# ${path.basename(file)}\n\nNo lines written by Claude.\n`;
  const out = [`# Prompt Blame: ${path.basename(file)}`, `**${st.stats.ai} of ${st.stats.total}** non-blank lines (${Math.round((st.stats.ai / st.stats.total) * 100)}%) are exactly as Claude wrote them.`];
  for (const s of st.stats.sessions) {
    const sess = index.session(s.sessionId);
    out.push(`---\n\n## ${sess?.title ? oneLine(sess.title, 90) : 'Session ' + s.sessionId.slice(0, 8)}`);
    out.push(`<sub>${s.lines} lines · session \`${s.sessionId.slice(0, 8)}\`${sess?.firstTimestamp ? ' · ' + new Date(sess.firstTimestamp).toLocaleString() : ''}</sub>`);
    const prompts = new Map<string, { text: string; time: string; lines: number }>();
    for (const e of s.edits) {
      const key = e.prompt?.uuid ?? e.id;
      const n = st.attr.filter((a) => a?.edit === e).length;
      const p = prompts.get(key);
      if (p) p.lines += n;
      else prompts.set(key, { text: e.prompt?.text ?? '(prompt not found)', time: e.timestamp, lines: n });
    }
    for (const p of [...prompts.values()].sort((a, b) => (a.time < b.time ? -1 : 1))) {
      out.push(`- **${p.lines} line${p.lines === 1 ? '' : 's'}** · ${relativeTime(p.time)}\n\n  > ${oneLine(p.text, 400).replace(/([\\`*_{}[\]<>#|])/g, '\\$1')}`);
    }
  }
  return out.join('\n\n') + '\n';
}

class ConversationProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    const q = new URLSearchParams(uri.query);
    const report = q.get('report');
    if (report) return renderReport(report);
    const transcript = q.get('t');
    const id = q.get('e');
    if (!transcript) return '# Not found\n';
    try {
      return renderConversation(transcript, id ?? undefined, cfg().get<number>('conversationContext', 2));
    } catch (err) {
      return `# Could not read the transcript\n\n\`${transcript}\`\n\n${String(err)}\n`;
    }
  }
}
