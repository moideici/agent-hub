import * as L from './lib.js';
import { icon } from './icons.js';

/* ───────────── Outils DOM (le texte passe toujours par textContent : jamais de données dans innerHTML) ───────────── */
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k.startsWith('aria-') || k === 'role' || k === 'for' || k === 'style') el.setAttribute(k, v);
    else el[k] = v;
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const store = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
const save = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage indisponible : l'écran marche quand même */
  }
};

/* ───────────── État de l'écran ───────────── */
const VIEWS = {
  overview: { label: "Vue d'ensemble", icon: 'overview' },
  tasks: { label: 'Tâches', icon: 'tasks' },
  sessions: { label: 'Sessions', icon: 'sessions' },
  codex: { label: 'ChatGPT', icon: 'codex' },
  messages: { label: 'Messages', icon: 'messages' },
};

const S = {
  state: null,
  view: 'overview',
  conn: 'wait',
  filters: { project: '', assignee: '', text: '', showDone: false, showOld: false },
  collapsed: store('ah.collapsed', {}),
  panel: null, // { type: 'task'|'session'|'run', id }
  drafts: {},
  seenUnread: new Set(),
  lastSig: '',
};

const state = () => S.state || { sessions: [], accounts: [], runs: [], tasks: [], projects: [], messages: [], userUnread: [], limits: {} };
const name = (id) => L.agentName(id, state());

/* ───────────── API ───────────── */
async function api(path, method = 'GET', body, raw = false) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* réponse texte (diff) */
  }
  if (!res.ok) throw new Error(data?.error || text || `Erreur HTTP ${res.status}`);
  return raw ? text : data;
}

let toastTimer;
function toast(message, bad = false) {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast${bad ? ' bad' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), bad ? 7000 : 3500);
}

async function act(fn, okMessage) {
  try {
    const r = await fn();
    if (okMessage) toast(okMessage);
    await refresh();
    return r;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

/* ───────────── Chargement en direct ───────────── */
let refreshTimer = null;
let inflight = false;
let again = false;

function scheduleRefresh(delay = 350) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, delay);
}

async function refresh() {
  if (inflight) {
    again = true;
    return;
  }
  inflight = true;
  try {
    S.state = await api('/api/state');
    setConn('ok');
    render();
  } catch (e) {
    setConn('down');
    if (!S.state) toast(e.message, true);
  } finally {
    inflight = false;
    if (again) {
      again = false;
      scheduleRefresh(0);
    }
  }
}

function setConn(c) {
  if (S.conn === c) return;
  S.conn = c;
  renderRail();
}

function connect() {
  if (!('EventSource' in window)) return;
  const es = new EventSource('/api/events');
  es.onopen = () => setConn('ok');
  es.onmessage = () => scheduleRefresh();
  es.onerror = () => setConn('down');
}

/* ───────────── Navigation ───────────── */
function go(view, filters = {}) {
  if (!VIEWS[view]) view = 'overview';
  S.view = view;
  Object.assign(S.filters, { text: '' }, filters);
  if (location.hash !== `#/${view}`) history.replaceState(null, '', `#/${view}`);
  S.lastSig = '';
  buildTopbar();
  render();
  $('#view').scrollTop = 0;
}

function viewFromHash() {
  const v = location.hash.replace(/^#\/?/, '').split('/')[0];
  return VIEWS[v] ? v : 'overview';
}

/* ───────────── Barre latérale ───────────── */
const themeNext = { auto: 'light', light: 'dark', dark: 'auto' };
const themeLabel = { auto: 'Thème : auto', light: 'Thème : clair', dark: 'Thème : sombre' };

function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = t;
}

function renderRail() {
  const st = state();
  const openTasks = st.tasks.filter(L.isOpen);
  const review = st.tasks.filter((t) => ['review', 'failed', 'blocked'].includes(t.status)).length;
  const live = st.sessions.filter((s) => s.status === 'running').length;
  const runs = st.runs.filter((r) => r.status === 'running').length;
  const unread = st.userUnread.length;
  const badges = {
    overview: L.attentionItems(st).length ? { n: L.attentionItems(st).length, cls: 'hot' } : null,
    tasks: openTasks.length ? { n: openTasks.length, cls: review ? 'hot' : '' } : null,
    sessions: live ? { n: live, cls: 'live' } : null,
    codex: runs ? { n: runs, cls: 'live' } : null,
    messages: unread ? { n: unread, cls: 'hot' } : null,
  };
  const connText = { ok: 'Connecté en direct', down: 'Connexion perdue', wait: 'Connexion…' }[S.conn];
  const theme = store('ah.theme', 'auto');
  const rail = $('#rail');
  rail.replaceChildren(
    h('div', { class: 'brand' },
      h('div', { class: 'brand-mark' }, icon('branch', 17)),
      h('div', {}, h('b', {}, 'agent-hub'), h('small', {}, 'Poste de coordination')),
    ),
    ...Object.entries(VIEWS).map(([id, v]) =>
      h('button', { class: 'nav-item', 'aria-current': S.view === id ? 'page' : null, on: { click: () => go(id) } },
        icon(v.icon, 19), h('span', { class: 'label' }, v.label),
        badges[id] ? h('span', { class: `badge ${badges[id].cls}` }, badges[id].n) : null),
    ),
    h('div', { class: 'rail-foot' },
      h('div', { class: 'conn' }, h('span', { class: `dot ${S.conn}` }), connText),
      h('button', { class: 'theme-btn', on: { click: () => { const n = themeNext[store('ah.theme', 'auto')]; save('ah.theme', n); applyTheme(n); renderRail(); } } }, themeLabel[theme]),
    ),
  );
}

