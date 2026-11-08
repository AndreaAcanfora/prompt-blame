import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TranscriptParser, encodeProjectPath, findTranscripts, parseTranscript, promptText } from '../core/transcripts';
import { addedLines, attribute, isTrivial, stats } from '../core/attribution';
import { TranscriptIndex } from '../core/index';
import { modelName, relativeTime, renderConversation } from '../core/render';

// ------------------------------------------------------------------ fixtures

let n = 0;
const uuid = () => `u${++n}`;
const T0 = Date.parse('2026-11-01T10:00:00Z');
const at = (min: number) => new Date(T0 + min * 60000).toISOString();

class Transcript {
  lines: any[] = [];
  last: string | null = null;
  constructor(readonly sessionId: string, readonly cwd: string) {}
  private push(e: any) {
    const u = uuid();
    this.lines.push({ parentUuid: this.last, uuid: u, sessionId: this.sessionId, cwd: this.cwd, gitBranch: 'main', ...e });
    this.last = u;
    return this;
  }
  prompt(text: string, min = 0) {
    return this.push({ type: 'user', timestamp: at(min), message: { role: 'user', content: text } });
  }
  say(text: string, min = 0) {
    return this.push({ type: 'assistant', timestamp: at(min), message: { role: 'assistant', model: 'claude-opus-4-1-20250805', content: [{ type: 'text', text }] } });
  }
  tool(id: string, name: string, input: any, min = 0, error = false) {
    this.push({ type: 'assistant', timestamp: at(min), message: { role: 'assistant', model: 'claude-opus-4-1-20250805', content: [{ type: 'tool_use', id, name, input }] } });
    return this.push({
      type: 'user',
      timestamp: at(min),
      toolUseResult: error ? 'Error: String to replace not found' : { filePath: input.file_path },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: error ? 'Error' : 'ok', is_error: error || undefined }] },
    });
  }
  text() {
    return this.lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  }
}

function tmpProjects(): { base: string; root: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-projects-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-repo-'));
  return { base, root };
}

