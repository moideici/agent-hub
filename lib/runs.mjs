import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HUB_DIR, readJson, writeJson, slug, isAlive, fmtDuration, run } from './util.mjs';
import { git, identityArgs, removeWorktree, deleteBranch, diffPatch, mainRoot } from './git.mjs';

export const RUNS_DIR = path.join(HUB_DIR, 'runs');
export const WORKTREES_DIR = path.join(HUB_DIR, 'worktrees');

export function repoKey(root) {
  const h = crypto.createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 6);
  return `${slug(path.basename(root), 30)}-${h}`;
}

export const runDirFor = (root, id) => path.join(RUNS_DIR, repoKey(root), id);
export const worktreeFor = (root, id) => path.join(WORKTREES_DIR, repoKey(root), id);
export const saveRun = (r) => writeJson(path.join(r.dir, 'run.json'), r);

export function listRuns({ root = null } = {}) {
  const out = [];
  if (!fs.existsSync(RUNS_DIR)) return out;
  const keys = root ? [repoKey(root)] : fs.readdirSync(RUNS_DIR);
  for (const k of keys) {
    const kd = path.join(RUNS_DIR, k);
    if (!fs.existsSync(kd)) continue;
    for (const id of fs.readdirSync(kd)) {
      const dir = path.join(kd, id);
      const r = readJson(path.join(dir, 'run.json'));
      if (!r || !r.id) continue;
      r.dir = dir;
      if (r.status === 'running' && !isAlive(r.pid)) r.status = 'stale';
      out.push(r);
    }
  }
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function findRun(idOrPrefix, { root = null } = {}) {
  const all = listRuns({ root });
  const exact = all.filter((r) => r.id === idOrPrefix);
  if (exact.length === 1) return exact[0];
  const pref = all.filter((r) => r.id.startsWith(idOrPrefix) || r.id.includes(idOrPrefix));
  if (pref.length === 1) return pref[0];
  if (pref.length > 1) throw new Error(`"${idOrPrefix}" est ambigu: ${pref.map((r) => r.id).join(', ')}`);
  throw new Error(`run introuvable: ${idOrPrefix}${root ? ' (dans ce dépôt; essaie --all)' : ''}`);
}

export function cmdStatus(opts) {
  const root = opts.all ? null : mainRoot(path.resolve(opts.repo || process.cwd()));
  const runs = listRuns({ root }).slice(0, opts.limit ? +opts.limit : 20);
  if (opts.json) return console.log(JSON.stringify(runs, null, 2));
  if (!runs.length) return console.log('Aucun run.');
  for (const r of runs) {
    const t = r.tests ? (r.tests.passed ? 'tests ✔' : r.tests.cmd ? 'tests ✘' : 'sans tests') : '';
    const ch = r.changes ? `${r.changes.files.length}f +${r.changes.added}/-${r.changes.deleted}` : '';
    console.log(
      `${r.id.padEnd(40)} ${String(r.status).padEnd(10)} acct=${(r.account || '-').padEnd(4)} ${String(
        r.durationSec != null ? fmtDuration(r.durationSec) : '',
      ).padEnd(7)} ${ch.padEnd(14)} ${t}`,
    );
  }
}

export function cmdShow(opts) {
  const root = opts.all ? null : mainRoot(path.resolve(opts.repo || process.cwd()));
  const r = findRun(opts._[0], { root });
  if (opts.patch) {
    const rr = r.repoRoot;
    return console.log(diffPatch(rr, r.base, r.branch));
  }
  if (opts.json) return console.log(JSON.stringify(r, null, 2));
  console.log(`${r.id}  [${r.status}]  compte=${r.account}`);
  console.log(`titre    ${r.title}`);
  console.log(`branche  ${r.branch}  (base ${String(r.base).slice(0, 8)})`);
  console.log(`worktree ${r.worktree}${fs.existsSync(r.worktree || '') ? '' : '  (supprimé)'}`);
  if (r.changes) console.log(`changes  ${r.changes.files.length} fichier(s) +${r.changes.added}/-${r.changes.deleted}`);
  if (r.tests) console.log(`tests    ${r.tests.cmd || '(aucun)'} -> ${r.tests.cmd ? (r.tests.passed ? 'OK' : `ÉCHEC (exit ${r.tests.exit})`) : ''}`);
  if (r.errors?.length) console.log(`erreurs  ${r.errors.join(' | ')}`);
  console.log(`logs     ${r.dir}`);
  if (r.summary) console.log(`\n${r.summary}`);
}

export function cmdMerge(opts) {
  const root = opts.all ? null : mainRoot(path.resolve(opts.repo || process.cwd()));
  const r = findRun(opts._[0], { root });
  if (r.status !== 'completed' && !opts.force) {
    throw new Error(`le run est "${r.status}", pas "completed" (--force pour fusionner quand même)`);
  }
  if (r.tests?.cmd && !r.tests.passed && !opts.force) {
    throw new Error('les tests du run échouent (--force pour fusionner quand même)');
  }
  const rr = r.repoRoot;
  const msg = `Merge ${r.branch}: ${r.title}`;
  const id = identityArgs(rr);
  const res = opts.squash
    ? git(rr, ...id, 'merge', '--squash', r.branch)
    : git(rr, ...id, 'merge', '--no-ff', '-m', msg, r.branch);
  if (res.code !== 0) {
    if (!opts.squash) git(rr, 'merge', '--abort');
    throw new Error(`fusion impossible (${(res.stdout + res.stderr).trim().split('\n').slice(-3).join(' / ')}). Rien n'a été modifié.`);
  }
  if (opts.squash) {
    const c = git(rr, ...id, 'commit', '-m', `${r.title}\n\nagent-hub: ${r.id} (${r.account})`);
    if (c.code !== 0) throw new Error(`commit du squash impossible: ${(c.stdout + c.stderr).trim()}`);
  }
  console.log(`✔ ${r.branch} fusionnée dans ${git(rr, 'rev-parse', '--abbrev-ref', 'HEAD').stdout.trim()}`);
  cleanRun(r, { force: !!opts.squash });
}

export function cleanRun(r, { force = false } = {}) {
  if (r.worktree) removeWorktree(r.repoRoot, r.worktree);
  const d = deleteBranch(r.repoRoot, r.branch, force);
  if (d.code !== 0) console.log(`  (branche ${r.branch} conservée: non fusionnée; --force pour la supprimer)`);
  const meta = readJson(path.join(r.dir, 'run.json'), r);
  meta.cleaned = true;
  writeJson(path.join(r.dir, 'run.json'), meta);
}

export function cmdClean(opts) {
  const root = opts.all ? null : mainRoot(path.resolve(opts.repo || process.cwd()));
  let targets;
  if (opts._[0]) targets = [findRun(opts._[0], { root })];
  else targets = listRuns({ root }).filter((r) => !r.cleaned && ['completed', 'failed', 'limited', 'timeout', 'stale'].includes(r.status));
  if (!targets.length) return console.log('Rien à nettoyer.');
  for (const r of targets) {
    cleanRun(r, { force: !!opts.force });
    console.log(`nettoyé ${r.id}`);
  }
}
