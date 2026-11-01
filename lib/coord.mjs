import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listTasks, listMessages, listAgentNotes, getTask, updateTask, BRIEFS } from './bus.mjs';
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
  const sessions = listSessions({ limit: 40 }).map(({ transcript, ...s }, i) => ({
    ...s,
    now: i < 15 || s.status === 'running' ? sessionNow({ ...s, transcript }) : null,
    note: notes[s.id] || null,
  }));
  const runs = listRuns().slice(0, 40).map(slimRun);
  const accounts = codexAccounts().map((a) => ({
    ...a,
    running: runs.filter((r) => r.account === a.name && r.status === 'running').length,
    note: notes[a.id] || null,
  }));
  return {
    now: new Date().toISOString(),
    sessions,
    accounts,
    runs,
    tasks: listTasks(),
    messages: listMessages({ limit: 150 }),
    limits: { maxParallelCodex: MAX_PARALLEL_CODEX },
  };
}

/** Empreinte du contenu (sans l'horloge) pour ne notifier l'interface que quand quelque chose change. */
export function stateHash(state) {
  const { now, ...rest } = state;
  return crypto.createHash('sha1').update(JSON.stringify(rest)).digest('hex').slice(0, 12);
}

/** Lance une tâche sur Codex (compte a|b) : écrit le brief puis démarre `ah run` détaché, lié à la tâche. */
export function dispatchTask(id, acct, by = 'user') {
  const t = getTask(id);
  if (!t) throw new Error(`tâche introuvable: ${id}`);
  if (!t.project) throw new Error(`${id} n'a pas de projet (dossier du dépôt git) : impossible de lancer Codex`);
  if (!['todo', 'claimed', 'blocked', 'failed'].includes(t.status)) throw new Error(`${id} est "${t.status}" : rien à lancer`);
  const accounts = codexAccounts();
  const a = accounts.find((x) => x.name === acct);
  if (!a) throw new Error(`compte inconnu: ${acct} (disponibles: ${accounts.map((x) => x.name).join(', ') || 'aucun'})`);
  if (a.limitedUntil) throw new Error(`le compte ${acct} a atteint son quota jusqu'à ${a.limitedUntil}`);
  const running = listRuns().filter((r) => r.status === 'running').length;
  if (running >= MAX_PARALLEL_CODEX) throw new Error(`${running} runs Codex déjà en cours (maximum ${MAX_PARALLEL_CODEX})`);

  ensureDir(BRIEFS);
  const brief = path.join(BRIEFS, `${t.id}.md`);
  const body = [`# ${t.title}`, '', t.brief || '(pas de détail : voir le titre)', ''];
  if (t.notes?.length) body.push('## Notes de la tâche', ...t.notes.map((n) => `- ${n.by}: ${n.text}`), '');
  fs.writeFileSync(brief, body.join('\n'));

  const child = spawn(process.execPath, [AH_BIN, 'run', brief, '--acct', acct, '--repo', t.project, '--title', t.title, '--task', t.id], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return updateTask(id, { status: 'running', assignee: `codex:${acct}`, note: `Lancé sur Codex (compte ${acct})` }, by);
}
