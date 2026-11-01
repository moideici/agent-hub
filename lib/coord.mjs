import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listTasks, listMessages, listAgentNotes, getTask, reserveForDispatch, failTaskIfNotStarted, unread, BRIEFS } from './bus.mjs';
import { mainRoot } from './git.mjs';
import { listSessions, findSession, sessionNow } from './sessions.mjs';
import { listRuns } from './runs.mjs';
import { loadGlobal } from './config.mjs';
import { limitedUntil, isLoggedIn } from './accounts.mjs';
import { ensureDir } from './util.mjs';

const AH_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ah.mjs');
export const MAX_PARALLEL_CODEX = 3;

/** Qui suis-je ? Une session Claude se reconnaît via CLAUDE_CODE_SESSION_ID ; sinon c'est l'utilisateur. */
export function me(env = process.env) {
  if (env.AH_AGENT) return env.AH_AGENT;
  if (env.CLAUDE_CODE_SESSION_ID) return `claude:${env.CLAUDE_CODE_SESSION_ID}`;
  return 'user';
}

/** Adresse lisible -> identifiant d'agent (user, *, codex:a, claude:<id>, ou titre/identifiant de session). */
export function resolveAddress(token) {
  const t = String(token || '').trim();
  if (!t) throw new Error('destinataire vide');
  if (t === 'user' || t === '*') return t;
  if (/^(codex|claude):/.test(t)) return t;
  const s = findSession(t);
  if (s) return s.id;
  throw new Error(`destinataire inconnu: "${t}" (utilise user, *, codex:a, codex:b, ou le titre/id d'une session)`);
}

const projectCache = new Map();

/**
 * Projet auquel appartient un dossier : racine git si elle existe, sinon regroupements connus
 * (espaces temporaires de Claude, cours), sinon le dossier lui-même.
 */
export function projectOf(p) {
  if (!p) return { key: '', name: 'Sans projet', path: null };
  const norm = path.resolve(String(p));
  const hit = projectCache.get(norm);
  if (hit && Date.now() - hit.t < 300_000) return hit.v;
  const low = norm.replaceAll('\\', '/').toLowerCase();
  let v;
  if (low.includes('/scratch-workspaces/')) v = { key: 'scratch', name: 'Espaces temporaires', path: null };
  else if (/\/onedrive\/cours(\/|$)/.test(low)) v = { key: 'cours', name: 'Cours', path: null };
  else {
    let root = null;
    try {
      root = mainRoot(norm);
    } catch {
      /* dossier illisible : on garde le chemin tel quel */
    }
    const base = root || norm;
    v = { key: base.replaceAll('\\', '/').toLowerCase(), name: path.basename(base) || base, path: base };
  }
  projectCache.set(norm, { t: Date.now(), v });
  return v;
}

const withProject = (item, dir) => {
  const p = projectOf(dir);
  return { ...item, projectKey: p.key, projectName: p.name };
};

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');

function slimRun(r) {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    account: r.account,
    repoRoot: r.repoRoot,
    branch: r.branch,
    startedAt: r.startedAt,
    endedAt: r.endedAt || null,
    durationSec: r.durationSec ?? null,
    changes: r.changes ? { files: r.changes.files.length, added: r.changes.added, deleted: r.changes.deleted } : null,
    tests: r.tests ? { cmd: r.tests.cmd || null, passed: !!r.tests.passed, skipped: !!r.tests.skipped, exit: r.tests.exit ?? null } : null,
    summary: clip(r.summary, 500),
    taskId: r.taskId || null,
    cleaned: !!r.cleaned,
    projectDir: r.repoRoot,
  };
}

export function codexAccounts() {
  const g = loadGlobal();
  return g.accounts.map((a) => ({
    name: a.name,
    id: `codex:${a.name}`,
    loggedIn: isLoggedIn(a),
    limitedUntil: limitedUntil(a.name) || null,
    isDefault: a.name === g.defaultAccount,
  }));
}