/* ───────────── Barre du haut (construite une fois par vue : les champs gardent leur focus) ───────────── */
function buildTopbar() {
  const bar = $('#topbar');
  const subs = {
    overview: "Ce qui demande ton attention, ce qui tourne, où en sont les projets",
    tasks: 'Par projet, puis par état',
    sessions: 'Tes sessions Claude, par projet',
    codex: 'Comptes ChatGPT et runs Codex',
    messages: 'Échanges entre toi, tes sessions et ChatGPT',
  };
  const search = h('label', { class: 'search' }, icon('search', 16),
    h('input', { type: 'search', placeholder: 'Rechercher…', value: S.filters.text, 'aria-label': 'Rechercher', on: { input: (e) => { S.filters.text = e.target.value; renderView(true); } } }));
  bar.replaceChildren(...[
    h('div', {}, h('h1', {}, VIEWS[S.view].label), h('div', { class: 'sub' }, subs[S.view])),
    h('div', { class: 'spacer' }),
    ['tasks', 'sessions', 'messages'].includes(S.view) ? search : null,
    h('button', { class: 'btn primary', on: { click: openNewTask } }, icon('plus', 16), 'Nouvelle tâche'),
  ].filter(Boolean));
}

/* ───────────── Rendu ───────────── */
function render() {
  renderRail();
  renderView();
  renderPanel();
}

function renderView(force = false) {
  const st = state();
  const sig = `${S.view}|${JSON.stringify(S.filters)}|${JSON.stringify(S.collapsed)}|${[...S.seenUnread]}|${L.stateSignature(st)}|${Math.floor(Date.now() / 30000)}`;
  if (!force && sig === S.lastSig) return;
  S.lastSig = sig;
  const view = $('#view');
  const top = view.scrollTop;
  const builders = { overview: overviewView, tasks: tasksView, sessions: sessionsView, codex: codexView, messages: messagesView };
  view.replaceChildren(builders[S.view](st));
  view.scrollTop = top;
  if (S.view === 'messages') markMessagesRead();
}

const chip = (status, text) => h('span', { class: `chip s-${status}` }, text ?? L.STATUS_LABEL[status] ?? status);
const projectChip = (n) => (n ? h('span', { class: 'chip plain' }, icon('folder', 13), n) : null);

function avatar(id, small = false) {
  const kind = L.agentKind(id);
  const label = L.agentName(id, state());
  return h('span', { class: `avatar ${small ? 'sm' : ''} ${kind}`, style: kind === 'claude' ? `--h:${L.hueOf(id)}` : null, title: label }, kind === 'all' ? '*' : L.initials(kind === 'codex' ? label.replace('ChatGPT ', 'G') : label));
}

const empty = (text, left = false) => h('div', { class: `empty ${left ? 'left' : ''}` }, text);
const cardHead = (title, count) => h('div', { class: 'card-head' }, h('h2', {}, title), count != null ? h('span', { class: 'count' }, count) : null);

function openTarget(t) {
  if (!t) return;
  if (t.view) go(t.view);
  else openPanel(t.type, t.id);
}

/* ───── Vue d'ensemble ───── */
function overviewView(st) {
  const attention = L.attentionItems(st);
  const live = L.runningNow(st);
  const projects = L.projectsOverview(st);
  const feed = L.activityFeed(st, 14);

  const attentionRow = (a) =>
    h('button', { class: `row lvl-${a.level}`, on: { click: () => openTarget(a.target) } },
      h('span', { class: 'rowbar' }),
      h('span', { class: 'ico-c' }, icon(a.level === 'action' ? 'check' : 'alert', 18)),
      h('span', { class: 'grow' }, h('div', { class: 'title' }, a.title), h('div', { class: 'detail clip' }, a.detail)),
      projectChip(a.project),
      icon('chevron', 16));

  const liveRow = (x) =>
    h('button', { class: 'row', on: { click: () => openPanel(x.type, x.id) } },
      h('span', { class: 'dot live' }),
      h('span', { class: 'grow' },
        h('div', { class: 'title clip' }, x.title),
        h('div', { class: 'detail clip' }, x.type === 'run' ? `${name(x.who)} · depuis ${L.relativeTime(x.since).replace('il y a ', '')}` : x.detail || 'En cours')),
      projectChip(x.project));

  const projectRow = (p) =>
    h('button', { class: 'row', on: { click: () => go('tasks', { project: p.key || '__none' }) } },
      h('span', { class: 'grow' },
        h('div', { class: 'title' }, p.name),
        p.total ? h('div', { class: 'progress', style: 'margin-top:7px' }, h('i', { style: `width:${Math.round(p.progress * 100)}%` })) : null,
        h('div', { class: 'stat', style: 'margin-top:6px' },
          p.total ? `${p.done}/${p.total} terminées` : `${p.sessions} session${p.sessions > 1 ? 's' : ''} · ${L.relativeTime(p.latest)}`,
          p.review ? chip('review', `${p.review} à traiter`) : null,
          p.running ? h('span', { class: 'chip s-running' }, `${p.running} actif${p.running > 1 ? 's' : ''}`) : null)),
      icon('chevron', 16));

  const feedRow = (e) =>
    h('div', { class: 'row' },
      avatar(e.who, true),
      h('span', { class: 'grow' }, h('div', { class: 'clip' }, h('b', {}, name(e.who)), h('span', { class: 'muted' }, e.kind === 'message' && e.to ? ` → ${name(e.to)}` : ''), ' ', e.text.slice(0, 140))),
      h('span', { class: 'faint', style: 'font-size:12.5px;white-space:nowrap' }, L.relativeTime(e.ts)));

  return h('div', { class: 'grid-overview' },
    h('section', { class: 'card span-2' }, cardHead('À traiter', attention.length || null),
      h('div', { class: 'card-body' }, attention.length ? attention.map(attentionRow) : empty('Rien ne demande ton attention pour le moment.', true))),
    h('section', { class: 'card' }, cardHead('En cours maintenant', live.length || null),
      h('div', { class: 'card-body' }, live.length ? live.map(liveRow) : empty('Aucune session ni run actif.', true))),
    h('section', { class: 'card' }, cardHead('Projets', projects.length || null),
      h('div', { class: 'card-body' }, projects.length ? projects.map(projectRow) : empty('Aucun projet actif.', true))),
    h('section', { class: 'card span-2' }, cardHead('Activité récente'),
      h('div', { class: 'card-body' }, feed.length ? feed.map(feedRow) : empty('Rien pour le moment.', true))));
}

/* ───── Tâches ───── */
function taskCard(t) {
  const st = state();
  const run = t.runId ? st.runs.find((r) => r.id === t.runId) : null;
  return h('button', { class: 'tcard', on: { click: () => openPanel('task', t.id) } },
    h('div', { class: 'top' }, h('span', { class: 'mono' }, t.id),
      t.priority >= 2 ? h('span', { class: `chip prio-${t.priority}` }, L.PRIORITY_LABEL[t.priority]) : null,
      h('span', { style: 'margin-left:auto' }, L.relativeTime(t.updatedAt))),
    h('div', { class: 'ttl' }, t.title),
    h('div', { class: 'foot' },
      t.assignee ? h('span', { class: 'stat' }, avatar(t.assignee, true), h('span', { class: 'clip', style: 'max-width:120px' }, name(t.assignee))) : h('span', { class: 'faint' }, 'Non assignée'),
      t.deps?.length ? h('span', { class: 'chip plain' }, `après ${t.deps.join(', ')}`) : null,
      run ? chip(run.status, run.tests && !run.tests.skipped ? (run.tests.passed ? 'Tests OK' : 'Tests en échec') : null) : null));
}

