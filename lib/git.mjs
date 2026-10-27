import fs from 'node:fs';
import path from 'node:path';
import { run, ensureDir } from './util.mjs';

export const git = (cwd, ...args) => run('git', args, { cwd });

export function gitOk(cwd, ...args) {
  const r = git(cwd, ...args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} a échoué: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

/** Racine du dépôt *principal* (même si on est dans un worktree). */
/** Arguments `-c user.*` de repli si aucune identité git n'est configurée (machine neuve). */
export function identityArgs(root) {
  const email = git(root, 'config', 'user.email').stdout.trim();
  const name = git(root, 'config', 'user.name').stdout.trim();
  const args = [];
  if (!name) args.push('-c', 'user.name=agent-hub');
  if (!email) args.push('-c', 'user.email=agent-hub@localhost');
  return args;
}

export function mainRoot(cwd) {
  const top = git(cwd, 'rev-parse', '--show-toplevel');
  if (top.code !== 0) return null;
  const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (common.code === 0) {
    const dir = path.resolve(common.stdout.trim());
    if (path.basename(dir) === '.git') return path.dirname(dir);
  }
  return path.resolve(top.stdout.trim());
}

export function hasCommit(root) {
  return git(root, 'rev-parse', '--verify', '-q', 'HEAD').code === 0;
}

export function headSha(root, ref = 'HEAD') {
  return gitOk(root, 'rev-parse', ref);
}

export function currentBranch(root) {
  const r = git(root, 'symbolic-ref', '--short', '-q', 'HEAD');
  return r.code === 0 ? r.stdout.trim() : null;
}

export function addWorktree(root, wtPath, branch, baseSha) {
  ensureDir(path.dirname(wtPath));
  gitOk(root, 'worktree', 'add', '-q', '-b', branch, wtPath, baseSha);
}

/**
 * Supprime les liens (junctions/symlinks) d'un worktree SANS toucher à leur cible.
 * À faire avant toute suppression récursive : sous Windows, supprimer un dossier qui contient
 * une junction peut effacer le contenu réel de la cible (ex. le node_modules du dépôt principal).
 */
export function unlinkLinks(wtPath, names = []) {
  if (!fs.existsSync(wtPath)) return [];
  const candidates = new Set(names.map((n) => path.join(wtPath, n)));
  for (const e of fs.readdirSync(wtPath, { withFileTypes: true })) {
    if (e.name !== '.git') candidates.add(path.join(wtPath, e.name));
  }
  const removed = [];
  for (const p of candidates) {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isSymbolicLink()) continue;
    try {
      fs.unlinkSync(p);
      removed.push(p);
    } catch (e) {
      throw new Error(`impossible de supprimer le lien ${p} (${e.message}); worktree conservé pour ne pas toucher à sa cible`);
    }
  }
  return removed;
}

export function removeWorktree(root, wtPath, links = []) {
  unlinkLinks(wtPath, links); // toujours en premier : voir unlinkLinks
  git(root, 'worktree', 'remove', '--force', wtPath);
  if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true });
  git(root, 'worktree', 'prune');
}

export function deleteBranch(root, branch, force = false) {
  return git(root, 'branch', force ? '-D' : '-d', branch);
}

/** Ajoute un motif à .git/info/exclude (local, jamais commité). */
export function excludeLocal(root, pattern) {
  const p = gitOk(root, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude');
  ensureDir(path.dirname(p));
  const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  if (!cur.split(/\r?\n/).includes(pattern)) {
    fs.appendFileSync(p, (cur && !cur.endsWith('\n') ? '\n' : '') + pattern + '\n');
  }
}

export function commitAll(wt, message) {
  gitOk(wt, 'add', '-A');
  const quiet = git(wt, 'diff', '--cached', '--quiet');
  if (quiet.code === 0) return null; // rien à committer
  gitOk(
    wt,
    '-c', 'user.name=agent-hub',
    '-c', 'user.email=agent-hub@localhost',
    'commit', '-q', '--no-verify', '-m', message,
  );
  return headSha(wt);
}

export function diffNumstat(root, base, branch) {
  const out = gitOk(root, 'diff', '--numstat', `${base}..${branch}`);
  const files = out
    ? out.split('\n').map((l) => {
        const [a, d, ...f] = l.split('\t');
        return { file: f.join('\t'), added: a === '-' ? 0 : +a, deleted: d === '-' ? 0 : +d };
      })
    : [];
  return {
    files,
    added: files.reduce((s, f) => s + f.added, 0),
    deleted: files.reduce((s, f) => s + f.deleted, 0),
  };
}

export function diffPatch(root, base, branch) {
  return gitOk(root, 'diff', '--binary', `${base}..${branch}`);
}

/** Recopie dans le worktree les modifications non commitées (suivies + non suivies) du dépôt. */
export function copyDirty(root, wt) {
  const notes = [];
  const patch = git(root, 'diff', 'HEAD', '--binary');
  if (patch.code === 0 && patch.stdout.trim()) {
    const r = run('git', ['apply', '--binary', '-'], { cwd: wt, input: patch.stdout });
    if (r.code !== 0) notes.push(`patch des fichiers suivis non appliqué: ${r.stderr.trim()}`);
    else notes.push('modifications suivies recopiées');
  }
  const untracked = git(root, 'ls-files', '--others', '--exclude-standard', '-z').stdout.split('\0').filter(Boolean);
  let copied = 0;
  for (const rel of untracked) {
    const src = path.join(root, rel);
    try {
      if (fs.statSync(src).size > 5 * 1024 * 1024) continue;
      const dst = path.join(wt, rel);
      ensureDir(path.dirname(dst));
      fs.copyFileSync(src, dst);
      copied++;
    } catch {
      /* ignoré */
    }
  }
  if (copied) notes.push(`${copied} fichier(s) non suivi(s) recopié(s)`);
  return notes;
}

export function dirtySummary(root) {
  const r = git(root, 'status', '--porcelain');
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
}
