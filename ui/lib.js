// Fonctions pures du dashboard (aucun accès au DOM) : regroupements, tri, vocabulaire. Testées dans test/ui-lib.test.mjs.

/** États d'une tâche, du plus urgent au moins urgent : c'est l'ordre d'affichage dans chaque projet. */
export const LANES = [
  { id: 'ask', label: 'Attend ta réponse', hint: 'ChatGPT a posé une question', statuses: ['waiting'] },
  { id: 'review', label: 'À valider', hint: 'Le travail est terminé : à toi de le relire', statuses: ['review'] },
  { id: 'blocked', label: 'À débloquer', hint: 'Bloquée ou en échec', statuses: ['blocked', 'failed'] },
  { id: 'doing', label: 'En cours', hint: 'Quelqu’un travaille dessus', statuses: ['claimed', 'running'] },
  { id: 'queued', label: 'En file d’attente', hint: 'Part toute seule dès qu’une place se libère', statuses: ['queued'] },
  { id: 'todo', label: 'À faire', hint: 'Pas encore commencée', statuses: ['todo'] },
  { id: 'done', label: 'Terminées', hint: '', statuses: ['done'] },
];

export const STATUS_LABEL = {
  todo: 'À faire', queued: 'En file', claimed: 'Prise', running: 'En cours', waiting: 'Attend ta réponse', review: 'À valider',
  done: 'Terminée', blocked: 'Bloquée', failed: 'Échec',
  completed: 'Terminé', idle: 'Inactive', stale: 'Interrompu', limited: 'Quota atteint', timeout: 'Délai dépassé', 'needs-input': 'Question posée',
};

export const PRIORITY_LABEL = ['Basse', 'Normale', 'Haute', 'Urgente'];
export const OLD_SESSION_MS = 7 * 86_400_000;
const OPEN_STATUSES = new Set(['todo', 'queued', 'claimed', 'running', 'waiting', 'review', 'blocked', 'failed']);
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
  if (id.startsWith('claude:')) return state?.sessions?.find((s) => s.id === id)?.title || 'Conversation Claude';
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
const emptyCounts = () => ({ ...Object.fromEntries(LANES.map((l) => [l.id, 0])), open: 0, total: 0 });
const sortLane = (id, arr) =>
  arr.sort((a, b) =>
    id === 'todo' || id === 'doing' || id === 'queued'
      ? b.priority - a.priority || (a.createdAt < b.createdAt ? -1 : 1)
      : a.updatedAt < b.updatedAt ? 1 : -1,
  );

/**
 * Tâches regroupées par projet, puis par état (du plus urgent au moins urgent).
 * Les compteurs portent sur toutes les tâches filtrées ; `showDone` ne contrôle que l'affichage des terminées.
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
      groups.set(key, { key, name: t.projectName || 'Sans projet', path: t.project || null, lanes: lanesObject(), counts: emptyCounts(), latest: '' });
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
    return { ...g, progress: g.counts.total ? g.counts.done / g.counts.total : 0, attention: g.counts.ask + g.counts.review + g.counts.blocked };
  });
  return out.sort(
    (a, b) => (b.counts.open > 0) - (a.counts.open > 0) || b.attention - a.attention || (a.latest < b.latest ? 1 : -1) || a.name.localeCompare(b.name),
  );
}

/** Conversations Claude regroupées par projet ; les inactives depuis plus de 7 jours sont masquées sauf `showOld`. */
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

