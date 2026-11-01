import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const AH = path.join(here, '..', 'bin', 'ah.mjs');
const FAKE = path.join(here, 'fake-codex.mjs');
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });

/** Hub jetable + dépôt git + faux Codex (aucun quota consommé). */
function setup({ testScript = 'node -e "process.exit(0)"' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-feat-'));
  const hub = path.join(tmp, 'hub');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(hub, { recursive: true });
  for (const n of ['a', 'b']) {
    fs.mkdirSync(path.join(tmp, `home-${n}`), { recursive: true });
    fs.writeFileSync(path.join(tmp, `home-${n}`, 'auth.json'), JSON.stringify({ tokens: { account_id: `acct-${n}` } }));
  }
  fs.writeFileSync(path.join(hub, 'config.json'), JSON.stringify({ accounts: [{ name: 'a', home: path.join(tmp, 'home-a') }, { name: 'b', home: path.join(tmp, 'home-b') }], defaultAccount: 'a' }));
  const g = (...a) => sh('git', a, { cwd: repo });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: testScript } }));
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const brief = path.join(tmp, 'brief.md');
  fs.writeFileSync(brief, '# Tâche de test\n\nCrée agent_out.txt.\n');
  const base = { ...process.env, AH_HOME: hub, AH_CODEX_BIN: FAKE, FAKE_LOG: tmp, AH_AGENT: 'claude:me', AH_CLAUDE_SESSIONS_DIR: path.join(tmp, 'none'), AH_CLAUDE_PROJECTS_DIR: path.join(tmp, 'none') };
  const ah = (args, env = {}) => sh(process.execPath, [AH, ...args], { cwd: repo, env: { ...base, ...env } });
  const json = (args, env) => JSON.parse(ah([...args, '--json'], env).stdout);
  return { tmp, hub, repo, brief, ah, json, g };
}

test('correction automatique : les tests du hub échouent, Codex reçoit le journal et répare', () => {
  const t = setup({ testScript: 'node -e "process.exit(require(\'fs\').existsSync(\'ok.flag\') ? 0 : 1)"' });
  const r = t.ah(['run', t.brief, '--json'], { FAKE_MODE: 'fix' });
  const run = JSON.parse(r.stdout);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(run.status, 'completed');
  assert.equal(run.fixes, 1);
  assert.equal(run.tests.passed, true);
  assert.equal(run.attempts.length, 2);
  assert.equal(run.attempts[1].kind, 'fix');
  assert.match(run.summary, /Correction automatique 1/);
  // le prompt de correction contient le journal d'échec et interdit de toucher aux tests
  const fixPrompt = fs.readFileSync(path.join(run.dir, 'prompt-1.md'), 'utf8');
  assert.match(fixPrompt, /Failing output/);
  assert.match(fixPrompt, /Do NOT modify, delete, skip or weaken tests/);
});

test('correction automatique : plafonnée, puis le run reste en échec (code 10) ; --fix 0 la désactive', () => {
  const t = setup({ testScript: 'node -e "process.exit(1)"' });
  const r = t.ah(['run', t.brief, '--json', '--fix', '2'], { FAKE_MODE: 'neverfix' });
  const run = JSON.parse(r.stdout);
  assert.equal(r.status, 10);
  assert.equal(run.fixes, 2);
  assert.equal(run.attempts.length, 3);
  const t2 = setup({ testScript: 'node -e "process.exit(1)"' });
  const r2 = t2.ah(['run', t2.brief, '--json', '--fix', '0'], { FAKE_MODE: 'neverfix' });
  assert.equal(JSON.parse(r2.stdout).fixes ?? 0, 0);
  assert.equal(r2.status, 10);
});

test('progression en direct : progress.json (commande, fichiers) et état du run', () => {
  const t = setup();
  const run = t.json(['run', t.brief]);
  const progress = JSON.parse(fs.readFileSync(path.join(run.dir, 'progress.json'), 'utf8'));
  assert.equal(progress.phase, 'terminé');
  assert.ok(progress.commands >= 1);
  assert.equal(progress.lastCommand, 'Get-ChildItem -Force'); // enveloppe PowerShell retirée
  assert.ok(progress.files.includes('agent_out.txt')); // chemin relatif au worktree
});

