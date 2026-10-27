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
fs.writeFileSync(path.join(cwd, 'agent_out.txt'), 'written by fake codex\n');
const msg = '1) created agent_out.txt 2) nothing to verify 3) nothing uncertain';
if (out) fs.writeFileSync(out, msg);
ev({ type: 'item.completed', item: { type: 'agent_message', text: msg } });
ev({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } });
