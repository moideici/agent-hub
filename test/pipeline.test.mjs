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

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
}

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-test-'));
  const hub = path.join(tmp, 'hub');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  for (const n of ['a', 'b']) {
    fs.mkdirSync(path.join(tmp, 'home-' + n), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'home-' + n, 'auth.json'), '{}');
  }
  fs.mkdirSync(hub, { recursive: true });
  fs.writeFileSync(
    path.join(hub, 'config.json'),
    JSON.stringify({
      accounts: [
        { name: 'a', home: path.join(tmp, 'home-a') },
        { name: 'b', home: path.join(tmp, 'home-b') },
      ],
      defaultAccount: 'a',
      autoRotate: true,
    }),
  );
  const g = (...a) => sh('git', a, { cwd: repo });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }),
  );
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const brief = path.join(tmp, 'brief.md');
  fs.writeFileSync(brief, '# Ajouter agent_out\n\nCrée agent_out.txt.\n');
  const env = { ...process.env, AH_HOME: hub, AH_CODEX_BIN: FAKE, FAKE_LOG: tmp, OPENAI_API_KEY: 'sk-should-be-removed' };
  const ah = (...a) => sh(process.execPath, [AH, ...a], { cwd: repo, env });
  return { tmp, hub, repo, brief, ah, g, env };
}

test('run ok: worktree, commit, tests, merge, clean', () => {
  const t = setup();
  const r = t.ah('run', t.brief, '--json');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const run = JSON.parse(r.stdout);
  assert.equal(run.status, 'completed');
  assert.equal(run.account, 'a');
  assert.equal(run.changes.files.length, 1);
  assert.equal(run.changes.files[0].file, 'agent_out.txt');
  assert.equal(run.tests.cmd, 'npm test');
  assert.equal(run.tests.passed, true);
  // OAuth forcé : clé API retirée, CODEX_HOME du bon compte, prompt sur stdin
  const seen = JSON.parse(fs.readFileSync(path.join(t.tmp, '.fake-args.json'), 'utf8'));
  assert.equal(seen.apiKey, null);
  assert.equal(seen.home, path.join(t.tmp, 'home-a'));
  assert.match(seen.stdin, /Crée agent_out\.txt/);
  assert.ok(seen.args.includes('--ignore-user-config'));
  // le dépôt principal n'est pas touché avant merge
  assert.equal(fs.existsSync(path.join(t.repo, 'agent_out.txt')), false);
  const m = t.ah('merge', run.id);
  assert.equal(m.status, 0, m.stderr + m.stdout);
  assert.equal(fs.existsSync(path.join(t.repo, 'agent_out.txt')), true);
  assert.equal(fs.existsSync(run.worktree), false);
  assert.equal(t.g('branch', '--list', run.branch).stdout.trim(), '');
});

test('quota atteint: statut limited, compte marqué, bascule avec --acct auto', () => {
  const t = setup();
  const env = { ...t.env, FAKE_MODE: 'limit' };
  const r = sh(process.execPath, [AH, 'run', t.brief, '--json'], { cwd: t.repo, env });
  assert.equal(r.status, 2, r.stderr + r.stdout);
  assert.equal(JSON.parse(r.stdout).status, 'limited');
  const r2 = t.ah('run', t.brief);
  assert.equal(r2.status, 2);
  assert.match(r2.stderr, /quota/);
  const r3 = t.ah('run', t.brief, '--acct', 'auto', '--json');
  assert.equal(r3.status, 0, r3.stderr + r3.stdout);
  assert.equal(JSON.parse(r3.stdout).account, 'b');
});

test('échec: statut failed et nettoyage si rien produit', () => {
  const t = setup();
  const env = { ...t.env, FAKE_MODE: 'fail' };
  const r = sh(process.execPath, [AH, 'run', t.brief, '--json'], { cwd: t.repo, env });
  assert.equal(r.status, 1);
  const run = JSON.parse(r.stdout);
  assert.equal(run.status, 'failed');
  assert.equal(run.cleaned, true);
  assert.equal(fs.existsSync(run.worktree), false);
});

