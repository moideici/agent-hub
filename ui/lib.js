// Fonctions pures du dashboard (aucun accès au DOM) : regroupements, tri, textes. Testées dans test/ui-lib.test.mjs.

export const LANES = [
  { id: 'todo', label: 'À faire', statuses: ['todo'] },
  { id: 'doing', label: 'En cours', statuses: ['claimed', 'running'] },
  { id: 'review', label: 'À relire', statuses: ['review'] },
  { id: 'blocked', label: 'Bloqué', statuses: ['blocked', 'failed'] },
  { id: 'done', label: 'Terminées', statuses: ['done'] },
];

export const STATUS_LABEL = {
  todo: 'À faire', claimed: 'Prise', running: 'En cours', review: 'À relire', done: 'Terminée', blocked: 'Bloquée', failed: 'Échec',
  completed: 'Terminé', idle: 'Inactive', stale: 'Interrompu', limited: 'Quota atteint', timeout: 'Délai dépassé',
};

export const PRIORITY_LABEL = ['Basse', 'Normale', 'Haute', 'Urgente'];
export const OLD_SESSION_MS = 7 * 86_400_000;
const OPEN_STATUSES = new Set(['todo', 'claimed', 'running', 'review', 'blocked', 'failed']);
const DAY = 86_400_000;

const toMs = (v) => (typeof v === 'number' ? v : Date.parse(v));

export function relativeTime(value, now = Date.now()) {
  const t = toMs(value);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "à l'instant";
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24);
  if (d < 30) return `il y a ${d} j`;
  return new Date(t).toLocaleDateString('fr-FR');
}

export function clockTime(value) {
  const t = toMs(value);
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
}

/** Dernier segment d'un chemin Windows ou POSIX. */
export function shortPath(p) {
  const parts = String(p || '').split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || '';
}

