import fs from 'node:fs';
import path from 'node:path';
import { HUB_DIR, ensureDir, readJson } from './util.mjs';

/**
 * Bus de coordination : tâches, messages et statuts des agents (sessions Claude, comptes Codex, utilisateur).
 * Tout est stocké en fichiers sous ~/.agent-hub/bus : aucun serveur requis, lisible par le dashboard et la CLI.
 * Les écritures passent par un verrou (dossier atomique) pour que plusieurs sessions puissent écrire en même temps.
 */
export const BUS_DIR = path.join(HUB_DIR, 'bus');
const TASKS = path.join(BUS_DIR, 'tasks');
const AGENTS = path.join(BUS_DIR, 'agents');
const READS = path.join(BUS_DIR, 'reads');
export const BRIEFS = path.join(BUS_DIR, 'briefs');
const MSG_FILE = path.join(BUS_DIR, 'messages.jsonl');

export const STATUSES = ['todo', 'claimed', 'running', 'review', 'done', 'failed', 'blocked'];
const OPEN = new Set(['todo', 'claimed', 'running', 'review', 'blocked']);

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]+/g, '_');
const now = () => new Date().toISOString();

function withLock(fn) {
  ensureDir(BUS_DIR);
  const lock = path.join(BUS_DIR, '.lock');
  const t0 = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmdirSync(lock); // verrou orphelin
      } catch {
        /* un autre processus l'a déjà levé */
      }
      if (Date.now() - t0 > 5_000) throw new Error('bus verrouillé (réessaie)');
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {
      /* déjà supprimé */
    }
  }
}

function writeAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
const writeJsonAtomic = (file, obj) => writeAtomic(file, JSON.stringify(obj, null, 2) + '\n');

function nextSeq(name) {
  const f = path.join(BUS_DIR, `.${name}.seq`);
  const n = (parseInt(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '0', 10) || 0) + 1;
  writeAtomic(f, String(n));
  return n;
}

/* ───────────── Tâches ───────────── */

export function getTask(id) {
  return readJson(path.join(TASKS, `${safe(id)}.json`));
}