/** Ce qui demande ta décision, du plus urgent au moins urgent. `action` = libellé du bouton principal. */
export function attentionItems(state, now = Date.now()) {
  const out = [];
  for (const t of state?.tasks || []) {
    const base = { project: t.projectName, target: { type: 'task', id: t.id }, ts: t.updatedAt };
    if (t.status === 'waiting') {
      out.push({ ...base, kind: 'waiting', level: 'bad', title: `${agentName(t.assignee, state)} te pose une question`, detail: t.title, action: 'Répondre' });
    } else if (t.status === 'failed') {
      out.push({ ...base, kind: 'failed', level: 'bad', title: 'Une tâche a échoué', detail: t.title, action: 'Voir pourquoi' });
    } else if (t.status === 'review') {
      out.push({ ...base, kind: 'review', level: 'action', title: 'Un travail est terminé : à valider', detail: t.title, action: 'Relire et valider' });
    } else if (t.status === 'blocked') {
      out.push({ ...base, kind: 'blocked', level: 'warn', title: 'Une tâche est bloquée', detail: t.title, action: 'Voir' });
    }
  }
  const unread = state?.userUnread?.length || 0;
  if (unread) {
    const last = [...(state.messages || [])].reverse().find((m) => state.userUnread.includes(m.id));
    out.push({ kind: 'messages', level: 'action', title: `${unread} message${unread > 1 ? 's' : ''} non lu${unread > 1 ? 's' : ''}`, detail: last ? `${agentName(last.from, state)} : ${last.body}` : '', target: { view: 'messages' }, ts: last?.ts, action: 'Lire' });
  }
  for (const a of state?.accounts || []) {
    if (a.limitedUntil && Date.parse(a.limitedUntil) > now) {
      out.push({ kind: 'quota', level: 'warn', title: `${agentName(a.id, state)} a atteint son quota`, detail: `Il reprendra vers ${clockTime(a.limitedUntil)}`, target: { view: 'codex' }, ts: a.limitedUntil, action: 'Voir' });
    }
  }
  for (const p of state?.presence || []) {
    if (p.conflict) {
      out.push({ kind: 'conflict', level: 'warn', title: `${p.agents.length} agents travaillent en même temps sur « ${p.projectName} »`, detail: p.agents.map((a) => a.label).join(', '), project: p.projectName, target: { view: 'sessions' }, ts: new Date(now).toISOString(), action: 'Voir' });
    }
  }
  for (const r of state?.runs || []) {
    const recent = now - Date.parse(r.endedAt || r.startedAt || 0) < 2 * DAY;
    if (r.status === 'completed' && r.tests && !r.tests.skipped && r.tests.cmd && !r.tests.passed && !r.cleaned && recent) {
      out.push({ kind: 'tests', level: 'warn', title: 'Des tests échouent sur un travail terminé', detail: r.title, project: r.projectName, target: { type: 'run', id: r.id }, ts: r.endedAt, action: 'Voir' });
    }
  }
  const rank = { bad: 0, action: 1, warn: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || ((a.ts || '') < (b.ts || '') ? 1 : -1));
}

/** Texte « ce qui se passe » d'un run en cours, tiré de sa progression. */
export function runLiveText(run) {
  const p = run?.progress;
  if (!p) return 'Démarrage…';
  if (p.phase && p.phase !== 'codex') return p.phase === 'tests' ? 'Vérification des tests…' : p.phase.startsWith('correction') ? `Correction automatique (${p.phase.replace('correction ', '')})…` : p.phase;
  if (p.lastCommand) return `Exécute : ${p.lastCommand}`;
  if (p.lastMessage) return p.lastMessage;
  return 'Réfléchit…';
}

/** Ce qui tourne maintenant : travaux ChatGPT et conversations Claude actives. */
export function runningNow(state) {
  const runs = (state?.runs || [])
    .filter((r) => r.status === 'running')
    .map((r) => ({ type: 'run', id: r.id, title: r.title, who: `codex:${r.account || '?'}`, detail: runLiveText(r), since: r.startedAt, project: r.projectName, files: r.progress?.files?.length || 0 }));
  const sessions = (state?.sessions || [])
    .filter((s) => s.status === 'running')
    .map((s) => ({ type: 'session', id: s.id, title: s.title, who: s.id, detail: s.now, since: s.lastActivityAt, project: s.projectName }));
  return [...runs, ...sessions];
}

/** Projets à montrer sur l'accueil : avec du travail ouvert, en cours, ou actifs récemment. */
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
    if (['waiting', 'review', 'blocked', 'failed'].includes(t.status)) p.review++;
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

/** Phrase d'accueil : combien de décisions t'attendent, et ce qui tourne. */
export function homeSummary(state, now = Date.now()) {
  const decisions = attentionItems(state, now).filter((a) => a.level !== 'warn' || a.kind === 'conflict').length;
  const live = runningNow(state);
  const runs = live.filter((x) => x.type === 'run').length;
  const sess = live.filter((x) => x.type === 'session').length;
  const parts = [];
  if (sess) parts.push(`${sess} conversation${sess > 1 ? 's' : ''} Claude active${sess > 1 ? 's' : ''}`);
  if (runs) parts.push(`${runs} travail${runs > 1 ? 'x' : ''} ChatGPT en cours`);
  return {
    decisions,
    headline: decisions ? `${decisions} chose${decisions > 1 ? 's attendent' : ' attend'} ta décision` : 'Rien n’attend ta décision',
    sub: parts.length ? parts.join(' · ') : 'Aucun agent ne travaille pour le moment.',
    calm: decisions === 0,
  };
}

/** Journal fusionné : messages, notes de tâches et runs, du plus récent au plus ancien. */
export function activityFeed(state, limit = 30, now = Date.now()) {
  const out = [];
  for (const m of state?.messages || []) {
    out.push({ ts: m.ts, kind: m.kind === 'event' ? 'event' : m.kind === 'ask' ? 'ask' : 'message', who: m.from, to: m.to, text: m.body, taskId: m.taskId || null });
  }
  for (const t of state?.tasks || []) {
    for (const n of t.notes || []) {
      if (n.by !== 'agent-hub') out.push({ ts: n.ts, kind: 'note', who: n.by, text: `${t.id} · ${n.text}`, taskId: t.id });
    }
  }
  for (const r of state?.runs || []) {
    if (now - Date.parse(r.startedAt || 0) > 7 * DAY) continue;
    const who = `codex:${r.account || '?'}`;
    out.push({ ts: r.startedAt, kind: 'run', who, text: `Travail lancé : ${r.title}`, runId: r.id });
    if (r.endedAt) out.push({ ts: r.endedAt, kind: 'run', who, text: `Travail ${(STATUS_LABEL[r.status] || r.status).toLowerCase()} : ${r.title}`, runId: r.id });
  }
  return out.filter((e) => e.ts).sort((a, b) => (a.ts < b.ts ? 1 : -1)).slice(0, limit);
}

