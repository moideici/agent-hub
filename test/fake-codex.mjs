// Faux `codex` pour tester le pipeline sans consommer de quota.
// FAKE_MODE: ok (défaut) | limit | fail
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const val = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const cwd = val('-C') || process.cwd();
const out = val('-o');

if (args[0] === 'login') {
  console.log('Logged in using ChatGPT');
  process.exit(0);
}
if (args.includes('--version')) {
  console.log('codex-cli fake');
  process.exit(0);
}

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) stdin += c;

const ev = (o) => console.log(JSON.stringify(o));
const mode = process.env.FAKE_MODE || 'ok';
fs.writeFileSync(
  path.join(process.env.FAKE_LOG || cwd, '.fake-args.json'),
  JSON.stringify({ args, home: process.env.CODEX_HOME, apiKey: process.env.OPENAI_API_KEY ?? null, stdin }),
);
ev({ type: 'thread.started', thread_id: 'fake-thread' });
ev({ type: 'turn.started' });

if (mode === 'limit') {
  const m =
    'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 7:58 PM.';
  ev({ type: 'error', message: m });
  ev({ type: 'turn.failed', error: { message: m } });
  process.exit(1);
}
if (mode === 'fail') {
  ev({ type: 'error', message: 'boom' });
  ev({ type: 'turn.failed', error: { message: 'boom' } });
  process.exit(1);
}
if (args.includes('--output-schema')) {
  const msg = JSON.stringify({
    verdict: 'changes_requested',
    summary: 'fake review',
    findings: [{ severity: 'low', file: 'a.txt', line: 1, title: 'nit', detail: 'fake' }],
  });
  if (out) fs.writeFileSync(out, msg);
  ev({ type: 'item.completed', item: { type: 'agent_message', text: msg } });
  ev({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
}
// Événements d'activité (commande + fichier modifié) pour tester la progression en direct
ev({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "Get-ChildItem -Force"' } });
ev({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', status: 'completed' } });
if (mode === 'ask' && !stdin.includes('Previous exchange')) {
  const q = "J'ai besoin d'une précision.\nQUESTION: Quel format de date faut-il utiliser ?";
  if (out) fs.writeFileSync(out, q);
  ev({ type: 'item.completed', item: { type: 'agent_message', text: q } });
  ev({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
}
if (mode === 'fix') {
  // 1er passage : le code est cassé (pas de ok.flag) ; passage de correction (journal d'échec dans le prompt) : réparé
  if (stdin.includes('Failing output')) fs.writeFileSync(path.join(cwd, 'ok.flag'), 'fixed\n');
  else if (stdin.includes('automatic correction attempt')) throw new Error('inattendu');
}
if (mode === 'neverfix') {
  /* ne répare jamais : les tests continuent d'échouer */
}
fs.writeFileSync(path.join(cwd, 'agent_out.txt'), stdin.includes('Previous exchange') ? 'resumed with the answer\n' : 'written by fake codex\n');
ev({ type: 'item.started', item: { id: 'i2', type: 'file_change', changes: [{ path: path.join(cwd, 'agent_out.txt'), kind: 'add' }], status: 'in_progress' } });
const msg = stdin.includes('Failing output') ? 'fixed the failing test' : stdin.includes('Previous exchange') ? 'continued after the answer' : '1) created agent_out.txt 2) nothing to verify 3) nothing uncertain';
if (out) fs.writeFileSync(out, msg);
ev({ type: 'item.completed', item: { type: 'agent_message', text: msg } });
ev({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