export function listTasks({ status = null } = {}) {
  if (!fs.existsSync(TASKS)) return [];
  const out = [];
  for (const f of fs.readdirSync(TASKS)) {
    if (!f.endsWith('.json')) continue;
    const t = readJson(path.join(TASKS, f));
    if (t?.id && (!status || t.status === status)) out.push(t);
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

const saveTask = (t) => writeJsonAtomic(path.join(TASKS, `${safe(t.id)}.json`), t);

export function addTask({ title, brief = '', project = null, assignee = null, deps = [], priority = 1, createdBy = 'user' }) {
  if (!title || !String(title).trim()) throw new Error('titre requis');
  return withLock(() => {
    const t = {
      id: `T-${String(nextSeq('task')).padStart(3, '0')}`,
      title: String(title).trim(),
      brief,
      project,
      status: 'todo',
      assignee,
      createdBy,
      deps: [...new Set(deps.filter(Boolean))],
      priority: Math.max(0, Math.min(3, Number(priority) || 0)),
      runId: null,
      notes: [],
      createdAt: now(),
      updatedAt: now(),
    };
    saveTask(t);
    return t;
  });
}

export function depsDone(t, all = listTasks()) {
  const byId = new Map(all.map((x) => [x.id, x]));
  return (t.deps || []).every((d) => byId.get(d)?.status === 'done');
}

/** Tâches prêtes : à faire, dépendances terminées, non assignées à quelqu'un d'autre. */
export function readyTasks(agent = null) {
  const all = listTasks();
  return all
    .filter((t) => t.status === 'todo' && depsDone(t, all) && (!t.assignee || !agent || t.assignee === agent))
    .sort((a, b) => b.priority - a.priority || (a.createdAt < b.createdAt ? -1 : 1));
}

export function updateTask(id, patch, by = 'user') {
  return withLock(() => {
    const t = getTask(id);
    if (!t) throw new Error(`tâche introuvable: ${id}`);
    if (patch.status !== undefined && !STATUSES.includes(patch.status)) throw new Error(`statut invalide: ${patch.status}`);
    for (const k of ['status', 'assignee', 'runId', 'title', 'brief', 'project', 'priority', 'deps']) {
      if (patch[k] !== undefined) t[k] = patch[k];
    }
    if (patch.note) t.notes.push({ ts: now(), by, text: String(patch.note).slice(0, 2000) });
    t.updatedAt = now();
    saveTask(t);
    return t;
  });
}

export function claimTask(id, agent) {
  return withLock(() => {
    const all = listTasks();
    const t = id ? all.find((x) => x.id === id) : readyTasks(agent)[0];
    if (!t) throw new Error(id ? `tâche introuvable: ${id}` : 'aucune tâche prête');
    if (t.status !== 'todo') throw new Error(`${t.id} est déjà "${t.status}"${t.assignee ? ` (${t.assignee})` : ''}`);
    if (t.assignee && t.assignee !== agent) throw new Error(`${t.id} est assignée à ${t.assignee}`);
    if (!depsDone(t, all)) throw new Error(`${t.id} attend ses dépendances: ${t.deps.join(', ')}`);
    t.status = 'claimed';
    t.assignee = agent;
    t.updatedAt = now();
    saveTask(t);
    return t;
  });
}

/* ───────────── Messages ───────────── */

export function post({ from, to, body, taskId = null, kind = 'msg' }) {
  if (!from || !to || !String(body || '').trim()) throw new Error('message: from, to et body requis');
  return withLock(() => {
    const m = { id: nextSeq('msg'), ts: now(), from, to, kind, taskId, body: String(body).slice(0, 8000) };
    ensureDir(BUS_DIR);
    fs.appendFileSync(MSG_FILE, JSON.stringify(m) + '\n');
    return m;
  });
}

export function listMessages({ limit = 200, sinceId = 0 } = {}) {
  if (!fs.existsSync(MSG_FILE)) return [];
  const lines = fs.readFileSync(MSG_FILE, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const l of lines.slice(-Math.max(limit, 1) * 2)) {
    try {
      const m = JSON.parse(l);
      if (m.id > sinceId) out.push(m);
    } catch {
      /* ligne tronquée : ignorée */
    }
  }
  return out.slice(-limit);
}

const readsFile = (agent) => path.join(READS, `${safe(agent)}.json`);

export function unread(agent) {
  const last = readJson(readsFile(agent), { last: 0 }).last || 0;
  return listMessages({ limit: 500, sinceId: last }).filter((m) => (m.to === agent || m.to === '*') && m.from !== agent);
}

export function markRead(agent, upToId) {
  withLock(() => writeJsonAtomic(readsFile(agent), { last: upToId, ts: now() }));
}

/** Messages non lus pour `agent`, puis marqués lus (sauf peek). */
export function inbox(agent, { peek = false } = {}) {
  const msgs = unread(agent);
  if (!peek && msgs.length) markRead(agent, msgs[msgs.length - 1].id);
  return msgs;
}

/* ───────────── Statuts des agents ───────────── */

export function setAgentNote(id, patch) {
  return withLock(() => {
    const f = path.join(AGENTS, `${safe(id)}.json`);
    const cur = readJson(f, { id });
    const next = { ...cur, ...patch, id, ts: now() };
    writeJsonAtomic(f, next);
    return next;
  });
}

export function listAgentNotes() {
  if (!fs.existsSync(AGENTS)) return {};
  const out = {};
  for (const f of fs.readdirSync(AGENTS)) {
    const a = f.endsWith('.json') ? readJson(path.join(AGENTS, f)) : null;
    if (a?.id) out[a.id] = a;
  }
  return out;
}

/* ───────────── Liens avec les runs Codex ───────────── */

/** Appelé au démarrage d'un run lié à une tâche. */
export function onRunStarted(run) {
  if (!run.taskId || !getTask(run.taskId)) return;
  updateTask(run.taskId, { status: 'running', runId: run.id }, 'agent-hub');
}

/** Appelé à la fin d'un run : met la tâche en revue (ou en échec) et prévient son auteur. */
export function onRunFinished(run) {
  const t = run.taskId && getTask(run.taskId);
  if (!t) return null;
  const ok = run.status === 'completed' && (!run.tests?.cmd || run.tests.skipped || run.tests.passed);
  const status = ok ? 'review' : 'failed';
  const why = ok
    ? `${run.changes?.files?.length ?? 0} fichier(s), tests ${run.tests?.cmd ? 'OK' : 'non définis'}`
    : run.status !== 'completed'
      ? `run ${run.status}${run.errors?.length ? `: ${run.errors[0]}` : ''}`
      : 'tests en échec';
  updateTask(t.id, { status, runId: run.id, note: `Run ${run.id}: ${why}` }, 'agent-hub');
  const to = t.createdBy && t.createdBy !== `codex:${run.account}` ? t.createdBy : 'user';
  return post({ from: `codex:${run.account || 'a'}`, to, taskId: t.id, kind: 'event', body: `${t.id} « ${t.title} » → ${status} (${why}). \`ah show ${run.id} --patch\`` });
}

export const isOpen = (t) => OPEN.has(t.status);