test('--acct auto refusé tant que autoRotate est désactivé', () => {
  const t = setup();
  fs.writeFileSync(
    path.join(t.hub, 'config.json'),
    JSON.stringify({
      accounts: [{ name: 'a', home: path.join(t.tmp, 'home-a') }],
      defaultAccount: 'a',
    }),
  );
  const r = t.ah('run', t.brief, '--acct', 'auto');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /désactivée/);
});

test('deux dossiers = même compte ChatGPT: dédoublonnés, --acct explicite refusé', () => {
  const t = setup();
  for (const n of ['a', 'b']) {
    fs.writeFileSync(path.join(t.tmp, 'home-' + n, 'auth.json'), JSON.stringify({ tokens: { account_id: 'same-id' } }));
  }
  const r = t.ah('run', t.brief, '--acct', 'b');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /même compte ChatGPT que "a"/);
  const acc = JSON.parse(t.ah('accounts', '--json').stdout);
  assert.equal(acc.find((x) => x.name === 'b').duplicateOf, 'a');
  // en mode auto, un seul compte reste candidat
  const ok = t.ah('run', t.brief, '--acct', 'auto', '--json');
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.equal(JSON.parse(ok.stdout).attempts.length, 1);
});

test('nettoyage: le node_modules lié n\'est JAMAIS supprimé avec le worktree (régression du 27/10/2026)', () => {
  const t = setup();
  // un vrai node_modules dans le dépôt principal (détecté et lié dans le worktree)
  const nm = path.join(t.repo, 'node_modules', 'pkg');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, 'index.js'), 'module.exports = 1;\n');
  const r = t.ah('run', t.brief, '--json');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const run = JSON.parse(r.stdout);
  assert.deepEqual(run.linked, ['node_modules']);
  assert.equal(fs.lstatSync(path.join(run.worktree, 'node_modules')).isSymbolicLink(), true);
  const m = t.ah('merge', run.id);
  assert.equal(m.status, 0, m.stderr + m.stdout);
  assert.equal(fs.existsSync(run.worktree), false, 'worktree supprimé');
  assert.equal(fs.existsSync(path.join(nm, 'index.js')), true, 'node_modules du dépôt principal intact après merge');
  // même garantie via `ah clean` d'un run non fusionné
  const r2 = t.ah('run', t.brief, '--json');
  const run2 = JSON.parse(r2.stdout);
  const c = t.ah('clean', run2.id, '--force');
  assert.equal(c.status, 0, c.stderr + c.stdout);
  assert.equal(fs.existsSync(run2.worktree), false);
  assert.equal(fs.existsSync(path.join(nm, 'index.js')), true, 'node_modules du dépôt principal intact après clean');
});

test('dépôt non git: message clair', () => {
  const t = setup();
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-plain-'));
  const r = sh(process.execPath, [AH, 'run', t.brief], { cwd: plain, env: t.env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pas un dépôt git/);
});

test('review: sortie JSON structurée, sandbox read-only', () => {
  const t = setup();
  fs.writeFileSync(path.join(t.repo, 'a.txt'), 'changed\n');
  const r = t.ah('review', '--json');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, 'changes_requested');
  assert.equal(out.findings.length, 1);
  const seen = JSON.parse(fs.readFileSync(path.join(t.tmp, '.fake-args.json'), 'utf8'));
  assert.ok(seen.args.includes('read-only'));
  assert.match(seen.stdin, /changed/);
});

test('include-dirty recopie les modifications locales', () => {
  const t = setup();
  fs.writeFileSync(path.join(t.repo, 'a.txt'), 'dirty change\n');
  const r = t.ah('run', t.brief, '--include-dirty', '--json');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const run = JSON.parse(r.stdout);
  assert.equal(fs.readFileSync(path.join(run.worktree, 'a.txt'), 'utf8').trim(), 'dirty change');
});