function write(base: string, cwd: string, name: string, t: Transcript): string {
  const dir = path.join(base, encodeProjectPath(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(f, t.text());
  return f;
}

// ------------------------------------------------------------------ transcripts

test('promptText keeps real prompts and slash commands only', () => {
  assert.equal(promptText({ type: 'user', message: { content: 'fix the bug' } }), 'fix the bug');
  assert.equal(promptText({ type: 'user', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }), 'a\nb');
  assert.equal(promptText({ type: 'user', isMeta: true, message: { content: 'x' } }), null);
  assert.equal(promptText({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } }), null);
  assert.equal(promptText({ type: 'user', message: { content: '<local-command-stdout>ok</local-command-stdout>' } }), null);
  assert.equal(promptText({ type: 'user', message: { content: '<command-name>/review</command-name><command-args>42</command-args>' } }), '/review 42');
  assert.equal(promptText({ type: 'assistant', message: { content: 'x' } }), null);
});

test('parses edits with their prompt and note, and drops failed edits', () => {
  const t = new Transcript('s1', '/repo')
    .prompt('add a retry to fetchUser', 0)
    .say('I will wrap the call in a retry loop.', 1)
    .tool('t1', 'Edit', { file_path: '/repo/src/api.ts', old_string: 'a', new_string: 'b' }, 1)
    .tool('t2', 'Edit', { file_path: 'src/api.ts', old_string: 'x', new_string: 'y' }, 2, true)
    .prompt('now write tests', 3)
    .tool('t3', 'Write', { file_path: '/repo/test/api.test.ts', content: 'test()' }, 4)
    .tool('t4', 'MultiEdit', { file_path: '/repo/src/api.ts', edits: [{ old_string: 'b', new_string: 'c' }, { old_string: 'd', new_string: 'e' }] }, 5);
  const { session, edits } = parseTranscript('/p/s1.jsonl', t.text());
  assert.equal(session.id, 's1');
  assert.equal(session.cwd, '/repo');
  assert.deepEqual(edits.map((e) => e.id), ['t1', 't3', 't4']);
  assert.equal(edits[0].prompt?.text, 'add a retry to fetchUser');
  assert.equal(edits[0].note, 'I will wrap the call in a retry loop.');
  assert.equal(edits[0].file, '/repo/src/api.ts');
  assert.equal(edits[1].prompt?.text, 'now write tests');
  assert.equal(edits[1].note, undefined);
  assert.deepEqual(edits[2].changes, [{ old: 'b', new: 'c' }, { old: 'd', new: 'e' }]);
  assert.equal(edits[0].model, 'claude-opus-4-1-20250805');
});

test('incremental parsing gives the same result as one pass, even split mid-line', () => {
  const t = new Transcript('s2', '/repo').prompt('p1').tool('a', 'Write', { file_path: '/repo/a', content: 'x' }).prompt('p2').tool('b', 'Write', { file_path: '/repo/b', content: 'y' });
  const text = t.text();
  const p = new TranscriptParser('/p/s2.jsonl');
  for (let i = 0; i < text.length; i += 17) p.feed(text.slice(i, i + 17));
  p.flush();
  assert.deepEqual(p.result(), parseTranscript('/p/s2.jsonl', text));
});

test('falls back to file order when the parent chain is broken (compaction)', () => {
  const t = new Transcript('s3', '/repo').prompt('original prompt');
  t.last = 'missing-parent';
  t.tool('a', 'Write', { file_path: '/repo/a', content: 'x' });
  assert.equal(parseTranscript('/p/s3.jsonl', t.text()).edits[0].prompt?.text, 'original prompt');
});

test('subagent edits belong to the parent session', () => {
  const t = new Transcript('parent', '/repo').prompt('task for the agent');
  t.lines.forEach((l) => Object.assign(l, { isSidechain: true, agentId: 'abc' }));
  t.tool('a', 'Write', { file_path: '/repo/a', content: 'x' });
  t.lines.forEach((l) => Object.assign(l, { isSidechain: true, agentId: 'abc' }));
  const { edits } = parseTranscript('/p/parent/subagents/agent-abc.jsonl', t.text());
  assert.equal(edits[0].sessionId, 'parent');
  assert.equal(edits[0].agent, 'abc');
});

test('finds transcripts of the folder, its subfolders and its parents only', () => {
  const { base } = tmpProjects();
  for (const d of ['-home-me-repo', '-home-me', '-home-me-repo-pkg', '-home-me-repository', '-home-other']) {
    fs.mkdirSync(path.join(base, d, 'sess', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(base, d, 's.jsonl'), '');
    fs.writeFileSync(path.join(base, d, 'sess', 'subagents', 'agent-1.jsonl'), '');
  }
  const found = findTranscripts('/home/me/repo', base).map((f) => path.relative(base, f)).sort();
  assert.deepEqual(found, [
    '-home-me-repo-pkg/s.jsonl', '-home-me-repo-pkg/sess/subagents/agent-1.jsonl',
    '-home-me-repo/s.jsonl', '-home-me-repo/sess/subagents/agent-1.jsonl',
    '-home-me/s.jsonl', '-home-me/sess/subagents/agent-1.jsonl',
  ]);
});

// ------------------------------------------------------------------ attribution

const edit = (id: string, min: number, changes: [string, string][], extra: any = {}) =>
  ({ id, sessionId: extra.session ?? 's', transcript: '/t', uuid: id, timestamp: at(min), file: '/f', tool: 'Edit', changes: changes.map(([o, n]) => ({ old: o, new: n })), ...extra }) as any;

test('addedLines is a line diff', () => {
  assert.deepEqual(addedLines('a\nb\nc', 'a\nB\nc\nd'), ['B', 'd']);
  assert.deepEqual(addedLines('', 'x\ny'), ['x', 'y']);
  assert.deepEqual(addedLines('same', 'same'), []);
});

test('isTrivial', () => {
  for (const t of ['', '  ', '}', '});', ']', 'end', '</div>', 'return;', 'else']) assert.ok(isTrivial(t), t);
  for (const t of ['return x;', 'const a = 1;', 'foo()']) assert.ok(!isTrivial(t), t);
});

test('attributes lines added by an edit, not its unchanged context', () => {
  const file = ['function f() {', '  const a = 1;', '  return retry(a);', '}'];
  const e = edit('e1', 0, [['function f() {\n  return a;\n}', 'function f() {\n  const a = 1;\n  return retry(a);\n}']]);
  const attr = attribute(file, [e]);
  assert.equal(attr[0], null, 'context line');
  assert.equal(attr[1]?.edit, e);
  assert.equal(attr[2]?.edit, e);
  assert.equal(attr[3], null, 'unchanged closing brace');
});

test('a line changed by a human after the edit is no longer attributed', () => {
  const e = edit('e1', 0, [['', 'const a = 1;\nconst b = 2;']]);
  const attr = attribute(['const a = 1;', 'const b = 3;'], [e]);
  assert.equal(attr[0]?.edit, e);
  assert.equal(attr[1], null);
});

test('indentation changes do not break attribution', () => {
  const e = edit('e1', 0, [['', 'if (x) {\n  go();\n}']]);
  assert.equal(attribute(['    if (x) {', '        go();', '    }'], [e])[1]?.edit, e);
});

test('the latest edit wins, and neighbours break ties', () => {
  const older = edit('old', 0, [['', 'const a = 1;\nreturn a;']]);
  const newer = edit('new', 5, [['', 'const b = 2;\nreturn a;']]);
  const attr = attribute(['const a = 1;', 'return a;', '', 'const z = 9;'], [older, newer]);
  assert.equal(attr[1]?.edit, older, 'neighbour const a = 1 points to the older edit');
  const attr2 = attribute(['return a;'], [older, newer]);
  assert.equal(attr2[0]?.edit, newer, 'no context: most recent');
});

test('trivial lines inside a block are attributed, outside are not', () => {
  const e = edit('e1', 0, [['', 'function g() {\n  work();\n}']]);
  const attr = attribute(['function g() {', '  work();', '}', '', '}'], [e]);
  assert.equal(attr[2]?.edit, e);
  assert.equal(attr[4], null);
});

test('stats counts non-blank lines per session', () => {
  const a = edit('a', 0, [['', 'one();\ntwo();']], { session: 'A' });
  const b = edit('b', 1, [['', 'three();']], { session: 'B' });
  const lines = ['one();', 'two();', '', 'three();', 'mine();'];
  const st = stats(lines, attribute(lines, [a, b]));
  assert.equal(st.total, 4);
  assert.equal(st.ai, 3);
  assert.deepEqual(st.sessions.map((s) => [s.sessionId, s.lines]), [['A', 2], ['B', 1]]);
});

// ------------------------------------------------------------------ index + render

test('index reads appended entries incrementally and maps edits to files', async () => {
  const { base, root } = tmpProjects();
  const file = path.join(root, 'src', 'a.ts');
  const t = new Transcript('s9', root).prompt('create a.ts').tool('w1', 'Write', { file_path: file, content: 'export const a = 1;\n' });
  const tf = write(base, root, 's9', t);
  const idx = new TranscriptIndex(base);
  assert.equal(await idx.refresh([root]), true);
  assert.equal(idx.editsFor(file).length, 1);
  assert.equal(await idx.refresh([root]), false, 'nothing changed');
  const before = t.lines.length;
  t.prompt('add b').tool('e2', 'Edit', { file_path: file, old_string: 'export const a = 1;', new_string: 'export const a = 1;\nexport const b = 2;' });
  fs.appendFileSync(tf, t.lines.slice(before).map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(await idx.refresh([root]), true);
  assert.deepEqual(idx.editsFor(file).map((e) => e.prompt?.text), ['create a.ts', 'add b']);
  assert.deepEqual(idx.filesUnder(root), [file]);
  assert.equal(idx.session('s9')?.cwd, root);
});

test('renderConversation focuses on the edit and shows its diff', () => {
  const { base, root } = tmpProjects();
  const t = new Transcript('s10', root);
  for (let i = 0; i < 6; i++) t.prompt(`prompt ${i}`).say(`answer ${i}`);
  t.prompt('the important one').say('Doing it').tool('focus', 'Edit', { file_path: `${root}/x.ts`, old_string: 'a()', new_string: 'b()' });
  t.prompt('after');
  const md = renderConversation(write(base, root, 's10', t), 'focus', 1);
  assert.match(md, /the important one/);
  assert.match(md, /This is the edit you asked about/);
  assert.match(md, /- a\(\)\n\+ b\(\)/);
  assert.match(md, /prompt 5/);
  assert.doesNotMatch(md, /prompt 4/);
  assert.match(md, /6 earlier prompts not shown/);
});

test('model names and relative time', () => {
  assert.equal(modelName('claude-opus-4-1-20250805'), 'Opus 4.1');
  assert.equal(modelName('claude-sonnet-4-20250514'), 'Sonnet 4');
  assert.equal(modelName('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
  assert.equal(modelName('claude-fable-5-1'), 'Fable 5.1');
  assert.equal(modelName(undefined), 'Claude');
  assert.equal(relativeTime(at(0), T0 + 3 * 3600_000), '3 hours ago');
  assert.equal(relativeTime(at(0), T0 + 86400_000), '1 day ago');
  assert.equal(relativeTime(at(0), T0 + 10_000), 'just now');
});
