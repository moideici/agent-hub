import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ah.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-cli-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const base = {
  ...process.env,
  AH_HOME: path.join(tmp, 'hub'),
  AH_CLAUDE_SESSIONS_DIR: path.join(tmp, 'none'),
  AH_CLAUDE_PROJECTS_DIR: path.join(tmp, 'none'),
};
delete base.CLAUDE_CODE_SESSION_ID;
delete base.AH_AGENT;

function ah(args, { env = {}, input } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...base, ...env }, input, windowsHide: true });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('cli: deux agents se répartissent des tâches et se parlent', () => {
  const planner = { AH_AGENT: 'claude:planner' };
  const worker = { AH_AGENT: 'claude:worker' };

  assert.equal(ah(['task', 'add', 'Écrire le moteur', '--prio', '2', '--assign', 'claude:worker'], { env: planner }).code, 0);
  const second = ah(['task', 'add', 'Écrire les tests', '--dep', 'T-001', '--json'], { env: planner });
  assert.equal(JSON.parse(second.out).deps[0], 'T-001');

  assert.match(ah(['task', 'next'], { env: planner }).out, /Aucune tâche prête/); // T-001 est réservée au worker
  const next = ah(['task', 'next'], { env: worker });
  assert.match(next.out, /T-001/);
  assert.doesNotMatch(next.out, /T-002/); // dépend de T-001

  assert.match(ah(['task', 'claim'], { env: worker }).out, /claude:worker prend T-001/);
  const stolen = ah(['task', 'claim', 'T-001'], { env: planner });
  assert.equal(stolen.code, 1);
  assert.match(stolen.err, /déjà "claimed"/);

  ah(['task', 'set', 'T-001', '--status', 'done', '--note', 'moteur livré'], { env: worker });
  assert.match(ah(['task', 'next'], { env: planner }).out, /T-002/); // débloquée

  ah(['msg', 'send', 'claude:planner', 'moteur fini, tu peux enchaîner', '--task', 'T-001'], { env: worker });
  const box = ah(['msg', 'inbox'], { env: planner });
  assert.match(box.out, /claude:worker → claude:planner \[T-001\]: moteur fini/);
  assert.match(ah(['msg', 'inbox'], { env: planner }).out, /Aucun message/); // lu une fois seulement

  ah(['say', 'je relis le moteur', '--task', 'T-001'], { env: planner });
  const note = JSON.parse(fs.readFileSync(path.join(base.AH_HOME, 'bus', 'agents', 'claude_planner.json'), 'utf8'));
  assert.equal(note.note, 'je relis le moteur');
});

test('cli: destinataire inconnu et lancement sans projet', () => {
  const r = ah(['msg', 'send', 'personne-du-tout', 'salut'], { env: { AH_AGENT: 'user' } });
  assert.equal(r.code, 1);
  assert.match(r.err, /destinataire inconnu/);
  const t = JSON.parse(ah(['task', 'add', 'sans projet', '--json', '--project', path.join(tmp, 'pas-un-depot')], { env: { AH_AGENT: 'user' } }).out);
  const d = ah(['task', 'dispatch', t.id, '--acct', 'a'], { env: { AH_AGENT: 'user' } });
  assert.equal(d.code, 1);
});

test('hook: injecte les messages non lus une seule fois, au bon format', () => {
  ah(['msg', 'send', 'claude:sess-42', 'regarde T-002'], { env: { AH_AGENT: 'user' } });
  const stdin = JSON.stringify({ session_id: 'sess-42', hook_event_name: 'UserPromptSubmit' });
  const r = ah(['inbox', '--hook'], { input: stdin });
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(j.hookSpecificOutput.additionalContext, /regarde T-002/);
  assert.equal(ah(['inbox', '--hook'], { input: stdin }).out.trim(), ''); // déjà lu : silence
  assert.equal(ah(['inbox', '--hook'], { input: 'pas du json' }).code, 0); // jamais d'erreur bloquante
});

test('serveur: hôte inattendu refusé (anti DNS-rebinding)', async () => {
  const { startServer } = await import('../lib/server.mjs');
  process.env.AH_HOME = path.join(tmp, 'hub2');
  const srv = await startServer({ port: 0, token: 'x'.repeat(40) });
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: srv.port, path: '/api/state', headers: { host: 'evil.example', cookie: `ah=${'x'.repeat(40)}` } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  } finally {
    await srv.close();
  }
});