test('question de Codex : run en attente, tâche « waiting », puis reprise avec la réponse', () => {
  const t = setup();
  const task = JSON.parse(t.ah(['task', 'add', 'Tâche avec question', '--brief', t.brief, '--project', t.repo, '--json']).stdout);
  // lancement réel du run lié à la tâche (comme le ferait dispatch), en synchrone pour le test
  const r = t.ah(['run', t.brief, '--task', task.id, '--acct', 'a', '--json'], { FAKE_MODE: 'ask' });
  assert.equal(r.status, 4, r.stderr);
  const run = JSON.parse(r.stdout);
  assert.equal(run.status, 'needs-input');
  assert.equal(run.question, 'Quel format de date faut-il utiliser ?');
  assert.ok(fs.existsSync(run.worktree), 'le worktree est conservé pour la reprise');
  const waiting = JSON.parse(t.ah(['task', 'show', task.id, '--json']).stdout);
  assert.equal(waiting.status, 'waiting');
  assert.match(waiting.result.text, /QUESTION:/);
  assert.match(t.ah(['msg', 'inbox']).stdout, /attend ta réponse/);

  // reprise : le même run repart avec la réponse (worktree et branche réutilisés)
  const r2 = t.ah(['run', '--continue', run.id, '--answer', 'ISO 8601', '--task', task.id, '--json'], { FAKE_MODE: 'ask' });
  assert.equal(r2.status, 0, r2.stderr);
  const run2 = JSON.parse(r2.stdout);
  assert.equal(run2.id, run.id);
  assert.equal(run2.status, 'completed');
  assert.equal(run2.history[0].answer, 'ISO 8601');
  assert.match(fs.readFileSync(path.join(run2.dir, 'prompt-1.md'), 'utf8'), /ISO 8601/);
  assert.equal(JSON.parse(t.ah(['task', 'show', task.id, '--json']).stdout).status, 'review');
  // on ne peut pas reprendre deux fois
  assert.notEqual(t.ah(['run', '--continue', run.id, '--answer', 'x']).status, 0);
});

test('file d’attente : respecte le maximum, alterne les comptes et avance quand une place se libère', async () => {
  const t = setup();
  const calls = [];
  process.env.AH_HOME = t.hub;
  process.env.AH_CLAUDE_SESSIONS_DIR = path.join(t.tmp, 'none');
  const bus = await import(`../lib/bus.mjs?q=${Date.now()}`);
  const coord = await import(`../lib/coord.mjs?q=${Date.now()}`);
  const spawner = (cmd, args) => { calls.push(args); return { once() {}, unref() {} }; };
  const tasks = [];
  for (let i = 0; i < 5; i++) tasks.push(bus.addTask({ title: `file ${i}`, project: t.repo, priority: i === 4 ? 3 : 1 }));
  for (const x of tasks) bus.queueTask(x.id, 'any');
  const started = coord.pumpQueue({ spawner });
  assert.equal(started.length, 3, 'maximum 3 en parallèle');
  assert.equal(started[0].id, tasks[4].id, 'la plus prioritaire part en premier');
  assert.deepEqual([...new Set(started.map((s) => s.acct))].sort(), ['a', 'b']); // les deux comptes servis
  assert.equal(bus.getTask(tasks[3].id).status, 'queued'); // la 4e attend son tour
  assert.equal(coord.pumpQueue({ spawner }).length, 0, 'plus de place');
  bus.updateTask(started[0].id, { status: 'review' }); // une place se libère
  assert.equal(coord.pumpQueue({ spawner }).length, 1);
  assert.equal(bus.listTasks({ status: 'queued' }).length, 1);
  assert.throws(() => bus.queueTask(tasks[4].id), /rien à mettre en file/);
  // un compte au quota est évité
  assert.equal(coord.chooseAccount('any', [{ name: 'a', loggedIn: true, limitedUntil: '2999-01-01' }, { name: 'b', loggedIn: true }], []), 'b');
  assert.equal(coord.chooseAccount('a', [{ name: 'a', loggedIn: true, limitedUntil: '2999-01-01' }], []), null);
});