/** Photo complète de ce que le dashboard affiche. */
export function buildState() {
  const notes = listAgentNotes();
  const sessions = listSessions({ limit: 60 }).map(({ transcript, ...s }, i) => ({
    ...withProject(s, s.cwd),
    now: i < 15 || s.status === 'running' ? sessionNow({ ...s, transcript }) : null,
    note: notes[s.id] || null,
  }));
  const runs = listRuns().slice(0, 60).map((r) => withProject(slimRun(r), r.repoRoot));
  const accounts = codexAccounts().map((a) => ({
    ...a,
    running: runs.filter((r) => r.account === a.name && r.status === 'running').length,
    note: notes[a.id] || null,
  }));
  const tasks = listTasks().map((t) => withProject(t, t.project));
  const known = new Map();
  for (const x of [...tasks, ...runs, ...sessions]) {
    const dir = x.project || x.projectDir || x.cwd;
    const p = projectOf(dir);
    if (p.path && !known.has(p.key)) known.set(p.key, p);
  }
  return {
    now: new Date().toISOString(),
    sessions,
    accounts,
    runs,
    tasks,
    projects: [...known.values()].sort((a, b) => a.name.localeCompare(b.name)),
    messages: listMessages({ limit: 150 }),
    userUnread: unread('user').map((m) => m.id),
    limits: { maxParallelCodex: MAX_PARALLEL_CODEX },
  };
}

/** Empreinte du contenu (sans l'horloge) pour ne notifier l'interface que quand quelque chose change. */
export function stateHash(state) {
  const { now, ...rest } = state;
  return crypto.createHash('sha1').update(JSON.stringify(rest)).digest('hex').slice(0, 12);
}

/**
 * Lance une tâche sur Codex (compte a|b) : réserve la tâche (atomique), écrit le brief puis démarre `ah run` détaché, lié à la tâche.
 * La sortie du processus va dans bus/briefs/<id>.log ; un échec au démarrage remet la tâche en "failed".
 */
export function dispatchTask(id, acct, by = 'user', { spawner = spawn } = {}) {
  const t = getTask(id);
  if (!t) throw new Error(`tâche introuvable: ${id}`);
  if (!t.project) throw new Error(`${id} n'a pas de projet (dossier du dépôt git) : impossible de lancer Codex`);
  if (!mainRoot(t.project)) throw new Error(`${t.project} n'est pas un dépôt git (ou n'existe pas) : impossible de lancer Codex`);
  const accounts = codexAccounts();
  const a = accounts.find((x) => x.name === acct);
  if (!a) throw new Error(`compte inconnu: ${acct} (disponibles: ${accounts.map((x) => x.name).join(', ') || 'aucun'})`);
  if (a.limitedUntil) throw new Error(`le compte ${acct} a atteint son quota jusqu'à ${a.limitedUntil}`);
  const externalRunning = listRuns().filter((r) => r.status === 'running' && !r.taskId).length;
  const reserved = reserveForDispatch(id, acct, { max: MAX_PARALLEL_CODEX, externalRunning, by });

  ensureDir(BRIEFS);
  const brief = path.join(BRIEFS, `${t.id}.md`);
  const body = [`# ${t.title}`, '', t.brief || '(pas de détail : voir le titre)', ''];
  if (t.notes?.length) body.push('## Notes de la tâche', ...t.notes.map((n) => `- ${n.by}: ${n.text}`), '');
  let fd = null;
  try {
    fs.writeFileSync(brief, body.join('\n'));
    fd = fs.openSync(path.join(BRIEFS, `${t.id}.log`), 'w');
    const child = spawner(process.execPath, [AH_BIN, 'run', brief, '--acct', acct, '--repo', t.project, '--title', t.title, '--task', t.id], {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    child.once?.('error', (e) => failTaskIfNotStarted(t.id, e.message));
    child.unref?.();
  } catch (e) {
    failTaskIfNotStarted(t.id, e.message);
    throw e;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return reserved;
}