function tasksView(st) {
  const f = S.filters;
  const projects = [...new Map(st.tasks.map((t) => [t.projectKey || '', t.projectName || 'Sans projet'])).entries()];
  const assignees = [...new Set(st.tasks.map((t) => t.assignee).filter(Boolean))];
  const groups = L.groupTasksByProject(st.tasks, f);

  const toolbar = h('div', { class: 'toolbar' },
    h('select', { class: 'input', 'aria-label': 'Projet', on: { change: (e) => { f.project = e.target.value; renderView(true); } } },
      h('option', { value: '' }, 'Tous les projets'), projects.map(([k, n]) => h('option', { value: k || '__none', selected: f.project === (k || '__none') }, n))),
    h('select', { class: 'input', 'aria-label': 'Assigné à', on: { change: (e) => { f.assignee = e.target.value; renderView(true); } } },
      h('option', { value: '' }, 'Tout le monde'), assignees.map((a) => h('option', { value: a, selected: f.assignee === a }, name(a)))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.showDone, on: { change: (e) => { f.showDone = e.target.checked; renderView(true); } } }), 'Afficher les terminées'));

  if (!groups.length) {
    return h('div', {}, toolbar, h('div', { class: 'card' }, empty(st.tasks.length ? 'Aucune tâche ne correspond aux filtres.' : "Aucune tâche pour l'instant. Crée-en une avec « Nouvelle tâche » ou depuis une session (ah task add).")));
  }

  const laneColor = { todo: 'todo', doing: 'running', review: 'review', blocked: 'failed', done: 'done' };
  const section = (g) => {
    const open = !S.collapsed[`task:${g.key}`];
    const lanes = L.LANES.filter((l) => l.id !== 'done');
    return h('section', { class: `card project ${open ? 'open' : ''}` },
      h('button', { class: 'project-head', 'aria-expanded': String(open), on: { click: () => { S.collapsed[`task:${g.key}`] = open; save('ah.collapsed', S.collapsed); renderView(true); } } },
        h('span', { class: 'chev' }, icon('chevron', 17)),
        h('div', { class: 'grow' }, h('h2', {}, g.name), g.path ? h('div', { class: 'faint mono clip', style: 'max-width:460px' }, g.path) : null),
        h('div', { class: 'meta' },
          g.counts.review ? chip('review', `${g.counts.review} à relire`) : null,
          g.counts.blocked ? chip('failed', `${g.counts.blocked} bloquée${g.counts.blocked > 1 ? 's' : ''}`) : null,
          h('span', { class: 'muted' }, `${g.counts.done}/${g.counts.total}`),
          h('div', { class: 'progress prog' }, h('i', { style: `width:${Math.round(g.progress * 100)}%` })))),
      open ? h('div', { class: 'lanes' }, lanes.map((l) =>
        h('div', { class: 'lane' },
          h('h3', {}, h('span', { class: `dot s-${laneColor[l.id]}` }), l.label, h('span', { class: 'n' }, g.counts[l.id])),
          g.lanes[l.id].length ? g.lanes[l.id].map(taskCard) : h('div', { class: 'none' }, '—')))) : null,
      open && f.showDone && g.lanes.done.length
        ? h('div', { class: 'done-line' }, h('div', { class: 'lane' }, h('h3', {}, h('span', { class: 'dot s-done' }), 'Terminées', h('span', { class: 'n' }, g.counts.done)), g.lanes.done.map(taskCard)))
        : open && g.counts.done ? h('div', { class: 'done-line muted' }, `${g.counts.done} terminée${g.counts.done > 1 ? 's' : ''} masquée${g.counts.done > 1 ? 's' : ''}.`) : null);
  };
  return h('div', {}, toolbar, groups.map(section));
}

/* ───── Sessions ───── */
function sessionsView(st) {
  const f = S.filters;
  const { groups, hiddenOld } = L.groupSessions(st.sessions, { text: f.text, showOld: f.showOld });
  const toolbar = h('div', { class: 'toolbar' },
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.showOld, on: { change: (e) => { f.showOld = e.target.checked; renderView(true); } } }),
      `Afficher les sessions anciennes (plus de 7 jours)${hiddenOld ? ` : ${hiddenOld} masquée${hiddenOld > 1 ? 's' : ''}` : ''}`));
  if (!groups.length) return h('div', {}, toolbar, h('div', { class: 'card' }, empty('Aucune session à afficher.')));
  return h('div', {}, toolbar, groups.map((g) =>
    h('section', { class: 'group' },
      h('div', { class: 'group-head' }, icon('folder', 16), h('h2', {}, g.name), h('span', { class: 'faint' }, `${g.sessions.length} session${g.sessions.length > 1 ? 's' : ''}`), g.running ? h('span', { class: 'chip s-running' }, `${g.running} active${g.running > 1 ? 's' : ''}`) : null),
      h('div', { class: 'card' }, g.sessions.map((s) =>
        h('button', { class: 'session', on: { click: () => openPanel('session', s.id) } },
          h('span', { class: `dot ${s.status === 'running' ? 'live' : ''}` }),
          h('span', { class: 'grow' }, h('div', { class: 'title clip' }, s.title),
            s.note?.note ? h('div', { class: 'now clip' }, `Statut : ${s.note.note}`) : s.now ? h('div', { class: 'now clip' }, s.now) : null),
          h('span', { class: 'when' }, s.status === 'running' ? 'En cours' : L.relativeTime(s.lastActivityAt))))))));
}

