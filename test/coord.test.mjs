import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-coord-'));
process.env.AH_HOME = path.join(tmp, 'hub');
process.env.AH_CLAUDE_SESSIONS_DIR = path.join(tmp, 'sessions');
process.env.AH_CLAUDE_PROJECTS_DIR = path.join(tmp, 'projects');

const CLI = 'cli-aaaa-1111';
fs.mkdirSync(process.env.AH_CLAUDE_SESSIONS_DIR, { recursive: true });
fs.mkdirSync(path.join(process.env.AH_CLAUDE_PROJECTS_DIR, 'proj'), { recursive: true });
fs.writeFileSync(
  path.join(process.env.AH_CLAUDE_SESSIONS_DIR, 'local_s1.json'),
  JSON.stringify({ sessionId: 'local_s1', cliSessionId: CLI, title: 'Ma session de test', cwd: 'C:\\x', lastActivityAt: Date.now(), completedTurns: 3 }),
);
const transcript = [
  { type: 'user', timestamp: '2026-11-01T10:00:00Z', message: { role: 'user', content: 'fais le truc' } },
  {
    type: 'assistant',
    timestamp: '2026-11-01T10:00:05Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Je commence.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Lance les tests' } }] },
  },
  { type: 'user', timestamp: '2026-11-01T10:00:06Z', message: { role: 'user', content: '<system-reminder>ignoré</system-reminder>' } },
];
fs.writeFileSync(path.join(process.env.AH_CLAUDE_PROJECTS_DIR, 'proj', `${CLI}.jsonl`), transcript.map((x) => JSON.stringify(x)).join('\n') + '\n');

const bus = await import('../lib/bus.mjs');
const sessions = await import('../lib/sessions.mjs');
const coord = await import('../lib/coord.mjs');
const { startServer } = await import('../lib/server.mjs');

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('bus: tâches, dépendances et prise unique', () => {
  const a = bus.addTask({ title: 'A', priority: 2, createdBy: 'user' });
  const b = bus.addTask({ title: 'B', deps: [a.id], createdBy: 'user' });
  assert.equal(a.id, 'T-001');
  assert.deepEqual(bus.readyTasks().map((t) => t.id), [a.id]); // B attend A
  assert.throws(() => bus.claimTask(b.id, 'claude:x'), /dépendances/);
  bus.claimTask(a.id, 'claude:x');
  assert.throws(() => bus.claimTask(a.id, 'claude:y'), /déjà "claimed"/);
  bus.updateTask(a.id, { status: 'done', note: 'fini' }, 'claude:x');
  assert.deepEqual(bus.readyTasks().map((t) => t.id), [b.id]);
  assert.equal(bus.claimTask(null, 'claude:y').id, b.id); // sans id : prochaine prête
  assert.throws(() => bus.updateTask(b.id, { status: 'nimporte' }), /statut invalide/);
});

test('bus: messages, boîte de réception et lecture', () => {
  const m1 = bus.post({ from: 'user', to: 'claude:x', body: 'salut' });
  bus.post({ from: 'claude:y', to: '*', body: 'à tous' });
  bus.post({ from: 'claude:x', to: '*', body: 'mon propre broadcast' });
  assert.equal(bus.unread('claude:x').length, 2); // son propre broadcast exclu
  assert.equal(bus.inbox('claude:x', { peek: true }).length, 2);
  assert.equal(bus.inbox('claude:x').length, 2);
  assert.equal(bus.inbox('claude:x').length, 0);
  assert.ok(m1.id > 0);
});

test('bus: identifiants de tâches uniques', () => {
  const before = bus.listTasks().length;
  for (let i = 0; i < 20; i++) bus.addTask({ title: `c${i}` });
  const ids = bus.listTasks().map((t) => t.id);
  assert.equal(ids.length, before + 20);
  assert.equal(new Set(ids).size, ids.length);
});

test('bus: fin de run -> tâche en revue + message', () => {
  const t = bus.addTask({ title: 'run', createdBy: 'claude:x' });
  bus.onRunFinished({ id: 'r1', taskId: t.id, account: 'a', status: 'completed', tests: { cmd: 'npm test', passed: true }, changes: { files: [1, 2] } });
  assert.equal(bus.getTask(t.id).status, 'review');
  assert.match(bus.inbox('claude:x').at(-1).body, /review/);
  const t2 = bus.addTask({ title: 'run2' });
  bus.onRunFinished({ id: 'r2', taskId: t2.id, account: 'a', status: 'completed', tests: { cmd: 'npm test', passed: false }, changes: { files: [1] } });
  assert.equal(bus.getTask(t2.id).status, 'failed');
});