test('ah wait : attend la fin des tâches, codes de sortie et délai', async () => {
  const t = setup();
  const task = JSON.parse(t.ah(['task', 'add', 'à attendre', '--project', t.repo, '--json']).stdout);
  const waiter = spawnSync.bind(null);
  // la tâche passe en « review » après ~1,5 s : `ah wait` doit se terminer avec 0
  setTimeout(() => t.ah(['task', 'set', task.id, '--status', 'review']), 1500);
  const started = Date.now();
  const r = await new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const p = spawn(process.execPath, [AH, 'wait', task.id, '--timeout', '1'], { cwd: t.repo, env: { ...process.env, AH_HOME: t.hub, AH_AGENT: 'claude:me' }, windowsHide: true });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('close', (code) => resolve({ code, out }));
    });
  });
  assert.equal(r.code, 0);
  assert.match(r.out, new RegExp(`${task.id} → review`));
  assert.ok(Date.now() - started >= 1400, 'a bien attendu');
  void waiter;
  // tâche en échec : sortie 1 ; inexistante : erreur
  t.ah(['task', 'set', task.id, '--status', 'failed']);
  assert.equal(t.ah(['wait', task.id]).status, 1);
  assert.notEqual(t.ah(['wait', 'T-999']).status, 0);
  // délai dépassé : sortie 3 (tâche jamais terminée)
  const slow = JSON.parse(t.ah(['task', 'add', 'jamais finie', '--project', t.repo, '--json']).stdout);
  const to = t.ah(['wait', slow.id, '--timeout', '0.01']);
  assert.equal(to.status, 3);
  assert.match(to.stdout, /délai dépassé/);
});

test('résultats structurés : texte + JSON sur la tâche, extraction du JSON d’un rapport', async () => {
  const t = setup();
  const bus = await import(`../lib/bus.mjs?r=${Date.now()}`);
  assert.deepEqual(bus.extractJson('rapport\n```json\n{"etat":"en cours","priorites":[1,2]}\n```\nfin'), { etat: 'en cours', priorites: [1, 2] });
  assert.deepEqual(bus.extractJson('{"a":1}'), { a: 1 });
  assert.equal(bus.extractJson('pas de json ici'), null);
  assert.equal(bus.extractJson('```json\n{cassé\n```'), null);
  const task = JSON.parse(t.ah(['task', 'add', 'avec résultat', '--json']).stdout);
  const data = path.join(t.tmp, 'data.json');
  fs.writeFileSync(data, JSON.stringify({ verdict: 'continuer' }));
  t.ah(['task', 'result', task.id, '--text', 'Rapport court', '--data', data]);
  const shown = JSON.parse(t.ah(['task', 'result', task.id, '--json']).stdout);
  assert.equal(shown.text, 'Rapport court');
  assert.deepEqual(shown.data, { verdict: 'continuer' });
  const all = JSON.parse(t.ah(['task', 'results', '--json']).stdout);
  assert.equal(all.length, 1);
  assert.equal(all[0].result.data.verdict, 'continuer');
  assert.match(t.ah(['task', 'show', task.id]).stdout, /Rapport court/);
});

test('archivage et suppression de tâches', () => {
  const t = setup();
  const a = JSON.parse(t.ah(['task', 'add', 'A', '--project', t.repo, '--json']).stdout);
  const b = JSON.parse(t.ah(['task', 'add', 'B', '--project', t.repo, '--json']).stdout);
  t.ah(['task', 'set', a.id, '--status', 'done']);
  assert.match(t.ah(['task', 'archive', '--done']).stdout, /1 tâche\(s\) archivée/);
  assert.doesNotMatch(t.ah(['task', 'list', '--all']).stdout, /\bA\b/); // masquée par défaut
  assert.match(t.ah(['task', 'list', '--archived']).stdout, /\bA\b/);
  assert.match(t.ah(['task', 'unarchive', a.id]).stdout, /désarchivée/);
  // suppression : refus sans --yes, refus d'une tâche ouverte, ok pour une tâche terminée
  assert.notEqual(t.ah(['task', 'delete', a.id]).status, 0);
  assert.match(t.ah(['task', 'delete', b.id, '--yes']).stderr, /archive-la ou termine-la/);
  assert.equal(t.ah(['task', 'delete', a.id, '--yes']).status, 0);
  assert.match(t.ah(['task', 'list', '--all']).stdout, /\bB\b/);
  assert.doesNotMatch(t.ah(['task', 'list', '--all', '--archived']).stdout, /\bA\b/);
});