/* ───── ChatGPT / Codex ───── */
function codexView(st) {
  const accounts = h('div', { class: 'accounts' }, st.accounts.map((a) => {
    const limited = a.limitedUntil && Date.parse(a.limitedUntil) > Date.now();
    return h('div', { class: 'card account' },
      h('div', { class: 'name' }, avatar(a.id), `Compte ${a.name}`, a.isDefault ? h('span', { class: 'chip plain' }, 'par défaut') : null),
      h('div', { class: 'stat' },
        a.loggedIn ? chip('done', 'Connecté') : chip('failed', 'Non connecté'),
        limited ? chip('limited', `Quota atteint · reprise vers ${L.clockTime(a.limitedUntil)}`) : a.loggedIn ? h('span', {}, 'Quota disponible') : null),
      h('div', { class: 'stat' }, a.running ? h('span', { class: 'chip s-running' }, `${a.running} run${a.running > 1 ? 's' : ''} en cours`) : h('span', {}, 'Aucun run en cours')),
      a.note?.note ? h('div', { class: 'muted' }, a.note.note) : null);
  }));
  const byProject = new Map();
  for (const r of st.runs.slice(0, 30)) {
    const k = r.projectKey || '';
    if (!byProject.has(k)) byProject.set(k, { name: r.projectName || 'Sans projet', runs: [] });
    byProject.get(k).runs.push(r);
  }
  const runRow = (r) =>
    h('button', { class: 'run', on: { click: () => openPanel('run', r.id) } },
      chip(r.status),
      h('span', { class: 'grow' }, h('div', { class: 'title clip' }, r.title),
        h('div', { class: 'stat' }, `Compte ${r.account || '?'}`, r.durationSec != null ? L.formatDuration(r.durationSec) : null,
          r.changes ? `${r.changes.files} fichier${r.changes.files > 1 ? 's' : ''} +${r.changes.added}/−${r.changes.deleted}` : null,
          r.tests && !r.tests.skipped ? chip(r.tests.passed ? 'done' : 'failed', r.tests.passed ? 'Tests OK' : 'Tests en échec') : null)),
      h('span', { class: 'faint', style: 'font-size:12.5px;white-space:nowrap' }, L.relativeTime(r.startedAt)));
  return h('div', {}, accounts,
    byProject.size ? [...byProject.values()].map((g) =>
      h('section', { class: 'group' }, h('div', { class: 'group-head' }, icon('folder', 16), h('h2', {}, g.name), h('span', { class: 'faint' }, `${g.runs.length} run${g.runs.length > 1 ? 's' : ''}`)),
        h('div', { class: 'card' }, g.runs.map(runRow)))) : h('div', { class: 'card' }, empty('Aucun run Codex pour le moment.')));
}

/* ───── Messages ───── */
function messagesView(st) {
  const q = S.filters.text.trim().toLowerCase();
  const msgs = st.messages.filter((m) => !q || `${m.body} ${name(m.from)} ${name(m.to)} ${m.taskId || ''}`.toLowerCase().includes(q));
  const row = (m) =>
    h('div', { class: `msg ${m.kind === 'event' ? 'event' : ''} ${st.userUnread.includes(m.id) || S.seenUnread.has(m.id) ? 'unread' : ''}` },
      avatar(m.from),
      h('div', {}, h('div', { class: 'who' }, h('b', {}, name(m.from)), h('span', { class: 'muted' }, `→ ${name(m.to)}`),
        m.taskId ? h('button', { class: 'chip plain', on: { click: () => openPanel('task', m.taskId) } }, m.taskId) : null,
        h('span', { class: 'faint', style: 'font-size:12.5px' }, L.relativeTime(m.ts))),
        h('div', { class: 'body' }, m.body)));

  const to = h('select', { class: 'input', 'aria-label': 'Destinataire', style: 'width:210px' },
    [['*', 'Tout le monde'], ['codex:a', 'ChatGPT a'], ['codex:b', 'ChatGPT b'], ...st.sessions.filter((s) => s.status === 'running' || Date.now() - Date.parse(s.lastActivityAt || 0) < 7 * 864e5).map((s) => [s.id, s.title])]
      .map(([v, t]) => h('option', { value: v }, t)));
  const text = h('textarea', { class: 'input', rows: 1, placeholder: 'Écrire un message… (Entrée pour envoyer, Maj+Entrée pour un retour à la ligne)', 'aria-label': 'Message', value: S.drafts.msg || '' });
  text.addEventListener('input', () => (S.drafts.msg = text.value));
  const send = async () => {
    const body = text.value.trim();
    if (!body) return;
    const ok = await act(() => api('/api/messages', 'POST', { to: to.value, body }));
    if (ok) {
      S.drafts.msg = '';
      text.value = '';
    }
  };
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  return h('div', {},
    h('div', { class: 'card' }, h('div', { class: 'thread' }, msgs.length ? msgs.map(row) : empty('Aucun message.'))),
    h('div', { class: 'composer' }, to, text, h('button', { class: 'btn primary', on: { click: send } }, icon('send', 16), 'Envoyer')));
}

let markTimer;
function markMessagesRead() {
  const ids = state().userUnread;
  if (!ids.length) return;
  ids.forEach((i) => S.seenUnread.add(i));
  clearTimeout(markTimer);
  markTimer = setTimeout(() => api('/api/messages/read', 'POST', {}).then(() => scheduleRefresh(0)).catch(() => {}), 1500);
}

/* ───────────── Volet de détail ───────────── */
function openPanel(type, id) {
  S.panel = { type, id };
  S.panelSig = '';
  renderPanel();
}

function closePanel() {
  S.panel = null;
  renderPanel();
}

function draft(key, el) {
  el.value = S.drafts[key] || '';
  el.addEventListener('input', () => (S.drafts[key] = el.value));
  return el;
}

