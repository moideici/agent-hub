import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-dispatch-'));
process.env.AH_HOME = path.join(tmp, 'hub');
process.env.AH_CLAUDE_SESSIONS_DIR = path.join(tmp, 'none');
process.env.AH_CLAUDE_PROJECTS_DIR = path.join(tmp, 'none');
fs.mkdirSync(process.env.AH_HOME, { recursive: true });
fs.writeFileSync(
  path.join(process.env.AH_HOME, 'config.json'),
  JSON.stringify({ accounts: [{ name: 'a', home: path.join(tmp, 'ca') }, { name: 'b', home: path.join(tmp, 'cb') }] }),
);
const repo = path.join(tmp, 'repo');
fs.mkdirSync(repo);
assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);

const bus = await import('../lib/bus.mjs');
const { dispatchTask } = await import('../lib/coord.mjs');
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ah.mjs');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const calls = [];
const spawner = (cmd, args) => {
  calls.push(args);
  return { once() {}, unref() {} };
};
const mk = (title, extra = {}) => bus.addTask({ title, project: repo, brief: 'x', ...extra });

test('dispatch: réserve la tâche, lance une seule fois, écrit brief et journal', () => {
  const t = mk('première');
  const r = dispatchTask(t.id, 'a', 'user', { spawner });
  assert.equal(r.status, 'running');
  assert.equal(r.assignee, 'codex:a');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('--task') && calls[0].includes(t.id));
  assert.ok(fs.existsSync(path.join(bus.BRIEFS, `${t.id}.md`)));
  assert.throws(() => dispatchTask(t.id, 'a', 'user', { spawner }), /"running" : rien à lancer/); // pas de double lancement
  assert.equal(calls.length, 1);
});

test('dispatch: refuse tant que les dépendances ne sont pas terminées', () => {
  const a = mk('amont');
  const b = mk('aval', { deps: [a.id] });
  const n = calls.length;
  assert.throws(() => dispatchTask(b.id, 'a', 'user', { spawner }), /attend ses dépendances/);
  assert.equal(bus.getTask(b.id).status, 'todo');
  assert.equal(calls.length, n);
  bus.updateTask(a.id, { status: 'done' });
  assert.equal(dispatchTask(b.id, 'b', 'user', { spawner }).assignee, 'codex:b');
});

test('dispatch: le maximum de runs en vol compte les tâches déjà réservées', () => {
  const inFlight = bus.listTasks().filter((t) => t.status === 'running').length; // 2 déjà réservées
  const extra = [];
  for (let i = inFlight; i < 3; i++) extra.push(dispatchTask(mk(`plein ${i}`).id, 'a', 'user', { spawner }));
  const last = mk('de trop');
  assert.throws(() => dispatchTask(last.id, 'a', 'user', { spawner }), /maximum 3/);
  assert.equal(bus.getTask(last.id).status, 'todo'); // la tâche refusée reste intacte
});

test('dispatch: projet absent ou hors dépôt git, compte inconnu', () => {
  const noRepo = bus.addTask({ title: 'hors dépôt', project: path.join(tmp, 'pas-un-depot') });
  assert.throws(() => dispatchTask(noRepo.id, 'a', 'user', { spawner }), /pas un dépôt git/);
  assert.throws(() => dispatchTask(mk('compte').id, 'z', 'user', { spawner }), /compte inconnu/);
  assert.equal(bus.getTask(noRepo.id).status, 'todo');
});

test('dispatch: échec du lancement => tâche "failed", relançable', () => {
  for (const t of bus.listTasks().filter((x) => x.status === 'running')) bus.updateTask(t.id, { status: 'done' }); // libère les places
  const t = mk('lancement cassé');
  assert.throws(() => dispatchTask(t.id, 'a', 'user', { spawner: () => { throw new Error('spawn EPERM'); } }), /spawn EPERM/);
  const after = bus.getTask(t.id);
  assert.equal(after.status, 'failed');
  assert.match(after.notes.at(-1).text, /Lancement impossible: spawn EPERM/);
  assert.equal(dispatchTask(t.id, 'a', 'user', { spawner }).status, 'running'); // on peut relancer
});

test('run lié à une tâche qui échoue avant de démarrer => tâche "failed" (pas "running" à vie)', () => {
  const t = mk('mort au démarrage');
  bus.updateTask(t.id, { status: 'running' });
  const brief = path.join(tmp, 'brief.md');
  fs.writeFileSync(brief, '# x');
  const r = spawnSync(process.execPath, [BIN, 'run', brief, '--repo', path.join(tmp, 'pas-un-depot'), '--task', t.id], {
    encoding: 'utf8', env: { ...process.env, AH_HOME: process.env.AH_HOME }, windowsHide: true,
  });
  assert.equal(r.status, 1);
  assert.equal(bus.getTask(t.id).status, 'failed');
  assert.match(bus.getTask(t.id).notes.at(-1).text, /avant de démarrer/);
  // un run déjà démarré (runId posé) n'est pas écrasé
  const t2 = mk('démarré');
  bus.updateTask(t2.id, { status: 'running', runId: 'r-1' });
  assert.equal(bus.failTaskIfNotStarted(t2.id, 'x'), null);
  assert.equal(bus.getTask(t2.id).status, 'running');
});

test('inbox: un message non lu survit à plus de 500 messages entre autres agents', () => {
  bus.post({ from: 'user', to: 'claude:lent', body: 'ne me perds pas' });
  for (let i = 0; i < 600; i++) bus.post({ from: 'claude:x', to: 'claude:y', body: `bruit ${i}` });
  const got = bus.inbox('claude:lent');
  assert.equal(got.length, 1);
  assert.equal(got[0].body, 'ne me perds pas');
});
