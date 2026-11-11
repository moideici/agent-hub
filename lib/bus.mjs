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

// queued = en file d'attente (lancée automatiquement dès qu'une place se libère) ; waiting = Codex attend une réponse
export const STATUSES = ['todo', 'queued', 'claimed', 'running', 'waiting', 'review', 'done', 'failed', 'blocked'];
const OPEN = new Set(['todo', 'queued', 'claimed', 'running', 'waiting', 'review', 'blocked']);

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

export function addTask({ title, brief = '', project = null, assignee = null, deps = [], priority = 1, createdBy = 'user', sandbox = null, includeDirty = false }) {
  if (!title || !String(title).trim()) throw new Error('titre requis');
  if (sandbox && !['read-only', 'workspace-write'].includes(sandbox)) throw new Error('sandbox invalide (read-only ou workspace-write)');
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
      sandbox: sandbox || null, // 'read-only' = audit : Codex lit le projet sans rien modifier
      includeDirty: !!includeDirty, // inclut les modifications non commitées du dépôt dans ce que Codex voit
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
    for (const k of ['status', 'assignee', 'runId', 'title', 'brief', 'project', 'priority', 'deps', 'result', 'archived', 'queueAcct', 'sandbox', 'includeDirty', 'escalation', 'escalate']) {
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
  // Pas de limite avant le filtre : sinon, après beaucoup de trafic entre d'autres agents, un message non lu disparaîtrait.
  return listMessages({ limit: Infinity, sinceId: last }).filter((m) => (m.to === agent || m.to === '*') && m.from !== agent);
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

/** Extrait un objet JSON d'un texte : dernier bloc ```json, ou texte entier s'il est du JSON. */
export function extractJson(text) {
  const s = String(text || '');
  const blocks = [...s.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const candidates = [...blocks.map((m) => m[1]), s.trim()];
  for (const c of candidates.reverse()) {
    if (!c.trim().startsWith('{') && !c.trim().startsWith('[')) continue;
    try {
      return JSON.parse(c);
    } catch {
      /* pas du JSON valide : on essaie le candidat suivant */
    }
  }
  return null;
}

/** Appelé à la fin d'un run : met la tâche en revue (ou en échec / en attente d'une réponse), garde le résultat et prévient son auteur. */
export function onRunFinished(run) {
  const t = run.taskId && getTask(run.taskId);
  if (!t) return null;
  const local = run.backend === 'ollama';
  const from = local ? `ollama:${run.account}` : `codex:${run.account || 'a'}`;
  const to = t.createdBy && t.createdBy !== from ? t.createdBy : 'user';
  const result = { text: String(run.summary || '').slice(0, 20_000), data: extractJson(run.summary), at: now(), by: from, runId: run.id };
  if (run.status === 'needs-input') {
    updateTask(t.id, { status: 'waiting', runId: run.id, result, note: `Question de Codex : ${run.question}` }, 'agent-hub');
    return post({ from, to, taskId: t.id, kind: 'ask', body: `${t.id} « ${t.title} » attend ta réponse : ${run.question}\n→ ah task answer ${t.id} "ta réponse"` });
  }
  const ok = run.status === 'completed' && (!run.tests?.cmd || run.tests.skipped || run.tests.passed);
  const status = ok ? 'review' : 'failed';
  const fixes = run.fixes ? `, ${run.fixes} correction${run.fixes > 1 ? 's' : ''} automatique${run.fixes > 1 ? 's' : ''}` : '';
  const why = ok
    ? run.readOnly
      ? 'audit terminé (lecture seule)'
      : `${run.changes?.files?.length ?? 0} fichier(s), tests ${run.tests?.cmd ? 'OK' : 'non définis'}${fixes}`
    : run.status !== 'completed'
      ? `run ${run.status}${run.errors?.length ? `: ${run.errors[0]}` : ''}`
      : `tests en échec${fixes}`;
  // Échec d'un modèle local : on PRÉPARE le passage à ChatGPT (brief enrichi) sans rien lancer ; il attend ta vérification
  const escalation = !ok && local && t.escalate !== false && !t.escalation ? prepareEscalation(t, run, why) : null;
  updateTask(t.id, { status, runId: run.id, result, ...(escalation ? { escalation } : {}), note: `Run ${run.id}: ${why}` }, 'agent-hub');
  if (escalation) {
    post({ from, to, taskId: t.id, kind: 'ask', body: `${t.id} « ${t.title} » a échoué en local (${why}). Escalade vers ChatGPT PRÉPARÉE, rien n'est lancé : relis le brief (${escalation.briefFile}) puis \`ah task escalate ${t.id} --acct a|b\` (ou --dismiss).` });
  }
  return post({ from, to, taskId: t.id, kind: 'event', body: `${t.id} « ${t.title} » → ${status} (${why}). \`ah show ${run.id}${run.readOnly ? '' : ' --patch'}\`` });
}

/* ───────────── File d'attente, réponses, archivage ───────────── */

/** Met des tâches en file : elles partent toutes seules sur Codex dès qu'une place se libère. */
export function queueTask(id, acct = 'any', by = 'user') {
  return withLock(() => {
    const t = getTask(id);
    if (!t) throw new Error(`tâche introuvable: ${id}`);
    if (!t.project) throw new Error(`${id} n'a pas de projet : impossible de la mettre en file`);
    if (!['todo', 'blocked', 'failed', 'claimed'].includes(t.status)) throw new Error(`${id} est "${t.status}" : rien à mettre en file`);
    t.status = 'queued';
    t.queueAcct = acct || 'any';
    t.notes.push({ ts: now(), by, text: `Mise en file d'attente (compte ${t.queueAcct})` });
    t.updatedAt = now();
    saveTask(t);
    return t;
  });
}

export function unqueueTask(id, by = 'user') {
  return withLock(() => {
    const t = getTask(id);
    if (!t || t.status !== 'queued') throw new Error(`${id} n'est pas en file d'attente`);
    t.status = 'todo';
    t.notes.push({ ts: now(), by, text: "Retirée de la file d'attente" });
    t.updatedAt = now();
    saveTask(t);
    return t;
  });
}

/** Prochaine tâche à lancer : en file, dépendances terminées, plus prioritaire d'abord. */
export function nextQueued(skip = new Set()) {
  const all = listTasks();
  return all
    .filter((t) => t.status === 'queued' && !skip.has(t.id) && depsDone(t, all))
    .sort((a, b) => b.priority - a.priority || (a.createdAt < b.createdAt ? -1 : 1))[0] || null;
}

/** Réserve (atomique) une tâche qui attend une réponse : elle repasse en "running" pour que Codex reprenne. */
export function reserveForAnswer(id, answer, by = 'user') {
  return withLock(() => {
    const t = getTask(id);
    if (!t) throw new Error(`tâche introuvable: ${id}`);
    if (t.status !== 'waiting') throw new Error(`${id} n'attend pas de réponse (statut "${t.status}")`);
    if (!t.runId) throw new Error(`${id} n'a pas de run à reprendre`);
    if (!String(answer || '').trim()) throw new Error('réponse vide');
    t.status = 'running';
    t.notes.push({ ts: now(), by, text: `Réponse : ${String(answer).slice(0, 1500)}` });
    t.updatedAt = now();
    saveTask(t);
    return t;
  });
}

export function archiveTask(id, archived = true, by = 'user') {
  return updateTask(id, { archived: !!archived, note: archived ? 'Archivée' : 'Désarchivée' }, by);
}

/** Supprime définitivement une tâche terminée, en échec ou archivée. */
export function deleteTask(id) {
  return withLock(() => {
    const t = getTask(id);
    if (!t) throw new Error(`tâche introuvable: ${id}`);
    if (!t.archived && !['done', 'failed'].includes(t.status)) throw new Error(`${id} est "${t.status}" : archive-la ou termine-la d'abord`);
    fs.rmSync(path.join(TASKS, `${safe(id)}.json`), { force: true });
    return t;
  });
}

/* ───────────── Réservations de projet (consultatives) ───────────── */

const LOCKS = path.join(BUS_DIR, 'locks');
export const LOCK_TTL_MS = 6 * 3600_000;
const lockFile = (key) => path.join(LOCKS, `${safe(String(key).toLowerCase())}.json`);

/** « Je travaille sur ce projet » : prévient les autres sessions sans rien bloquer. Expire après 6 h sans rafraîchissement. */
export function lockProject(key, { holder, note = '', path: dir = null }) {
  if (!key || !holder) throw new Error('projet et titulaire requis');
  return withLock(() => {
    const cur = readJson(lockFile(key));
    const fresh = cur && Date.now() - Date.parse(cur.ts) < LOCK_TTL_MS;
    const l = { key, path: dir || cur?.path || null, holder, note, since: fresh && cur.holder === holder ? cur.since : now(), ts: now() };
    writeJsonAtomic(lockFile(key), l);
    return { lock: l, previous: fresh && cur.holder !== holder ? cur : null };
  });
}

export function unlockProject(key, holder) {
  return withLock(() => {
    const cur = readJson(lockFile(key));
    if (!cur) return false;
    if (cur.holder !== holder) throw new Error(`réservé par ${cur.holder}, pas par toi`);
    fs.rmSync(lockFile(key), { force: true });
    return true;
  });
}

export function listLocks() {
  if (!fs.existsSync(LOCKS)) return [];
  const out = [];
  for (const f of fs.readdirSync(LOCKS)) {
    const l = f.endsWith('.json') ? readJson(path.join(LOCKS, f)) : null;
    if (l?.key && Date.now() - Date.parse(l.ts) < LOCK_TTL_MS) out.push(l);
  }
  return out.sort((a, b) => (a.since < b.since ? -1 : 1));
}

/**
 * Réserve une tâche pour un lancement Codex, de façon atomique : vérifie statut, dépendances et nombre de runs
 * en vol (tâches déjà réservées comprises), puis la passe en "running". Évite les doubles lancements et le dépassement du maximum.
 */
export function reserveForDispatch(id, acct, { max, maxLocal = 1, externalRunning = 0, by = 'user', kind = 'codex' }) {
  return withLock(() => {
    const all = listTasks();
    const t = all.find((x) => x.id === id);
    if (!t) throw new Error(`tâche introuvable: ${id}`);
    if (!t.project) throw new Error(`${id} n'a pas de projet (dossier du dépôt git) : impossible de lancer Codex`);
    if (!['todo', 'queued', 'claimed', 'blocked', 'failed'].includes(t.status)) throw new Error(`${id} est "${t.status}" : rien à lancer`);
    if (!depsDone(t, all)) throw new Error(`${id} attend ses dépendances: ${t.deps.join(', ')}`);
    const local = kind === 'ollama';
    if (local) {
      // la carte graphique est partagée : un seul modèle local travaille à la fois (les runs ChatGPT, eux, continuent en parallèle)
      const busy = all.filter((x) => x.status === 'running' && String(x.assignee || '').startsWith('ollama:')).length;
      if (busy >= maxLocal) throw new Error(`un travail local est déjà en cours (maximum ${maxLocal} à la fois : la carte graphique est partagée)`);
    } else {
      const inFlight = all.filter((x) => x.status === 'running' && String(x.assignee || '').startsWith('codex:')).length + externalRunning;
      if (inFlight >= max) throw new Error(`${inFlight} runs Codex déjà en cours ou réservés (maximum ${max})`);
    }
    t.status = 'running';
    t.assignee = local ? `ollama:${acct}` : `codex:${acct}`;
    t.runId = null;
    t.notes.push({ ts: now(), by, text: local ? `Lancé sur le modèle local ${acct}` : `Lancé sur Codex (compte ${acct})` });
    t.updatedAt = now();
    saveTask(t);
    return t;
  });
}

/**
 * Brief d'escalade vers ChatGPT après l'échec d'un modèle local : la tâche d'origine + ce que l'essai local a produit
 * (raison de l'échec, résumé, sortie des tests, modifications tentées). Écrit dans bus/briefs/<id>.escalation.md.
 */
export function prepareEscalation(t, run, why) {
  const clipText = (x, n) => (String(x || '').length > n ? `${String(x).slice(0, n)}\n… (tronqué)` : String(x || ''));
  const fence = '```';
  let diff = '';
  try {
    diff = fs.readFileSync(path.join(run.dir, 'diff.patch'), 'utf8');
  } catch {
    /* pas de modifications gardées */
  }
  const parts = [
    `# ${t.title}`, '', t.brief || '(pas de détail : voir le titre)', '',
    '## Un essai précédent avec un modèle local a échoué', '',
    `Modèle : ${run.model || run.account} · raison : ${why}`, '',
    "Le worktree que tu reçois est PROPRE : les modifications de l'essai local n'y sont pas. Elles sont données ci-dessous comme indices (elles peuvent être fausses). Résous la tâche en vérifiant tout par toi-même.", '',
  ];
  if (run.summary) parts.push('### Résumé du modèle local', clipText(run.summary, 1500), '');
  if (run.tests?.tail) parts.push("### Sortie des tests de l'essai local", fence, clipText(run.tests.tail, 2500), fence, '');
  if (diff) parts.push('### Modifications tentées (diff)', `${fence}diff`, clipText(diff, 6000), fence, '');
  const file = path.join(BRIEFS, `${t.id}.escalation.md`);
  ensureDir(BRIEFS);
  fs.writeFileSync(file, parts.join('\n'));
  return { state: 'proposed', from: `ollama:${run.account}`, runId: run.id, reason: why, briefFile: file, at: now() };
}

export function dismissEscalation(id, by = 'user') {
  const t = getTask(id);
  if (!t?.escalation || t.escalation.state !== 'proposed') throw new Error(`${id} n'a pas d'escalade en attente`);
  return updateTask(id, { escalation: { ...t.escalation, state: 'dismissed' }, note: 'Escalade vers ChatGPT écartée' }, by);
}

export function markEscalated(id, acct, by = 'user') {
  const t = getTask(id);
  return updateTask(id, { escalation: { ...t.escalation, state: 'sent', to: `codex:${acct}`, sentAt: now() }, note: `Escalade envoyée à ChatGPT (compte ${acct}), vérifiée par ${by}` }, by);
}

/** Le run n'a jamais démarré (erreur au lancement) : la tâche redevient relançable au lieu de rester "running" pour toujours. */
export function failTaskIfNotStarted(id, why) {
  return withLock(() => {
    const t = getTask(id);
    if (!t || t.status !== 'running' || t.runId) return null;
    t.status = 'failed';
    t.notes.push({ ts: now(), by: 'agent-hub', text: `Lancement impossible: ${String(why).slice(0, 500)}` });
    t.updatedAt = now();
    saveTask(t);
    return t;
  });
}

/** Le processus du run est mort avant d'avoir rendu son verdict : la tâche ne doit pas rester « en cours » pour toujours. */
export function failTaskIfRunning(id, runId, why) {
  return withLock(() => {
    const t = getTask(id);
    if (!t || t.status !== 'running' || (t.runId && t.runId !== runId)) return null;
    t.status = 'failed';
    t.notes.push({ ts: now(), by: 'agent-hub', text: `Run interrompu: ${String(why).slice(0, 500)}` });
    t.updatedAt = now();
    saveTask(t);
    return t;
  });
}

export const isOpen = (t) => OPEN.has(t.status);