export function formatDuration(sec) {
  if (sec == null || !Number.isFinite(+sec)) return '';
  const s = Math.round(+sec);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

export function agentKind(id) {
  if (id === 'user') return 'user';
  if (id === '*') return 'all';
  if (String(id).startsWith('codex:')) return 'codex';
  if (String(id).startsWith('claude:')) return 'claude';
  return 'other';
}

/** Nom lisible d'un agent à partir de son identifiant. */
export function agentName(id, state) {
  if (!id) return '—';
  if (id === 'user') return 'Toi';
  if (id === '*') return 'Tout le monde';
  if (id.startsWith('codex:')) return `ChatGPT ${id.slice(6)}`;
  if (id.startsWith('claude:')) return state?.sessions?.find((s) => s.id === id)?.title || 'Session Claude';
  return id;
}

export function initials(name) {
  const words = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
}

/** Teinte stable (0-359) pour colorer l'avatar d'un nom. */
export function hueOf(str) {
  let h = 0;
  for (const c of String(str)) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return h % 360;
}

export const isOpen = (t) => OPEN_STATUSES.has(t.status);
export const laneOf = (status) => LANES.find((l) => l.statuses.includes(status))?.id || 'todo';

const lanesObject = () => Object.fromEntries(LANES.map((l) => [l.id, []]));
const sortLane = (id, arr) =>
  arr.sort((a, b) =>
    id === 'todo' || id === 'doing'
      ? b.priority - a.priority || (a.createdAt < b.createdAt ? -1 : 1)
      : a.updatedAt < b.updatedAt ? 1 : -1,
  );

/**
 * Tâches regroupées par projet, puis par colonne d'état.
 * Les compteurs portent sur toutes les tâches filtrées ; `showDone` ne contrôle que l'affichage de la colonne « Terminées ».
 */
export function groupTasksByProject(tasks, { project = '', assignee = '', text = '', showDone = false } = {}) {
  const q = text.trim().toLowerCase();
  const groups = new Map();
  for (const t of tasks || []) {
    // '__none' sélectionne les tâches sans projet (la clé vide est déjà « tous les projets »)
    if (project && (project === '__none' ? t.projectKey : (t.projectKey || '') !== project)) continue;
    if (assignee && t.assignee !== assignee) continue;
    if (q && !`${t.id} ${t.title} ${t.brief || ''} ${t.projectName || ''}`.toLowerCase().includes(q)) continue;
    const key = t.projectKey || '';
    if (!groups.has(key)) {
      groups.set(key, {
        key, name: t.projectName || 'Sans projet', path: t.project || null, lanes: lanesObject(),
        counts: { todo: 0, doing: 0, review: 0, blocked: 0, done: 0, open: 0, total: 0 }, latest: '',
      });
    }
    const g = groups.get(key);
    const lane = laneOf(t.status);
    g.counts[lane]++;
    g.counts.total++;
    if (lane !== 'done') g.counts.open++;
    if (t.updatedAt > g.latest) g.latest = t.updatedAt;
    if (lane !== 'done' || showDone) g.lanes[lane].push(t);
  }
  const out = [...groups.values()].map((g) => {
    for (const l of LANES) sortLane(l.id, g.lanes[l.id]);
    return { ...g, progress: g.counts.total ? g.counts.done / g.counts.total : 0, attention: g.counts.review + g.counts.blocked };
  });
  return out.sort(
    (a, b) => (b.counts.open > 0) - (a.counts.open > 0) || b.attention - a.attention || (a.latest < b.latest ? 1 : -1) || a.name.localeCompare(b.name),
  );
}

/** Sessions regroupées par projet ; les sessions inactives depuis plus de 7 jours sont masquées sauf `showOld`. */
export function groupSessions(sessions, { now = Date.now(), text = '', showOld = false } = {}) {
  const q = text.trim().toLowerCase();
  const groups = new Map();
  let hiddenOld = 0;
  for (const s of sessions || []) {
    if (q && !`${s.title} ${s.projectName || ''} ${s.cwd || ''} ${s.now || ''}`.toLowerCase().includes(q)) continue;
    const old = s.status !== 'running' && now - Date.parse(s.lastActivityAt || 0) > OLD_SESSION_MS;
    if (old && !showOld) {
      hiddenOld++;
      continue;
    }
    const key = s.projectKey || '';
    if (!groups.has(key)) groups.set(key, { key, name: s.projectName || 'Sans projet', sessions: [], running: 0, latest: '' });
    const g = groups.get(key);
    g.sessions.push(s);
    if (s.status === 'running') g.running++;
    if ((s.lastActivityAt || '') > g.latest) g.latest = s.lastActivityAt || '';
  }
  const list = [...groups.values()];
  for (const g of list) {
    g.sessions.sort((a, b) => (b.status === 'running') - (a.status === 'running') || ((a.lastActivityAt || '') < (b.lastActivityAt || '') ? 1 : -1));
  }
  list.sort((a, b) => b.running - a.running || (a.latest < b.latest ? 1 : -1));
  return { groups: list, hiddenOld };
}

/** Ce qui demande ton attention, du plus urgent au moins urgent. */
export function attentionItems(state, now = Date.now()) {
  const out = [];
  for (const t of state?.tasks || []) {
    const base = { project: t.projectName, target: { type: 'task', id: t.id }, ts: t.updatedAt };
    if (t.status === 'review') out.push({ ...base, kind: 'review', level: 'action', title: `${t.id} est à relire`, detail: t.title });
    else if (t.status === 'failed') out.push({ ...base, kind: 'failed', level: 'bad', title: `${t.id} a échoué`, detail: t.title });
    else if (t.status === 'blocked') out.push({ ...base, kind: 'blocked', level: 'warn', title: `${t.id} est bloquée`, detail: t.title });
  }
  const unread = state?.userUnread?.length || 0;
  if (unread) {
    const last = [...(state.messages || [])].reverse().find((m) => state.userUnread.includes(m.id));
    out.push({ kind: 'messages', level: 'action', title: `${unread} message${unread > 1 ? 's' : ''} non lu${unread > 1 ? 's' : ''}`, detail: last ? `${agentName(last.from, state)} : ${last.body}` : '', target: { view: 'messages' }, ts: last?.ts });
  }
  for (const a of state?.accounts || []) {
    if (a.limitedUntil && Date.parse(a.limitedUntil) > now) {
      out.push({ kind: 'quota', level: 'warn', title: `${agentName(a.id, state)} : quota atteint`, detail: `Reprise vers ${clockTime(a.limitedUntil)}`, target: { view: 'codex' }, ts: a.limitedUntil });
    }
  }
  for (const r of state?.runs || []) {
    const recent = now - Date.parse(r.endedAt || r.startedAt || 0) < 2 * DAY;
    if (r.status === 'completed' && r.tests && !r.tests.skipped && r.tests.cmd && !r.tests.passed && !r.cleaned && recent) {
      out.push({ kind: 'tests', level: 'warn', title: 'Tests en échec', detail: r.title, project: r.projectName, target: { type: 'run', id: r.id }, ts: r.endedAt });
    }
  }
  const rank = { bad: 0, action: 1, warn: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || ((a.ts || '') < (b.ts || '') ? 1 : -1));
}

/** Ce qui tourne maintenant : runs Codex et sessions Claude actives. */
export function runningNow(state) {
  const runs = (state?.runs || [])
    .filter((r) => r.status === 'running')
    .map((r) => ({ type: 'run', id: r.id, title: r.title, who: `codex:${r.account || '?'}`, since: r.startedAt, project: r.projectName }));
  const sessions = (state?.sessions || [])
    .filter((s) => s.status === 'running')
    .map((s) => ({ type: 'session', id: s.id, title: s.title, who: s.id, detail: s.now, since: s.lastActivityAt, project: s.projectName }));
  return [...runs, ...sessions];
}

/** Projets à montrer sur la vue d'ensemble : avec du travail ouvert, en cours, ou actifs récemment. */
export function projectsOverview(state, now = Date.now()) {
  const map = new Map();
  const get = (key, name, path) => {
    if (!map.has(key)) map.set(key, { key, name: name || 'Sans projet', path: path || null, open: 0, done: 0, total: 0, review: 0, running: 0, sessions: 0, latest: '' });
    return map.get(key);
  };
  const touch = (p, ts) => {
    if ((ts || '') > p.latest) p.latest = ts || '';
  };
  for (const t of state?.tasks || []) {
    const p = get(t.projectKey || '', t.projectName, t.project);
    p.total++;
    if (t.status === 'done') p.done++;
    else p.open++;
    if (t.status === 'review' || t.status === 'blocked' || t.status === 'failed') p.review++;
    touch(p, t.updatedAt);
  }
  for (const s of state?.sessions || []) {
    const p = get(s.projectKey || '', s.projectName);
    if (s.status === 'running') p.running++;
    if (s.status === 'running' || now - Date.parse(s.lastActivityAt || 0) < 3 * DAY) p.sessions++;
    touch(p, s.lastActivityAt);
  }
  for (const r of state?.runs || []) {
    const p = get(r.projectKey || '', r.projectName, r.repoRoot);
    if (r.status === 'running') p.running++;
    touch(p, r.endedAt || r.startedAt);
  }
  return [...map.values()]
    .filter((p) => p.open > 0 || p.running > 0 || now - Date.parse(p.latest || 0) < 3 * DAY)
    .map((p) => ({ ...p, progress: p.total ? p.done / p.total : 0 }))
    .sort((a, b) => b.review - a.review || b.running - a.running || b.open - a.open || (a.latest < b.latest ? 1 : -1));
}

/** Journal fusionné : messages, notes de tâches et runs, du plus récent au plus ancien. */
export function activityFeed(state, limit = 30, now = Date.now()) {
  const out = [];
  for (const m of state?.messages || []) {
    out.push({ ts: m.ts, kind: m.kind === 'event' ? 'event' : 'message', who: m.from, to: m.to, text: m.body, taskId: m.taskId || null });
  }
  for (const t of state?.tasks || []) {
    for (const n of t.notes || []) {
      if (n.by !== 'agent-hub') out.push({ ts: n.ts, kind: 'note', who: n.by, text: `${t.id} · ${n.text}`, taskId: t.id });
    }
  }
  for (const r of state?.runs || []) {
    if (now - Date.parse(r.startedAt || 0) > 7 * DAY) continue;
    const who = `codex:${r.account || '?'}`;
    out.push({ ts: r.startedAt, kind: 'run', who, text: `Run lancé : ${r.title}`, runId: r.id });
    if (r.endedAt) out.push({ ts: r.endedAt, kind: 'run', who, text: `Run ${(STATUS_LABEL[r.status] || r.status).toLowerCase()} : ${r.title}`, runId: r.id });
  }
  return out.filter((e) => e.ts).sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit);
}