test('réservation de projet : conflit signalé, expiration et libération', () => {
  const t = setup();
  const lock = (agent, ...a) => t.ah(['lock', t.repo, ...a], { AH_AGENT: agent });
  assert.match(lock('claude:one', '--note', 'refonte du moteur').stdout, /réservé pour claude:one/);
  const second = lock('claude:two');
  assert.match(second.stdout, /claude:one avait déjà réservé.*refonte du moteur/);
  assert.match(t.ah(['lock', 'list']).stdout, /claude:two/);
  assert.match(t.ah(['unlock', t.repo], { AH_AGENT: 'claude:one' }).stderr, /réservé par claude:two/);
  assert.match(t.ah(['unlock', t.repo], { AH_AGENT: 'claude:two' }).stdout, /libéré/);
  assert.match(t.ah(['lock', 'list']).stdout, /Aucun projet réservé/);
});

test('résumé de démarrage (ah brief + hook SessionStart)', () => {
  const t = setup();
  assert.match(t.ah(['brief']).stdout, /Rien de particulier/);
  const mine = JSON.parse(t.ah(['task', 'add', 'Ma tâche', '--project', t.repo, '--json']).stdout);
  t.ah(['task', 'claim', mine.id]);
  const waiting = JSON.parse(t.ah(['task', 'add', 'Codex attend', '--project', t.repo, '--json']).stdout);
  t.ah(['task', 'set', waiting.id, '--status', 'waiting']);
  t.ah(['msg', 'send', 'claude:me', 'coucou'], { AH_AGENT: 'user' });
  const text = t.ah(['brief']).stdout;
  assert.match(text, /Codex attend TA réponse/);
  assert.match(text, /Tes tâches en cours/);
  assert.match(text, /1 message non lu/);
  // hook : JSON SessionStart, silencieux sans résumé, jamais d'erreur sur une entrée invalide
  const hook = t.ah(['brief', '--hook'], { AH_AGENT: undefined });
  assert.equal(hook.status, 0);
  const withInput = sh(process.execPath, [AH, 'brief', '--hook'], { cwd: t.repo, env: { ...process.env, AH_HOME: t.hub }, input: JSON.stringify({ session_id: 'me', hook_event_name: 'SessionStart' }) });
  const j = JSON.parse(withInput.stdout);
  assert.equal(j.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(j.hookSpecificOutput.additionalContext, /Ma tâche/);
  const empty = sh(process.execPath, [AH, 'brief', '--hook'], { cwd: t.repo, env: { ...process.env, AH_HOME: t.hub }, input: JSON.stringify({ session_id: 'inconnu' }) });
  assert.equal(empty.stdout.trim(), '');
  assert.equal(sh(process.execPath, [AH, 'brief', '--hook'], { cwd: t.repo, env: { ...process.env, AH_HOME: t.hub }, input: 'pas du json' }).status, 0);
});

test('audit en lecture seule : aucune branche ni worktree laissés, rapport conservé', () => {
  const t = setup();
  const r = t.ah(['run', t.brief, '--sandbox', 'read-only', '--include-dirty', '--json']);
  const run = JSON.parse(r.stdout);
  assert.equal(run.status, 'completed');
  assert.equal(run.readOnly, true);
  assert.equal(run.cleaned, true);
  assert.deepEqual(run.changes.files, []);
  assert.equal(t.g('branch', '--list', 'agent/*').stdout.trim(), ''); // aucune branche agent/* dans le dépôt
  assert.ok(!fs.existsSync(run.worktree));
  assert.match(run.summary, /created agent_out\.txt/); // le rapport reste dans le run
});