/** Phrase qui explique, en français simple, où en est une tâche et ce qu'on attend de toi. */
export function taskStateText(task, state) {
  const who = agentName(task?.assignee, state);
  switch (task?.status) {
    case 'waiting': return `${who} a posé une question et attend ta réponse pour continuer.`;
    case 'review': return 'Le travail est terminé. À toi de relire le résultat et de le valider.';
    case 'failed': return 'Cette tâche a échoué. Regarde les notes pour comprendre pourquoi, puis relance-la.';
    case 'blocked': return 'Cette tâche est bloquée. Débloque-la ou remets-la à faire.';
    case 'running': return task.assignee ? `${who} travaille dessus en ce moment.` : 'Quelqu’un travaille dessus en ce moment.';
    case 'claimed': return `${who} a pris cette tâche.`;
    case 'queued': return 'Elle est en file d’attente : elle partira toute seule dès qu’une place se libère.';
    case 'done': return 'Cette tâche est terminée.';
    default: return 'Pas encore commencée.';
  }
}

/** Bouton principal d'une tâche dans une liste. */
export function taskPrimaryAction(task) {
  switch (task?.status) {
    case 'waiting': return { id: 'answer', label: 'Répondre', primary: true };
    case 'review': return { id: 'validate', label: 'Valider', primary: true };
    case 'failed':
    case 'blocked': return { id: 'open', label: 'Voir', primary: false };
    case 'todo': return task.project ? { id: 'open', label: 'Lancer…', primary: false } : null;
    default: return null;
  }
}

/** Peut-on lancer cette tâche sur ChatGPT ? Renvoie aussi l'état de chaque compte. */
export function canDispatch(task, state) {
  const accounts = (state?.accounts || []).map((a) => ({
    name: a.name,
    disabled: !!a.limitedUntil || a.loggedIn === false,
    reason: a.loggedIn === false ? 'non connecté' : a.limitedUntil ? `quota atteint jusqu'à ${clockTime(a.limitedUntil)}` : '',
  }));
  const fail = (reason) => ({ ok: false, reason, accounts });
  if (!task) return fail('Tâche introuvable.');
  if (!task.project) return fail("Cette tâche n'a pas de dossier de projet.");
  if (!['todo', 'queued', 'claimed', 'blocked', 'failed'].includes(task.status)) return fail(`La tâche est « ${(STATUS_LABEL[task.status] || task.status).toLowerCase()} ».`);
  const pending = (task.deps || []).filter((d) => (state?.tasks || []).find((x) => x.id === d)?.status !== 'done');
  if (pending.length) return fail(`Attend ${pending.join(', ')}.`);
  const max = state?.limits?.maxParallelCodex ?? 3;
  const inFlight = (state?.tasks || []).filter((t) => t.status === 'running' && String(t.assignee || '').startsWith('codex:')).length;
  if (inFlight >= max) return fail(`${inFlight} travaux ChatGPT en cours (maximum ${max}).`);
  if (!accounts.length || accounts.every((a) => a.disabled)) return fail('Aucun compte ChatGPT disponible.');
  return { ok: true, reason: '', accounts };
}

/** Peut-on mettre cette tâche en file d'attente (elle attendra une place libre) ? */
export function canQueue(task) {
  if (!task) return { ok: false, reason: 'Tâche introuvable.' };
  if (!task.project) return { ok: false, reason: "Cette tâche n'a pas de dossier de projet." };
  if (!['todo', 'blocked', 'failed', 'claimed'].includes(task.status)) return { ok: false, reason: '' };
  return { ok: true, reason: '' };
}

/** Statuts vers lesquels une tâche peut être déplacée à la main. */
export function nextStatuses(status) {
  const map = {
    todo: ['blocked', 'done'], queued: ['todo', 'done'], claimed: ['todo', 'blocked', 'done'], running: ['todo', 'blocked', 'done'],
    waiting: ['todo', 'blocked', 'done'], review: ['done', 'todo'], blocked: ['todo', 'done'], failed: ['todo', 'done'], done: ['todo'],
  };
  return map[status] || [];
}

/** Empreinte de l'état sans l'horloge : sert à éviter de reconstruire l'écran pour rien. */
export function stateSignature(state) {
  const { now, ...rest } = state || {};
  return JSON.stringify(rest);
}
