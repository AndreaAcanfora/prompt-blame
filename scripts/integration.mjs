// Launch a real VS Code with the extension and run src/test/integration/suite.ts.
//   node scripts/integration.mjs                 CI: synthetic transcript fixture
//   node scripts/integration.mjs --demo <file> <line> <expectedPrompt>
//                                                 uses your real ~/.claude and pauses for screenshots
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
await esbuild.build({ entryPoints: [path.join(root, 'src/test/integration/suite.ts')], outfile: path.join(root, 'out/integration/suite.js'), bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], logLevel: 'warning' });

const demo = process.argv.includes('--demo');
const env = { ...process.env };
let workspace;

if (demo) {
  const [, , , file, line, expect] = process.argv;
  workspace = path.dirname(path.dirname(path.resolve(file)));
  Object.assign(env, { PB_FILE: path.resolve(file), PB_LINE: line, PB_EXPECT_PROMPT: expect, PB_DEMO: '1', PB_DEMO_DIR: process.env.PB_DEMO_DIR ?? '/tmp/pb-demo' });
} else {
  // Synthetic project + transcript.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-it-'));
  workspace = path.join(tmp, 'repo');
  const claude = path.join(tmp, 'claude');
  const file = path.join(workspace, 'src', 'math.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = 'export function clamp(x: number, lo: number, hi: number): number {\n  return Math.min(hi, Math.max(lo, x));\n}\n';
  fs.writeFileSync(file, content + '\nexport const typedByHand = 42;\n');
  const dir = path.join(claude, 'projects', workspace.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const base = { sessionId: 'it-session', cwd: workspace, gitBranch: 'main' };
  const lines = [
    { ...base, type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-11-01T10:00:00Z', message: { role: 'user', content: 'add a clamp helper to src/math.ts' } },
    { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-11-01T10:00:05Z', message: { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'Adding clamp.' }] } },
    { ...base, type: 'assistant', uuid: 'a2', parentUuid: 'a1', timestamp: '2026-11-01T10:00:06Z', message: { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: file, content } }] } },
    { ...base, type: 'user', uuid: 'u2', parentUuid: 'a2', timestamp: '2026-11-01T10:00:07Z', toolUseResult: { type: 'create' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } },
  ];
  fs.writeFileSync(path.join(dir, 'it-session.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  Object.assign(env, { CLAUDE_CONFIG_DIR: claude, PB_FILE: file, PB_LINE: '2', PB_EXPECT_PROMPT: 'add a clamp helper', PB_HUMAN_LINE: '5' });
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-user-'));
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.colorTheme': 'Default Dark Modern',
  'security.workspace.trust.enabled': false,
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
  'chat.commandCenter.enabled': false,
  'chat.disableAIFeatures': true,
  'editor.fontSize': 14,
  'editor.minimap.enabled': false,
  'window.commandCenter': false,
  'git.enabled': false,
  'extensions.ignoreRecommendations': true,
  'workbench.layoutControl.enabled': false,
  'window.newWindowDimensions': 'maximized',
  'window.titleBarStyle': 'custom',
}, null, 2));

const vscodeExecutablePath = await downloadAndUnzipVSCode(process.env.VSCODE_VERSION ?? 'stable');
await runTests({
  vscodeExecutablePath,
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(root, 'out/integration/suite.js'),
  extensionTestsEnv: env,
  // A fresh extensions dir keeps other extensions out without the "extensions disabled" notification.
  launchArgs: [workspace, `--extensions-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'pb-ext-'))}`, '--disable-workspace-trust', `--user-data-dir=${userData}`, '--skip-welcome', '--skip-release-notes'],
});
console.log('integration tests passed');
