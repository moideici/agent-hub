import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  listTasks, listMessages, listAgentNotes, getTask, updateTask, reserveForDispatch, reserveForAnswer, failTaskIfNotStarted, nextQueued, markEscalated,
  readyTasks, listLocks, unread, BRIEFS,
} from './bus.mjs';
import { mainRoot } from './git.mjs';
import { listSessions, findSession, sessionNow } from './sessions.mjs';
import { listRuns } from './runs.mjs';
import { readProgress } from './progress.mjs';
import { loadGlobal } from './config.mjs';
import { limitedUntil, isLoggedIn, pickLocal } from './accounts.mjs';
import { gpuInfoSync } from './gpu.mjs';
import { ollamaPs, ollamaPsSync } from './ollama.mjs';
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
    readOnly: !!r.readOnly,
    fixes: r.fixes || 0,
    question: r.question || null,
    progress: r.status === 'running' && r.dir ? readProgress(r.dir) : null,
    backend: r.backend || 'codex',
    model: r.model || null,
    stats: [...(r.attempts || [])].reverse().find((a) => a.stats)?.stats || null,
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
  const allTasks = listTasks();
  // Le résultat complet d'une tâche peut être long : l'état n'en garde qu'un extrait (GET /api/tasks/<id> donne le reste)
  const slimResult = (r) => (r ? { ...r, text: clip(r.text, 600), truncated: (r.text || '').length > 600 } : r);
  const tasks = allTasks.filter((t) => !t.archived).map((t) => withProject({ ...t, result: slimResult(t.result) }, t.project));
  const known = new Map();
  for (const x of [...tasks, ...runs, ...sessions]) {
    const dir = x.project || x.projectDir || x.cwd;
    const p = projectOf(dir);
    if (p.path && !known.has(p.key)) known.set(p.key, p);
  }
  // Qui travaille où : sessions actives, runs Codex en cours et projets réservés. Deux agents ou plus = risque de conflit.
  const presence = new Map();
  const here = (key, name, agent) => {
    if (!presence.has(key)) presence.set(key, { projectKey: key, projectName: name, agents: [] });
    const p = presence.get(key);
    if (!p.agents.some((a) => a.id === agent.id)) p.agents.push(agent);
  };
  for (const s of sessions) if (s.status === 'running') here(s.projectKey, s.projectName, { id: s.id, kind: 'session', label: s.title });
  for (const r of runs) if (r.status === 'running') here(r.projectKey, r.projectName, { id: `codex:${r.account}`, kind: 'run', label: `ChatGPT ${r.account}` });
  const locks = listLocks().map((l) => {
    const p = projectOf(l.path || l.key);
    here(p.key, p.name, { id: l.holder, kind: 'lock', label: l.holder, note: l.note });
    return { ...l, projectKey: p.key, projectName: p.name };
  });
  return {
    now: new Date().toISOString(),
    sessions,
    accounts,
    runs,
    tasks,
    archivedCount: allTasks.length - tasks.length,
    locks,
    presence: [...presence.values()].map((p) => ({ ...p, conflict: p.agents.length > 1 })),
    projects: [...known.values()].sort((a, b) => a.name.localeCompare(b.name)),
    messages: listMessages({ limit: 150 }),
    userUnread: unread('user').map((m) => m.id),
    limits: { maxParallelCodex: MAX_PARALLEL_CODEX },
    local: loadGlobal().local.map((l) => ({
      id: l.id, name: l.name, label: l.label, model: l.model, role: l.role, ctx: l.ctx, think: l.think ?? null, vramMiB: l.vramMiB,
      running: allTasks.filter((t) => t.status === 'running' && t.assignee === l.id).length,
      ...(localCache.models[l.id] || { state: 'unknown' }),
    })),
    gpu: localCache.gpu,
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
export function dispatchTask(id, acct, by = 'user', { spawner = spawn, briefFile = null } = {}) {
  const t = getTask(id);
  if (!t) throw new Error(`tâche introuvable: ${id}`);
  const cfg = loadGlobal();
  const lm = pickLocal(cfg, acct); // modèle local (Ollama) plutôt que ChatGPT
  const who = lm ? 'un modèle local' : 'Codex';
  if (!t.project) throw new Error(`${id} n'a pas de projet (dossier du dépôt git) : impossible de lancer ${who}`);
  if (!mainRoot(t.project)) throw new Error(`${t.project} n'est pas un dépôt git (ou n'existe pas) : impossible de lancer ${who}`);
  let reserved;
  if (lm) {
    reserved = reserveForDispatch(id, lm.name, { max: MAX_PARALLEL_CODEX, maxLocal: cfg.localMaxParallel, by, kind: 'ollama' });
  } else {
    const accounts = codexAccounts();
    const a = accounts.find((x) => x.name === acct);
    if (!a) throw new Error(`compte inconnu: ${acct} (disponibles: ${[...accounts.map((x) => x.name), ...cfg.local.map((l) => l.name)].join(', ') || 'aucun'})`);
    if (a.limitedUntil) throw new Error(`le compte ${acct} a atteint son quota jusqu'à ${a.limitedUntil}`);
    const externalRunning = listRuns().filter((r) => r.status === 'running' && !r.taskId && r.backend !== 'ollama').length;
    reserved = reserveForDispatch(id, acct, { max: MAX_PARALLEL_CODEX, externalRunning, by });
  }
  const target = lm ? lm.name : acct;
  const lock = listLocks().find((l) => l.key === projectOf(t.project).key && l.holder !== by);
  if (lock) updateTask(id, { note: `Attention : ce projet est réservé par ${lock.holder}${lock.note ? ` (${lock.note})` : ''}` }, 'agent-hub');

  ensureDir(BRIEFS);
  let brief = briefFile; // brief préparé (escalade) : utilisé tel quel
  let fd = null;
  try {
    if (!brief) {
      brief = path.join(BRIEFS, `${t.id}.md`);
      const body = [`# ${t.title}`, '', t.brief || '(pas de détail : voir le titre)', ''];
      if (t.notes?.length) body.push('## Notes de la tâche', ...t.notes.map((n) => `- ${n.by}: ${n.text}`), '');
      fs.writeFileSync(brief, body.join('\n'));
    }
    fd = fs.openSync(path.join(BRIEFS, `${t.id}.log`), 'w');
    const child = spawner(process.execPath, [AH_BIN, 'run', brief, '--acct', target, '--repo', t.project, '--title', t.title, '--task', t.id, ...(t.sandbox ? ['--sandbox', t.sandbox] : []), ...(t.includeDirty ? ['--include-dirty'] : [])], {
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

/** Compte à utiliser pour une tâche en file : celui demandé s'il est disponible, sinon le moins chargé. */
export function chooseAccount(want = 'any', accounts = codexAccounts(), tasks = listTasks()) {
  const lm = want && want !== 'any' ? pickLocal(loadGlobal(), want) : null;
  if (lm) return chooseLocal(lm, tasks);
  const usable = accounts.filter((a) => a.loggedIn !== false && !a.limitedUntil);
  if (want && want !== 'any') return usable.find((a) => a.name === want)?.name || null;
  const load = (a) => tasks.filter((t) => t.status === 'running' && t.assignee === `codex:${a.name}`).length;
  usable.sort((x, y) => load(x) - load(y) || Number(y.isDefault) - Number(x.isDefault) || x.name.localeCompare(y.name));
  return usable[0]?.name || null;
}

/**
 * La carte a-t-elle assez de mémoire pour ce modèle ? Les modèles déjà chargés par Ollama comptent comme libérables
 * (un seul modèle chargé à la fois : Ollama décharge l'ancien). Sans nvidia-smi ou sans estimation : on laisse faire.
 */
export function gpuAllows(lm) {
  if (!lm.vramMiB) return true;
  const gpu = gpuInfoSync();
  if (!gpu) return true;
  const loaded = ollamaPsSync(lm.host)?.models || [];
  const evictable = loaded.reduce((n, m) => n + (m.size_vram || 0) / 1048576, 0);
  return gpu.freeMiB + evictable >= lm.vramMiB;
}

/** Modèle local à utiliser maintenant : un seul à la fois (carte partagée) et assez de VRAM libre. null sinon. */
export function chooseLocal(lm, tasks = listTasks(), cfg = loadGlobal()) {
  const busy = tasks.filter((t) => t.status === 'running' && String(t.assignee || '').startsWith('ollama:')).length;
  if (busy >= cfg.localMaxParallel) return null;
  return gpuAllows(lm) ? lm.name : null;
}

/** Envoie à ChatGPT une tâche qui a échoué en local : seulement si l'escalade préparée a été vérifiée (cette commande EST la vérification). */
export function escalateTask(id, acct, by = 'user', opts = {}) {
  const t = getTask(id);
  if (!t) throw new Error(`tâche introuvable: ${id}`);
  if (!t.escalation || t.escalation.state !== 'proposed') throw new Error(`${id} n'a pas d'escalade en attente (elle est préparée quand un modèle local échoue)`);
  if (pickLocal(loadGlobal(), acct)) throw new Error("l'escalade doit viser un compte ChatGPT (a ou b), pas un modèle local");
  const res = dispatchTask(id, acct, by, { ...opts, briefFile: t.escalation.briefFile });
  markEscalated(id, acct, by);
  return res;
}

/* ───── Modèles locaux : état mis en cache (le planificateur et buildState sont synchrones) ───── */
let localCache = { at: 0, models: {}, gpu: null };

/** Interroge Ollama (modèles chargés) et la carte ; appelée régulièrement par le dashboard. */
export async function refreshLocalStatus() {
  const cfg = loadGlobal();
  const models = {};
  for (const l of cfg.local) {
    try {
      const ps = await ollamaPs(l.host);
      const m = (ps.models || []).find((x) => x.name === l.model || x.model === l.model);
      models[l.id] = m ? { state: 'loaded', sizeVramMiB: Math.round((m.size_vram || 0) / 1048576), sizeMiB: Math.round((m.size || 0) / 1048576), expiresAt: m.expires_at || null } : { state: 'idle' };
    } catch {
      models[l.id] = { state: 'down' };
    }
  }
  localCache = { at: Date.now(), models, gpu: cfg.local.length ? gpuInfoSync() : null };
}

/**
 * File d'attente : lance les tâches « queued » tant qu'il reste de la place (maximum de runs en parallèle) et un compte disponible.
 * Appelée à la mise en file, par le dashboard et à la fin de chaque run : la file avance toute seule.
 */
export function pumpQueue({ spawner } = {}) {
  const started = [];
  const skip = new Set();
  for (let i = 0; i < 20; i++) {
    const t = nextQueued(skip);
    if (!t) break;
    const acct = chooseAccount(t.queueAcct);
    if (!acct) {
      skip.add(t.id); // aucun compte disponible pour cette tâche : on essaie la suivante
      continue;
    }
    try {
      dispatchTask(t.id, acct, 'queue', { spawner });
      started.push({ id: t.id, acct });
    } catch (e) {
      if (/déjà en cours ou réservés/.test(e.message)) break; // plus de place
      skip.add(t.id);
      if (/pas un dépôt git|pas de projet/.test(e.message)) updateTask(t.id, { status: 'failed', note: `File d'attente : ${e.message}` }, 'queue');
    }
  }
  return started;
}

/** Répond à la question d'un run Codex : la tâche repart (même worktree, même travail) avec ta réponse. */
export function answerTask(id, answer, by = 'user', { spawner = spawn } = {}) {
  const before = getTask(id);
  if (!before) throw new Error(`tâche introuvable: ${id}`);
  const reserved = reserveForAnswer(id, answer, by);
  ensureDir(BRIEFS);
  const file = path.join(BRIEFS, `${id}.answer-${Date.now()}.md`);
  fs.writeFileSync(file, String(answer));
  const acct = String(before.assignee || '').startsWith('codex:') ? before.assignee.slice(6) : null;
  let fd = null;
  try {
    fd = fs.openSync(path.join(BRIEFS, `${id}.log`), 'a');
    const child = spawner(process.execPath, [AH_BIN, 'run', '--continue', before.runId, '--answer', file, '--task', id, ...(acct ? ['--acct', acct] : [])], {
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
    const undo = (why) => updateTask(id, { status: 'waiting', note: `Reprise impossible : ${why}` }, 'agent-hub');
    child.once?.('error', (e) => undo(e.message));
    child.unref?.();
  } catch (e) {
    updateTask(id, { status: 'waiting', note: `Reprise impossible : ${e.message}` }, 'agent-hub');
    throw e;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  return reserved;
}

/**
 * Résumé de ce qui concerne cet agent, injecté au démarrage d'une session (et après une compaction) :
 * ses tâches, ce qui attend sa décision, ses runs en cours, ses messages non lus, les projets réservés.
 * Vide quand il n'y a rien à dire.
 */
export function briefFor(agent) {
  const tasks = listTasks().filter((t) => !t.archived);
  const line = (t) => `${t.id} [${t.status}] ${t.title}`;
  const mine = tasks.filter((t) => t.assignee === agent && ['claimed', 'running', 'waiting', 'blocked', 'review'].includes(t.status));
  const asks = tasks.filter((t) => t.status === 'waiting' && t.createdBy === agent);
  const toReview = tasks.filter((t) => t.status === 'review' && t.createdBy === agent);
  const running = tasks.filter((t) => t.createdBy === agent && ['running', 'queued'].includes(t.status) && String(t.assignee || t.queueAcct || '').length);
  const ready = readyTasks(agent).slice(0, 4);
  const n = unread(agent).length;
  const locks = listLocks();
  const out = [];
  if (asks.length) out.push('Codex attend TA réponse :', ...asks.map((t) => `  ${line(t)} → ah task answer ${t.id} "…"`));
  if (toReview.length) out.push('À relire (travail terminé, à valider) :', ...toReview.map((t) => `  ${line(t)} → ah show ${t.runId || ''} --patch`));
  if (mine.length) out.push('Tes tâches en cours :', ...mine.filter((t) => !asks.includes(t) && !toReview.includes(t)).map((t) => `  ${line(t)}`));
  if (running.length) out.push('Travaux que tu as lancés :', ...running.map((t) => `  ${line(t)}${t.assignee ? ` (${t.assignee})` : ''}`));
  if (ready.length) out.push('Prêtes à prendre (ah task claim) :', ...ready.map((t) => `  ${line(t)}`));
  if (n) out.push(`${n} message${n > 1 ? 's' : ''} non lu${n > 1 ? 's' : ''} (ils arrivent avec ton prochain message ; ah msg inbox pour les lire maintenant).`);
  const others = locks.filter((l) => l.holder !== agent);
  if (others.length) out.push('Projets réservés par d\'autres :', ...others.map((l) => `  ${l.key} : ${l.holder}${l.note ? ` — ${l.note}` : ''}`));
  return out.length ? `agent-hub — résumé pour toi (${agent}) :\n${out.join('\n')}` : '';
}