const kv = (rows) => h('dl', { class: 'kv' }, rows.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
const section = (title, ...kids) => h('section', {}, h('h3', {}, title), ...kids);
const copyBtn = (text, label) => h('button', { class: 'btn sm', on: { click: () => navigator.clipboard?.writeText(text).then(() => toast('Copié'), () => toast(text)) } }, icon('copy', 14), label);

let panelRequest = 0;
async function renderPanel() {
  const panel = $('#panel');
  const scrim = $('#scrim');
  if (!S.panel) {
    panel.hidden = scrim.hidden = true;
    return;
  }
  const { type, id } = S.panel;
  const st = state();
  const item = type === 'task' ? st.tasks.find((t) => t.id === id) : type === 'session' ? st.sessions.find((s) => s.id === id) : st.runs.find((r) => r.id === id);
  if (!item) {
    panel.hidden = scrim.hidden = true;
    S.panel = null;
    return;
  }
  const sig = `${type}:${id}:${JSON.stringify(item)}:${type === 'task' ? JSON.stringify(st.accounts) + JSON.stringify(st.tasks.map((t) => [t.id, t.status])) : ''}`;
  if (sig === S.panelSig && !panel.hidden) return;
  S.panelSig = sig;
  const req = ++panelRequest;
  let extra = null;
  try {
    if (type === 'session') extra = await api(`/api/sessions/${encodeURIComponent(id)}/tail?n=60`);
    if (type === 'run') extra = await api(`/api/runs/${encodeURIComponent(id)}`);
  } catch (e) {
    extra = { error: e.message };
  }
  if (req !== panelRequest || !S.panel) return;
  const builders = { task: taskPanel, session: sessionPanel, run: runPanel };
  const { title, subtitle, body } = builders[type](item, extra);
  panel.replaceChildren(
    h('div', { class: 'panel-head' },
      h('div', { class: 'grow', style: 'flex:1;min-width:0' }, h('h2', {}, title), subtitle ? h('div', { class: 'muted', style: 'margin-top:4px' }, subtitle) : null),
      h('button', { class: 'btn ghost sm', 'aria-label': 'Fermer', on: { click: closePanel } }, icon('close', 18))),
    h('div', { class: 'panel-body' }, body));
  panel.hidden = scrim.hidden = false;
}

function taskPanel(t) {
  const st = state();
  const run = t.runId ? st.runs.find((r) => r.id === t.runId) : null;
  const can = L.canDispatch(t, st);
  let account = can.accounts.find((a) => !a.disabled)?.name || '';
  const confirmBox = h('div', { hidden: true });
  const accountPick = h('div', { class: 'actions' }, can.accounts.map((a) =>
    h('label', { class: 'check', title: a.reason || '' }, h('input', { type: 'radio', name: 'acct', value: a.name, disabled: a.disabled, checked: a.name === account, on: { change: () => (account = a.name) } }),
      `Compte ${a.name}${a.reason ? ` (${a.reason})` : ''}`)));
  const launch = h('button', { class: 'btn primary', disabled: !can.ok, on: { click: () => {
    confirmBox.hidden = false;
    confirmBox.replaceChildren(h('div', { class: 'confirm' },
      h('div', {}, `Lancer « ${t.title} » sur ChatGPT (compte ${account}) ? Cela consomme du quota ChatGPT.`),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary sm', on: { click: () => act(() => api(`/api/tasks/${encodeURIComponent(t.id)}/dispatch`, 'POST', { account }), `${t.id} lancée sur ChatGPT ${account}`) } }, 'Oui, lancer'),
        h('button', { class: 'btn sm', on: { click: () => (confirmBox.hidden = true) } }, 'Annuler'))));
  } } }, icon('play', 15), 'Lancer sur ChatGPT');

  const note = draft(`note:${t.id}`, h('textarea', { class: 'input', rows: 2, placeholder: 'Ajouter une note…', 'aria-label': 'Note' }));
  const assignee = h('select', { class: 'input', 'aria-label': 'Assigner à', on: { change: (e) => act(() => api(`/api/tasks/${encodeURIComponent(t.id)}`, 'PATCH', { assignee: e.target.value || null })) } },
    h('option', { value: '' }, 'Non assignée'),
    [{ id: 'codex:a' }, { id: 'codex:b' }, ...st.sessions.filter((s) => s.status === 'running' || s.id === t.assignee)].map((a) => h('option', { value: a.id, selected: a.id === t.assignee }, name(a.id))));

  return {
    title: t.title,
    subtitle: h('span', { class: 'stat' }, h('span', { class: 'mono' }, t.id), chip(t.status), projectChip(t.projectName)),
    body: [
      t.brief ? section('Détail', h('div', { class: 'pre' }, t.brief)) : null,
      section('Informations', kv([
        ['Assignée à', t.assignee ? h('span', { class: 'stat' }, avatar(t.assignee, true), name(t.assignee)) : 'Personne'],
        ['Priorité', L.PRIORITY_LABEL[t.priority]],
        t.deps?.length ? ['Dépend de', t.deps.join(', ')] : null,
        t.project ? ['Dossier', h('span', { class: 'mono' }, t.project)] : null,
        ['Créée par', name(t.createdBy)],
        ['Mise à jour', L.relativeTime(t.updatedAt)],
        run ? ['Run', h('button', { class: 'chip plain', on: { click: () => openPanel('run', run.id) } }, `${run.id.slice(0, 24)} · ${L.STATUS_LABEL[run.status] || run.status}`)] : null,
      ])),
      section('Actions',
        h('div', { class: 'actions' }, L.nextStatuses(t.status).map((s) =>
          h('button', { class: `btn sm ${s === 'done' ? 'primary' : ''}`, on: { click: () => act(() => api(`/api/tasks/${encodeURIComponent(t.id)}`, 'PATCH', { status: s }), `${t.id} : ${(L.STATUS_LABEL[s] || s).toLowerCase()}`) } },
            { done: 'Marquer terminée', todo: t.status === 'done' ? 'Rouvrir' : 'Remettre à faire', blocked: 'Marquer bloquée' }[s] || s))),
        h('div', { style: 'margin-top:12px' }, h('label', { class: 'field' }, h('span', {}, 'Assigner à'), assignee))),
      section('Confier à ChatGPT', accountPick, h('div', { class: 'actions', style: 'margin-top:10px' }, launch, can.ok ? null : h('span', { class: 'muted' }, can.reason)), confirmBox),
      section('Notes', t.notes?.length ? h('div', { class: 'notes' }, [...t.notes].reverse().map((n) => h('div', { class: 'note' }, h('small', {}, `${name(n.by)} · ${L.relativeTime(n.ts)}`), n.text))) : empty('Aucune note.', true),
        h('div', { style: 'margin-top:10px;display:grid;gap:8px' }, note,
          h('div', { class: 'actions' }, h('button', { class: 'btn sm', on: { click: async () => { const v = note.value.trim(); if (!v) return; if (await act(() => api(`/api/tasks/${encodeURIComponent(t.id)}`, 'PATCH', { note: v }))) S.drafts[`note:${t.id}`] = ''; } } }, 'Ajouter la note')))),
    ],
  };
}

