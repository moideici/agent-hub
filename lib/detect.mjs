import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './util.mjs';

const has = (root, ...p) => fs.existsSync(path.join(root, ...p));

/**
 * Devine la commande de test et les dossiers à lier dans les worktrees.
 * Volontairement prudent : mieux vaut aucune commande qu'une mauvaise.
 */
export function detectProject(root) {
  const kinds = [];
  let test = null;
  const link = [];

  if (has(root, 'package.json')) {
    kinds.push('node');
    const pkg = readJson(path.join(root, 'package.json'), {}) || {};
    const script = pkg.scripts?.test;
    if (script && !/no test specified/i.test(script)) {
      const pm = has(root, 'pnpm-lock.yaml') ? 'pnpm' : has(root, 'yarn.lock') ? 'yarn' : 'npm';
      test = `${pm} test`;
    }
    if (has(root, 'node_modules')) link.push('node_modules');
  }
  if (has(root, 'pyproject.toml') || has(root, 'pytest.ini') || has(root, 'setup.cfg') || has(root, 'requirements.txt')) {
    kinds.push('python');
    if (!test && (has(root, 'tests') || has(root, 'test') || has(root, 'pytest.ini'))) test = 'python -m pytest -q';
  }
  if (has(root, 'Cargo.toml')) {
    kinds.push('rust');
    if (!test) test = 'cargo test';
  }
  if (has(root, 'go.mod')) {
    kinds.push('go');
    if (!test) test = 'go test ./...';
  }
  if (has(root, 'gradlew.bat') || has(root, 'gradlew')) {
    kinds.push('gradle');
    if (!test) test = process.platform === 'win32' ? 'gradlew.bat test' : './gradlew test';
  }
  try {
    const entries = fs.readdirSync(root);
    if (entries.some((f) => /\.(sln|csproj)$/i.test(f))) {
      kinds.push('dotnet');
      if (!test) test = 'dotnet test';
    }
  } catch {
    /* ignoré */
  }
  if (!test && has(root, 'Makefile')) {
    try {
      if (/^test:/m.test(fs.readFileSync(path.join(root, 'Makefile'), 'utf8'))) test = 'make test';
    } catch {
      /* ignoré */
    }
  }
  return { kinds, test, link };
}