/** Peut-on lancer cette tâche sur Codex ? Renvoie aussi l'état de chaque compte. */
export function canDispatch(task, state) {
  const accounts = (state?.accounts || []).map((a) => ({
    name: a.name,
    disabled: !!a.limitedUntil || a.loggedIn === false,
    reason: a.loggedIn === false ? 'non connecté' : a.limitedUntil ? `quota atteint jusqu'à ${clockTime(a.limitedUntil)}` : '',
  }));
  const fail = (reason) => ({ ok: false, reason, accounts });
  if (!task) return fail('Tâche introuvable.');
  if (!task.project) return fail("Cette tâche n'a pas de dossier de projet.");
  if (!['todo', 'claimed', 'blocked', 'failed'].includes(task.status)) return fail(`La tâche est « ${(STATUS_LABEL[task.status] || task.status).toLowerCase()} ».`);
  const pending = (task.deps || []).filter((d) => (state?.tasks || []).find((x) => x.id === d)?.status !== 'done');
  if (pending.length) return fail(`Attend ${pending.join(', ')}.`);
  const max = state?.limits?.maxParallelCodex ?? 3;
  const inFlight = (state?.tasks || []).filter((t) => t.status === 'running' && String(t.assignee || '').startsWith('codex:')).length;
  if (inFlight >= max) return fail(`${inFlight} runs Codex en cours (maximum ${max}).`);
  if (!accounts.length || accounts.every((a) => a.disabled)) return fail('Aucun compte ChatGPT disponible.');
  return { ok: true, reason: '', accounts };
}

/** Statuts vers lesquels une tâche peut être déplacée à la main. */
export function nextStatuses(status) {
  const map = {
    todo: ['blocked', 'done'], claimed: ['todo', 'blocked', 'done'], running: ['todo', 'blocked', 'done'],
    review: ['done', 'todo'], blocked: ['todo', 'done'], failed: ['todo', 'done'], done: ['todo'],
  };
  return map[status] || [];
}

/** Empreinte de l'état sans l'horloge : sert à éviter de reconstruire l'écran pour rien. */
export function stateSignature(state) {
  const { now, ...rest } = state || {};
  return JSON.stringify(rest);
}