test('sessions: métadonnées, statut et fin de transcription', () => {
  const s = sessions.findSession('Ma session');
  assert.equal(s.id, `claude:${CLI}`);
  assert.equal(s.status, 'running'); // transcription modifiée à l'instant
  const tail = sessions.sessionTail(s, 10);
  assert.deepEqual(tail.map((e) => e.role), ['user', 'assistant', 'tool']); // rappel système ignoré
  assert.equal(tail[2].text, 'Lance les tests');
  assert.match(sessions.sessionNow(s), /^Bash: Lance les tests/);
  assert.equal(coord.resolveAddress('Ma session'), `claude:${CLI}`);
  assert.throws(() => coord.resolveAddress('inconnu-total'), /destinataire inconnu/);
});

const TOKEN = 't'.repeat(40);
let srv;
before(async () => {
  srv = await startServer({ port: 0, token: TOKEN, pollMs: 100 });
});
after(() => srv.close());

const call = (p, { method = 'GET', body, headers = {} } = {}) =>
  fetch(`http://127.0.0.1:${srv.port}${p}`, {
    method,
    headers: { cookie: `ah=${TOKEN}`, 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

test('serveur: refuse sans jeton, mauvais hôte et mauvaise origine', async () => {
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/api/state`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/api/state`, { headers: { cookie: 'ah=faux' } })).status, 401);
  assert.equal((await call('/api/tasks', { method: 'POST', body: { title: 'x' }, headers: { origin: 'http://evil.example' } })).status, 403);
  const boot = await fetch(`http://127.0.0.1:${srv.port}/?t=${TOKEN}`, { redirect: 'manual' });
  assert.equal(boot.status, 302);
  assert.match(boot.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(`http://127.0.0.1:${srv.port}/?t=mauvais`, { redirect: 'manual' })).status, 403);
});

test('serveur: état, tâches, messages et fil de session', async () => {
  const st = await (await call('/api/state')).json();
  for (const k of ['sessions', 'accounts', 'runs', 'tasks', 'messages']) assert.ok(Array.isArray(st[k]), k);
  const s = st.sessions.find((x) => x.id === `claude:${CLI}`);
  assert.equal(s.title, 'Ma session de test');
  assert.equal(s.transcript, undefined); // chemins de fichiers non exposés
  assert.match(s.now, /Bash/);

  const created = await call('/api/tasks', { method: 'POST', body: { title: 'Depuis le dashboard', brief: 'détail', assignee: 'Ma session' } });
  assert.equal(created.status, 201);
  const t = await created.json();
  assert.equal(t.assignee, `claude:${CLI}`);
  const patched = await (await call(`/api/tasks/${t.id}`, { method: 'PATCH', body: { status: 'blocked', note: 'attend' } })).json();
  assert.equal(patched.status, 'blocked');

  const msg = await call('/api/messages', { method: 'POST', body: { to: 'Ma session', body: 'bonjour', taskId: t.id } });
  assert.equal(msg.status, 201);
  assert.equal(bus.unread(`claude:${CLI}`).at(-1).body, 'bonjour');
  assert.equal((await call('/api/messages', { method: 'POST', body: { to: 'personne', body: 'x' } })).status, 400);

  const tail = await (await call(`/api/sessions/${encodeURIComponent(`claude:${CLI}`)}/tail`)).json();
  assert.equal(tail.entries.length, 3);
});

test('serveur: Codex refusé sans projet, statique servi, traversée de dossiers bloquée', async () => {
  const t = await (await call('/api/tasks', { method: 'POST', body: { title: 'sans projet' } })).json();
  const d = await call(`/api/tasks/${t.id}/dispatch`, { method: 'POST', body: { account: 'a' } });
  assert.equal(d.status, 400);
  assert.match((await d.json()).error, /pas de projet/);
  assert.match((await call('/')).headers.get('content-type'), /text\/html/);
  assert.equal((await call('/..%2f..%2fpackage.json')).status, 404);
});

test('serveur: SSE annonce un changement d’état', async () => {
  const res = await call('/api/events');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  await reader.read(); // message initial
  bus.addTask({ title: 'déclenche le SSE' });
  const got = await Promise.race([reader.read(), new Promise((_, rej) => setTimeout(() => rej(new Error('pas de SSE')), 4000))]);
  assert.match(dec.decode(got.value), /"v":"[0-9a-f]+"/);
  await reader.cancel();
});
