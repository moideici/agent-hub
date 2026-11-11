// Valide les tâches du benchmark local (bench/ollama/tasks/*) : chacune doit ÉCHOUER au départ (pour une bonne raison)
// et RÉUSSIR une fois la solution de référence appliquée. Sans ça, un score de benchmark ne veut rien dire.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TASKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bench', 'ollama', 'tasks');
const dirs = fs.existsSync(TASKS) ? fs.readdirSync(TASKS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

const runTests = (cwd) => {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
};

test('bench: le jeu de tâches existe et couvre tous les niveaux', { skip: dirs.length === 0 ? 'aucune tâche pour le moment' : false }, () => {
  const levels = new Map();
  for (const d of dirs) {
    const meta = JSON.parse(fs.readFileSync(path.join(TASKS, d, 'task.json'), 'utf8'));
    levels.set(meta.level, (levels.get(meta.level) || 0) + 1);
  }
  const have = [...levels.keys()].sort((a, b) => a - b);
  // une fois le jeu complet : niveaux 0 à 6 tous présents
  if (dirs.length >= 20) assert.deepEqual(have, [0, 1, 2, 3, 4, 5, 6], `niveaux présents : ${have.join(',')}`);
});

for (const d of dirs) {
  test(`bench ${d}: échoue au départ, réussit avec la solution`, () => {
    const root = path.join(TASKS, d);
    const meta = JSON.parse(fs.readFileSync(path.join(root, 'task.json'), 'utf8'));
    assert.equal(meta.id, d, 'task.json.id doit être le nom du dossier');
    assert.ok(Number.isInteger(meta.level) && meta.level >= 0 && meta.level <= 6, 'level entier de 0 à 6');
    assert.ok(typeof meta.title === 'string' && meta.title.length > 3, 'title requis');
    for (const f of ['brief.md', 'repo/package.json']) assert.ok(fs.existsSync(path.join(root, f)), `${f} manquant`);
    assert.ok(fs.existsSync(path.join(root, 'solution')), 'dossier solution/ manquant');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'repo', 'package.json'), 'utf8'));
    assert.equal(pkg.scripts?.test, 'node --test', 'scripts.test doit valoir "node --test"');
    assert.ok(fs.readFileSync(path.join(root, 'brief.md'), 'utf8').trim().length > 40, 'brief trop court');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-bench-'));
    try {
      copyTree(path.join(root, 'repo'), tmp);
      const before = runTests(tmp);
      assert.notEqual(before.code, 0, 'les tests doivent échouer AVANT la solution');
      assert.match(before.out, /not ok/, 'au moins un test doit échouer (pas seulement une erreur de chargement)');
      assert.doesNotMatch(before.out, /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/, "l'échec initial ne doit pas venir d'un fichier manquant ou d'une erreur de syntaxe");

      copyTree(path.join(root, 'solution'), tmp);
      const after = runTests(tmp);
      assert.equal(after.code, 0, `les tests doivent réussir APRÈS la solution :\n${after.out.slice(-1500)}`);
      assert.match(after.out, /# fail 0/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
}
