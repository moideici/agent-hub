import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-local-'));
process.env.AH_HOME = path.join(tmp, 'hub');
process.env.AH_CLAUDE_SESSIONS_DIR = path.join(tmp, 'none');
process.env.AH_CLAUDE_PROJECTS_DIR = path.join(tmp, 'none');
fs.mkdirSync(process.env.AH_HOME, { recursive: true });
fs.writeFileSync(
  path.join(process.env.AH_HOME, 'config.json'),
  JSON.stringify({
    accounts: [{ name: 'a', home: path.join(tmp, 'ca') }, { name: 'b', home: path.join(tmp, 'cb') }],
    local: [{ name: '9b', model: 'm9', role: 'coder', vramMiB: 1 }, { name: '27b', model: 'm27', role: 'reviewer', vramMiB: 1 }],
  }),
);
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);

const bus = await import('../lib/bus.mjs');
const coord = await import('../lib/coord.mjs');
const { pickLocal } = await import('../lib/accounts.mjs');
const { loadGlobal } = await import('../lib/config.mjs');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const calls = [];
const spawner = (cmd, args) => {
  calls.push(args);
  return { once() {}, unref() {} };
};
const mk = (title, extra = {}) => bus.addTask({ title, project: repo, brief: 'corrige le bug', ...extra });
const acctOf = (args) => args[args.indexOf('--acct') + 1];

test('config : les modèles locaux sont normalisés (rôle, contexte, identifiant)', () => {
  const g = loadGlobal();
  assert.deepEqual(g.local.map((l) => l.id), ['ollama:9b', 'ollama:27b']);
  assert.equal(g.local[0].ctx, 32768);
  assert.equal(g.local[1].role, 'reviewer');
  assert.equal(g.localMaxParallel, 1);
  assert.equal(pickLocal(g, '9b').name, '9b');
  assert.equal(pickLocal(g, 'ollama:27b').name, '27b');
  assert.equal(pickLocal(g, 'local').name, '9b'); // « local » = premier ouvrier
  assert.equal(pickLocal(g, 'a'), null);
});

test('dispatch local : réserve, lance `ah run --acct 9b`, un seul travail local à la fois', () => {
  const a = mk('local un');
  const r = coord.dispatchTask(a.id, '9b', 'user', { spawner });
  assert.equal(r.status, 'running');
  assert.equal(r.assignee, 'ollama:9b');
  assert.equal(acctOf(calls.at(-1)), '9b');
  const b = mk('local deux');
  assert.throws(() => coord.dispatchTask(b.id, '27b', 'user', { spawner }), /travail local est déjà en cours/);
  assert.equal(bus.getTask(b.id).status, 'todo'); // refusée sans effet de bord
  // ChatGPT, lui, n'est pas bloqué par le local
  const c = mk('chatgpt en parallèle');
  assert.equal(coord.dispatchTask(c.id, 'a', 'user', { spawner }).assignee, 'codex:a');
  for (const t of [a, c]) bus.updateTask(t.id, { status: 'done' });
});

test('chooseLocal : un seul à la fois ; la carte doit avoir assez de place', () => {
  const g = loadGlobal();
  const lm = g.local[0];
  assert.equal(coord.chooseLocal(lm, [], g), lm.name);
  const busy = [{ status: 'running', assignee: 'ollama:27b' }];
  assert.equal(coord.chooseLocal(lm, busy, g), null);
});

test('échec local : escalade PRÉPARÉE (brief + message), jamais lancée toute seule', () => {
  const t = mk('à rater');
  bus.updateTask(t.id, { status: 'running', assignee: 'ollama:9b' });
  const run = {
    id: 'r-local-1', taskId: t.id, backend: 'ollama', account: '9b', status: 'completed', summary: 'Je pense avoir corrigé.',
    tests: { cmd: 'npm test', passed: false, exit: 1, tail: 'AssertionError: attendu 3, reçu 2' }, changes: { files: [{ file: 'a.js' }] }, fixes: 2,
  };
  bus.onRunFinished(run);
  const after1 = bus.getTask(t.id);
  assert.equal(after1.status, 'failed');
  assert.equal(after1.escalation.state, 'proposed');
  assert.ok(fs.existsSync(after1.escalation.briefFile));
  const brief = fs.readFileSync(after1.escalation.briefFile, 'utf8');
  assert.match(brief, /corrige le bug/); // la tâche d'origine
  assert.match(brief, /AssertionError: attendu 3, reçu 2/); // ce que l'essai local a produit
  assert.ok(!calls.some((c) => c.includes(t.id))); // rien n'a été lancé
  assert.ok(bus.listMessages({ limit: 50 }).some((m) => m.taskId === t.id && m.kind === 'ask' && /PRÉPARÉE/.test(m.body)));

  // écarter ne lance rien non plus
  const d = bus.dismissEscalation(t.id, 'user');
  assert.equal(d.escalation.state, 'dismissed');
  assert.throws(() => coord.escalateTask(t.id, 'a', 'user', { spawner }), /pas d'escalade en attente/);
});

test('escalade vérifiée : part sur ChatGPT avec le brief enrichi, jamais vers un modèle local', () => {
  const t = mk('à escalader');
  bus.updateTask(t.id, { status: 'running', assignee: 'ollama:9b' });
  bus.onRunFinished({ id: 'r-local-2', taskId: t.id, backend: 'ollama', account: '9b', status: 'failed', errors: ['boucle détectée'], summary: '' });
  const proposed = bus.getTask(t.id);
  assert.equal(proposed.escalation.state, 'proposed');
  assert.throws(() => coord.escalateTask(t.id, '27b', 'user', { spawner }), /compte ChatGPT/);
  const n = calls.length;
  const r = coord.escalateTask(t.id, 'b', 'user', { spawner });
  assert.equal(r.assignee, 'codex:b');
  assert.equal(calls.length, n + 1);
  assert.equal(acctOf(calls.at(-1)), 'b');
  const sent = bus.getTask(t.id);
  assert.equal(sent.escalation.state, 'sent');
  assert.equal(sent.escalation.to, 'codex:b');
  // le brief envoyé est bien celui de l'escalade
  assert.match(fs.readFileSync(calls.at(-1)[2], 'utf8'), /boucle détectée/); // `ah run <brief> …`
});

test('échec local avec escalate:false, ou échec ChatGPT : pas d’escalade', () => {
  const t = mk('sans escalade', { escalate: false });
  bus.updateTask(t.id, { status: 'running', assignee: 'ollama:9b' });
  bus.onRunFinished({ id: 'r-local-3', taskId: t.id, backend: 'ollama', account: '9b', status: 'failed', errors: ['x'] });
  assert.equal(bus.getTask(t.id).status, 'failed');
  assert.equal(bus.getTask(t.id).escalation, undefined);

  const u = mk('chatgpt échoue');
  bus.updateTask(u.id, { status: 'running', assignee: 'codex:a' });
  bus.onRunFinished({ id: 'r-gpt-1', taskId: u.id, account: 'a', status: 'failed', errors: ['x'] });
  assert.equal(bus.getTask(u.id).escalation, undefined);
});