function sessionPanel(s, extra) {
  const entries = extra?.entries || [];
  const msg = draft(`to:${s.id}`, h('textarea', { class: 'input', rows: 3, placeholder: 'Écrire à cette session…', 'aria-label': 'Message pour la session' }));
  return {
    title: s.title,
    subtitle: h('span', { class: 'stat' }, h('span', { class: `dot ${s.status === 'running' ? 'live' : ''}` }), s.status === 'running' ? 'En cours' : `Inactive · ${L.relativeTime(s.lastActivityAt)}`, projectChip(s.projectName)),
    body: [
      section('Informations', kv([['Dossier', h('span', { class: 'mono' }, s.cwd || '—')], ['Modèle', s.model || '—'], ['Tours', s.completedTurns ?? '—'], s.note?.note ? ['Statut annoncé', s.note.note] : null,
        s.link ? ['Lien', h('span', { class: 'actions' }, h('span', { class: 'mono clip', style: 'max-width:300px' }, s.link), copyBtn(s.link, 'Copier'))] : null])),
      section('Écrire à cette session',
        h('div', { style: 'display:grid;gap:8px' }, msg,
          h('div', { class: 'actions' }, h('button', { class: 'btn primary sm', on: { click: async () => { const v = msg.value.trim(); if (!v) return; if (await act(() => api('/api/messages', 'POST', { to: s.id, body: v }), 'Message envoyé : la session le lira à son prochain tour')) { S.drafts[`to:${s.id}`] = ''; msg.value = ''; } } } }, icon('send', 14), 'Envoyer'),
            h('span', { class: 'faint' }, 'Lu à son prochain tour (hook) ou tout de suite si elle écoute (ah watch).')))),
      section('Fil récent', extra?.error ? empty(extra.error, true) : entries.length ? h('div', { class: 'tail' }, entries.map((e) =>
        h('div', { class: `e ${e.role}` }, h('small', {}, `${{ user: 'Toi', assistant: 'Claude', tool: `Outil · ${e.name}` }[e.role]} · ${L.relativeTime(e.ts)}`), e.text))) : empty('Pas de fil disponible.', true)),
    ],
  };
}

