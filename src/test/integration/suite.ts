// Runs inside VS Code (see scripts/integration.mjs).
// PB_FILE: file to open. PB_DEMO=1: pause at each step so a screenshot can be taken.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vscode from 'vscode';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, fn: () => Promise<T | undefined> | T | undefined, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function pause(step: string): Promise<void> {
  if (!process.env.PB_DEMO) return;
  const marker = `${process.env.PB_DEMO_DIR}/${step}.ready`;
  fs.writeFileSync(marker, '');
  await waitFor(`screenshot ${step}`, () => !fs.existsSync(marker), 60000);
}

export async function run(): Promise<void> {
  const file = process.env.PB_FILE!;
  const line = Number(process.env.PB_LINE ?? 1) - 1;
  const ext = vscode.extensions.getExtension('AndreaAcanfora.prompt-blame');
  assert.ok(ext, 'extension is installed');
  await ext.activate();

  const cmds = await vscode.commands.getCommands(true);
  for (const c of ['promptBlame.openConversation', 'promptBlame.toggleHighlight', 'promptBlame.copyPrompt', 'promptBlame.fileReport', 'promptBlame.refresh']) {
    assert.ok(cmds.includes(c), `command ${c}`);
  }

  const doc = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand('promptBlame.refresh');

  // Hover on a line Claude wrote shows its prompt.
  const hover = await waitFor('hover', async () => {
    const hs = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(line, 2));
    const text = hs.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : ''))).join('\n');
    return text.includes('Prompt') ? text : undefined;
  });
  assert.match(hover, /Written by/);
  assert.match(hover, new RegExp(process.env.PB_EXPECT_PROMPT ?? 'Prompt'));
  assert.match(hover, /Open conversation/);

  // Copy prompt puts the prompt on the clipboard.
  editor.selection = new vscode.Selection(line, 0, line, 0);
  await vscode.commands.executeCommand('promptBlame.copyPrompt');
  assert.match(await vscode.env.clipboard.readText(), new RegExp(process.env.PB_EXPECT_PROMPT ?? '.'));

  // A line typed by a human has no hover from us.
  if (process.env.PB_HUMAN_LINE) {
    const hs = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, new vscode.Position(Number(process.env.PB_HUMAN_LINE) - 1, 2));
    const text = hs.flatMap((h) => h.contents.map((c) => (typeof c === 'string' ? c : 'value' in c ? c.value : ''))).join('\n');
    assert.doesNotMatch(text, /Written by/);
  }

  await vscode.commands.executeCommand('promptBlame.toggleHighlight');
  editor.selection = new vscode.Selection(line, 0, line, 0);
  editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
  await sleep(800);
  await pause('1-highlight');

  await vscode.commands.executeCommand('promptBlame.openConversation');
  const conv = await waitFor('conversation document', () => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'prompt-blame'));
  assert.match(conv.getText(), /This is the edit you asked about/);
  await sleep(2500);
  await pause('2-conversation');

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.window.showTextDocument(doc, { selection: new vscode.Selection(line, 0, line, 0) });
  await sleep(500);
  await vscode.commands.executeCommand('editor.action.showHover');
  await sleep(1500);
  await pause('3-hover');

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand('promptBlame.fileReport');
  const report = await waitFor('report document', () => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'prompt-blame' && d.uri.path.startsWith('/AI report')));
  assert.match(report.getText(), /exactly as Claude wrote them/);
}