function runPanel(r, extra) {
  const full = extra && !extra.error ? extra : null;
  const diffBox = h('div', { hidden: true });
  const diffBtn = h('button', { class: 'btn sm', on: { click: async () => {
    diffBtn.disabled = true;
    try {
      const text = await api(`/api/runs/${encodeURIComponent(r.id)}/diff`, 'GET', undefined, true);
      diffBox.hidden = false;
      diffBox.replaceChildren(h('div', { class: 'pre diff mono' }, text.split('\n').map((l) => h('div', { class: l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : '' }, l || ' '))));
    } catch (e) {
      toast(e.message, true);
    }
    diffBtn.disabled = false;
  } } }, 'Voir le diff');
  return {
    title: r.title,
    subtitle: h('span', { class: 'stat' }, chip(r.status), `Compte ${r.account || '?'}`, projectChip(r.projectName)),
    body: [
      section('Informations', kv([
        ['Démarré', L.relativeTime(r.startedAt)], r.durationSec != null ? ['Durée', L.formatDuration(r.durationSec)] : null,
        r.changes ? ['Changements', `${r.changes.files} fichier(s), +${r.changes.added} / −${r.changes.deleted}`] : null,
        r.tests?.cmd ? ['Tests', `${r.tests.cmd} → ${r.tests.skipped ? 'non lancés' : r.tests.passed ? 'OK' : `ÉCHEC (code ${r.tests.exit})`}`] : null,
        r.branch ? ['Branche', h('span', { class: 'mono' }, r.branch)] : null, r.taskId ? ['Tâche', h('button', { class: 'chip plain', on: { click: () => openPanel('task', r.taskId) } }, r.taskId)] : null])),
      r.status === 'completed' && !r.cleaned ? section('Suite', h('div', { class: 'actions' }, copyBtn(`ah merge ${r.id}`, 'Copier la commande de fusion'), copyBtn(`ah show ${r.id} --patch`, 'Copier : voir le diff'))) : null,
      full?.errors?.length ? section('Erreurs', h('div', { class: 'pre' }, full.errors.join('\n'))) : null,
      full?.tests?.tail ? section('Sortie des tests', h('div', { class: 'pre mono' }, full.tests.tail)) : null,
      section('Résumé de l’agent', h('div', { class: 'pre' }, full?.lastMessage || r.summary || 'Pas de résumé.')),
      r.changes?.files ? section('Diff', h('div', {}, diffBtn), diffBox) : null,
    ],
  };
}

/* ───────────── Nouvelle tâche ───────────── */
function openNewTask() {
  const st = state();
  const dlg = $('#newtask');
  const title = h('input', { class: 'input', required: true, placeholder: 'Ex. Ajouter le jeu du morpion', 'aria-label': 'Titre' });
  const brief = h('textarea', { class: 'input', rows: 4, placeholder: 'Objectif, contexte, critères de réussite…', 'aria-label': 'Détail' });
  const known = st.projects.filter((p) => !/\\temp\\|\/tmp\//i.test(p.path));
  const preselect = S.filters.project && S.filters.project !== '__none' && known.find((p) => p.key === S.filters.project)?.path;
  const project = h('select', { class: 'input', 'aria-label': 'Projet' }, h('option', { value: '' }, 'Aucun projet'), known.map((p) => h('option', { value: p.path, selected: p.path === preselect }, `${p.name}`)));
  const assignee = h('select', { class: 'input', 'aria-label': 'Assigner à' }, h('option', { value: '' }, 'Personne pour l’instant'),
    ['codex:a', 'codex:b'].map((a) => h('option', { value: a }, name(a))), st.sessions.filter((s) => s.status === 'running').map((s) => h('option', { value: s.id }, s.title)));
  const prio = h('select', { class: 'input', 'aria-label': 'Priorité' }, L.PRIORITY_LABEL.map((l, i) => h('option', { value: i, selected: i === 1 }, l)));
  const open = st.tasks.filter(L.isOpen);
  const depBoxes = open.map((t) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: t.id }), h('span', { class: 'clip' }, `${t.id} · ${t.title}`)));
  const form = h('form', { method: 'dialog', on: { submit: async (e) => {
    e.preventDefault();
    const deps = depBoxes.map((l) => l.firstChild).filter((c) => c.checked).map((c) => c.value);
    const ok = await act(() => api('/api/tasks', 'POST', { title: title.value, brief: brief.value, project: project.value || null, assignee: assignee.value || null, priority: +prio.value, deps }), 'Tâche créée');
    if (ok) dlg.close();
  } } },
    h('h2', {}, 'Nouvelle tâche'),
    h('label', { class: 'field' }, h('span', {}, 'Titre'), title),
    h('label', { class: 'field' }, h('span', {}, 'Détail'), brief),
    h('div', { class: 'split' }, h('label', { class: 'field' }, h('span', {}, 'Projet'), project), h('label', { class: 'field' }, h('span', {}, 'Priorité'), prio)),
    h('label', { class: 'field' }, h('span', {}, 'Assigner à'), assignee),
    open.length ? h('div', { class: 'field' }, h('span', {}, 'Dépend de'), h('div', { class: 'deps' }, depBoxes)) : null,
    h('div', { class: 'actions', style: 'justify-content:flex-end' }, h('button', { type: 'button', class: 'btn', on: { click: () => dlg.close() } }, 'Annuler'), h('button', { type: 'submit', class: 'btn primary' }, 'Créer la tâche')));
  dlg.replaceChildren(form);
  dlg.showModal();
  title.focus();
}

/* ───────────── Démarrage ───────────── */
applyTheme(store('ah.theme', 'auto'));
$('#scrim').addEventListener('click', closePanel);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.panel && !$('#newtask').open) closePanel();
});
window.addEventListener('hashchange', () => {
  const v = viewFromHash();
  if (v !== S.view) go(v);
});
setInterval(() => {
  if (!document.hidden) scheduleRefresh(0);
}, 8000);

S.view = viewFromHash();
buildTopbar();
renderRail();
$('#view').replaceChildren(h('div', { class: 'card' }, empty('Chargement…')));
refresh();
connect();
