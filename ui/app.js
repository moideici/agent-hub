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
  overview: { label: 'Accueil', icon: 'overview', sub: 'Ce qui demande ta décision, ce qui avance, où en sont tes projets' },
  tasks: { label: 'Tâches', icon: 'tasks', sub: 'Tout le travail à faire, rangé par projet puis par état' },
  sessions: { label: 'Conversations', icon: 'sessions', sub: 'Tes conversations avec Claude, par projet' },
  codex: { label: 'ChatGPT', icon: 'codex', sub: 'Ton deuxième ouvrier : ses comptes et ses travaux' },
  messages: { label: 'Messages', icon: 'messages', sub: 'Les échanges entre toi, Claude et ChatGPT' },
};

const S = {
  state: null,
  view: 'overview',
  conn: 'wait',
  filters: { project: '', text: '', showDone: false, showOld: false },
  collapsed: store('ah.collapsed', {}),
  helpHidden: store('ah.helpHidden', false),
  panel: null, // { type: 'task'|'session'|'run', id }
  drafts: {},
  seenUnread: new Set(),
  fullTasks: {}, // détail complet des tâches (le résultat est tronqué dans l'état)
  lastSig: '',
  panelSig: '',
};

const state = () => S.state || { sessions: [], accounts: [], runs: [], tasks: [], projects: [], messages: [], userUnread: [], presence: [], locks: [], limits: {} };
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
    return r ?? true;
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
  const decisions = L.homeSummary(st).decisions;
  const open = st.tasks.filter(L.isOpen).length;
  const urgent = st.tasks.filter((t) => ['waiting', 'review', 'failed', 'blocked'].includes(t.status)).length;
  const live = st.sessions.filter((s) => s.status === 'running').length;
  const runs = st.runs.filter((r) => r.status === 'running').length;
  const unread = st.userUnread.length;
  const badges = {
    overview: decisions ? { n: decisions, cls: 'hot' } : null,
    tasks: open ? { n: open, cls: urgent ? 'hot' : '' } : null,
    sessions: live ? { n: live, cls: 'live' } : null,
    codex: runs ? { n: runs, cls: 'live' } : null,
    messages: unread ? { n: unread, cls: 'hot' } : null,
  };
  const connText = { ok: 'Connecté en direct', down: 'Connexion perdue', wait: 'Connexion…' }[S.conn];
  const theme = store('ah.theme', 'auto');
  $('#rail').replaceChildren(
    h('div', { class: 'brand' },
      h('div', { class: 'brand-mark' }, icon('spark', 18)),
      h('div', {}, h('b', {}, 'agent-hub'), h('small', {}, 'Poste de coordination'))),
    ...Object.entries(VIEWS).map(([id, v]) =>
      h('button', { class: 'nav-item', 'aria-current': S.view === id ? 'page' : null, on: { click: () => go(id) } },
        icon(v.icon, 20), h('span', { class: 'label' }, v.label),
        badges[id] ? h('span', { class: `badge ${badges[id].cls}` }, badges[id].n) : null)),
    h('div', { class: 'rail-foot' },
      h('div', { class: 'conn' }, h('span', { class: `dot ${S.conn}` }), connText),
      h('button', { class: 'theme-btn', on: { click: () => { S.helpHidden = false; save('ah.helpHidden', false); go('overview'); setTimeout(() => $('#help-card')?.scrollIntoView({ behavior: 'smooth' }), 50); } } }, 'Comment ça marche ?'),
      h('button', { class: 'theme-btn', on: { click: () => { const n = themeNext[store('ah.theme', 'auto')]; save('ah.theme', n); applyTheme(n); renderRail(); } } }, themeLabel[theme])),
  );
}

/* ───────────── Barre du haut (construite une fois par vue : les champs gardent leur focus) ───────────── */
function buildTopbar() {
  const search = h('label', { class: 'search' }, icon('search', 17),
    h('input', { type: 'search', placeholder: 'Rechercher…', value: S.filters.text, 'aria-label': 'Rechercher', on: { input: (e) => { S.filters.text = e.target.value; renderView(true); } } }));
  $('#topbar').replaceChildren(...[
    h('div', {}, h('h1', {}, VIEWS[S.view].label), h('div', { class: 'sub' }, VIEWS[S.view].sub)),
    h('div', { class: 'spacer' }),
    ['tasks', 'sessions', 'messages'].includes(S.view) ? search : null,
    h('button', { class: 'btn primary', on: { click: openNewTask } }, icon('plus', 17), 'Nouvelle tâche'),
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
  const sig = `${S.view}|${JSON.stringify(S.filters)}|${JSON.stringify(S.collapsed)}|${S.helpHidden}|${[...S.seenUnread]}|${L.stateSignature(st)}|${Math.floor(Date.now() / 30000)}`;
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
const projectChip = (n) => (n ? h('span', { class: 'chip plain' }, icon('folder', 14), n) : null);
const empty = (title, text, action) => h('div', { class: 'empty' }, h('b', {}, title), text ? h('div', {}, text) : null, action || null);
const sectionTitle = (title, count, text) => h('div', { class: 'section-title' }, h('h2', {}, title), count != null && count !== '' ? h('span', { class: 'count' }, count) : null, text ? h('p', {}, text) : null);

function avatar(id, small = false) {
  const kind = L.agentKind(id);
  const label = L.agentName(id, state());
  return h('span', { class: `avatar ${small ? 'sm' : ''} ${kind}`, style: kind === 'claude' ? `--h:${L.hueOf(id)}` : null, title: label },
    kind === 'all' ? '*' : L.initials(kind === 'codex' ? label.replace('ChatGPT ', 'G') : label));
}

function openTarget(t) {
  if (!t) return;
  if (t.view) go(t.view);
  else openPanel(t.type, t.id);
}

const laneIcon = { ask: 'help', review: 'check', blocked: 'alert', doing: 'bolt', queued: 'clock', todo: 'circle', done: 'check' };
const laneClass = { ask: 's-waiting', review: 's-review', blocked: 's-failed', doing: 's-running', queued: 's-queued', todo: 's-todo', done: 's-done' };
const kindIcon = { waiting: 'help', review: 'check', failed: 'alert', blocked: 'alert', messages: 'messages', quota: 'clock', conflict: 'alert', tests: 'alert' };

/* ───── Accueil ───── */
function overviewView(st) {
  const sum = L.homeSummary(st);
  const attention = L.attentionItems(st);
  const live = L.runningNow(st);
  const projects = L.projectsOverview(st);
  const feed = L.activityFeed(st, 12);

  const decisionRow = (a) =>
    h('div', { class: `decision lvl-${a.kind === 'waiting' ? 'ask' : a.level}` },
      h('span', { class: 'glyph' }, icon(kindIcon[a.kind] || 'alert', 22)),
      h('div', { class: 'what' }, h('b', {}, a.title), h('span', { class: 'clip' }, a.detail), a.project ? h('div', { style: 'margin-top:6px' }, projectChip(a.project)) : null),
      h('button', { class: `btn sm ${a.level === 'bad' || a.level === 'action' ? 'primary' : ''}`, on: { click: () => openTarget(a.target) } }, a.action));

  const liveRow = (x) =>
    h('button', { class: 'row', on: { click: () => openPanel(x.type, x.id) } },
      avatar(x.who),
      h('span', { class: 'grow' }, h('div', { class: 'title clip' }, x.title),
        h('div', { class: x.type === 'run' ? 'live-line' : 'detail clip' }, x.type === 'run' ? [h('span', { class: 'dot live' }), h('span', { class: 'clip' }, x.detail)] : x.detail || 'En cours')),
      projectChip(x.project));

  const projectRow = (p) =>
    h('button', { class: 'row', on: { click: () => go('tasks', { project: p.key || '__none' }) } },
      h('span', { class: 'grow' },
        h('div', { class: 'title' }, p.name),
        p.total ? h('div', { class: 'progress', style: 'margin-top:8px' }, h('i', { style: `width:${Math.round(p.progress * 100)}%` })) : null,
        h('div', { class: 'stat', style: 'margin-top:7px' },
          p.total ? `${p.done} terminée${p.done > 1 ? 's' : ''} sur ${p.total}` : `${p.sessions} conversation${p.sessions > 1 ? 's' : ''} · ${L.relativeTime(p.latest)}`,
          p.review ? chip('review', `${p.review} à traiter`) : null,
          p.running ? h('span', { class: 'chip s-running' }, `${p.running} actif${p.running > 1 ? 's' : ''}`) : null)),
      icon('chevron', 17));

  const feedRow = (e) =>
    h('div', { class: 'row' },
      avatar(e.who, true),
      h('span', { class: 'grow' }, h('div', { class: 'clip' }, h('b', {}, name(e.who)), h('span', { class: 'muted' }, e.kind === 'message' && e.to ? ` → ${name(e.to)}` : ''), ' ', e.text.slice(0, 150))),
      h('span', { class: 'faint', style: 'font-size:13px;white-space:nowrap' }, L.relativeTime(e.ts)));

  const helpItems = [
    ['tasks', 'Une tâche', 'Un travail à faire. Tu les ranges par projet, puis tu les confies à Claude ou à ChatGPT.'],
    ['sessions', 'Une conversation Claude', 'Une fenêtre de travail avec Claude. Elle peut prendre des tâches et en créer.'],
    ['codex', 'ChatGPT', 'Un deuxième ouvrier. Tu lui confies une tâche : il travaille à part, puis tu valides son résultat.'],
    ['check', 'À valider / Attend ta réponse', 'Ce sont les seules choses qui te demandent quelque chose. Tout le reste avance tout seul.'],
  ];
  const help = h('section', { class: 'card help', id: 'help-card' },
    h('div', { class: 'actions', style: 'justify-content:space-between' }, h('h2', {}, 'Comment ça marche ?'), h('button', { class: 'btn ghost sm', on: { click: () => { S.helpHidden = true; save('ah.helpHidden', true); renderView(true); } } }, 'Masquer')),
    h('div', { class: 'items' }, helpItems.map(([ic, t, d]) => h('div', { class: 'it' }, h('span', { class: 'glyph' }, icon(ic, 18)), h('div', {}, h('b', {}, t), h('span', {}, d))))));

  return h('div', {},
    h('section', { class: `card hero ${sum.calm ? 'calm' : 'busy'}` },
      h('span', { class: 'glyph' }, icon(sum.calm ? 'check' : 'bolt', 28)),
      h('div', {}, h('h2', {}, sum.headline), h('p', {}, sum.sub))),
    attention.length ? h('div', { class: 'card', style: 'margin-top:14px' }, attention.map(decisionRow)) : null,
    h('div', { class: 'cols' },
      h('div', {}, sectionTitle('En ce moment', live.length || null),
        h('div', { class: 'card' }, live.length ? live.map(liveRow) : empty('Personne ne travaille pour le moment', 'Confie une tâche à ChatGPT depuis l’onglet Tâches pour le voir ici en direct.'))),
      h('div', {}, sectionTitle('Projets', projects.length || null),
        h('div', { class: 'card' }, projects.length ? projects.map(projectRow) : empty('Aucun projet actif')))),
    sectionTitle('Activité récente'),
    h('div', { class: 'card' }, feed.length ? feed.map(feedRow) : empty('Rien pour le moment')),
    S.helpHidden ? null : h('div', { style: 'margin-top:26px' }, help));
}

/* ───── Tâches (par projet, puis par état) ───── */
function taskRow(t) {
  const st = state();
  const run = t.runId ? st.runs.find((r) => r.id === t.runId) : null;
  const lane = L.laneOf(t.status);
  const action = L.taskPrimaryAction(t);
  const live = t.status === 'running' && run?.status === 'running' ? L.runLiveText(run) : null;
  return h('div', { class: 'task' },
    h('button', { class: 'task-open', on: { click: () => openPanel('task', t.id) } },
      h('div', { class: 'ttl' }, t.title),
      h('div', { class: 'sub' },
        h('span', { class: 'id mono' }, t.id),
        t.priority >= 2 ? h('span', { class: `chip prio-${t.priority}` }, L.PRIORITY_LABEL[t.priority]) : null,
        t.assignee ? h('span', { class: 'stat' }, avatar(t.assignee, true), name(t.assignee)) : h('span', { class: 'faint' }, 'Non assignée'),
        h('span', {}, L.relativeTime(t.updatedAt)),
        t.deps?.length ? h('span', { class: 'chip plain' }, `après ${t.deps.join(', ')}`) : null,
        t.sandbox === 'read-only' ? h('span', { class: 'chip plain' }, 'audit') : null),
      live ? h('div', { class: 'live-line', style: 'margin-top:6px' }, h('span', { class: 'dot live' }), h('span', { class: 'clip' }, live)) : null),
    action ? h('button', { class: `btn sm ${action.primary ? (action.id === 'validate' ? 'good' : 'primary') : ''}`, on: { click: (e) => {
      e.stopPropagation();
      if (action.id === 'validate') act(() => api(`/api/tasks/${encodeURIComponent(t.id)}`, 'PATCH', { status: 'done', note: 'Validée' }), `${t.id} terminée`);
      else openPanel('task', t.id);
    } } }, action.label) : null,
    h('span', { class: 'chevron-hint faint' }, icon('chevron', 17)));
}

function tasksView(st) {
  const f = S.filters;
  const projects = [...new Map(st.tasks.map((t) => [t.projectKey || '', t.projectName || 'Sans projet'])).entries()];
  const groups = L.groupTasksByProject(st.tasks, f);
  const doneTotal = st.tasks.filter((t) => t.status === 'done').length;

  const toolbar = h('div', { class: 'toolbar' },
    h('select', { class: 'input', 'aria-label': 'Projet', on: { change: (e) => { f.project = e.target.value; renderView(true); } } },
      h('option', { value: '' }, 'Tous les projets'), projects.map(([k, n]) => h('option', { value: k || '__none', selected: f.project === (k || '__none') }, n))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.showDone, on: { change: (e) => { f.showDone = e.target.checked; renderView(true); } } }), 'Afficher les terminées'),
    h('span', { class: 'grow' }),
    doneTotal ? h('button', { class: 'btn sm', on: { click: () => act(() => api('/api/tasks/archive-done', 'POST', {}), 'Tâches terminées archivées') } }, icon('archive', 15), `Archiver les terminées (${doneTotal})`) : null,
    st.archivedCount ? h('span', { class: 'faint' }, `${st.archivedCount} archivée${st.archivedCount > 1 ? 's' : ''}`) : null);

  if (!groups.length) {
    return h('div', {}, toolbar, h('div', { class: 'card' }, st.tasks.length
      ? empty('Aucune tâche ne correspond', 'Change le projet ou la recherche.')
      : empty('Aucune tâche pour l’instant', 'Une tâche, c’est un travail à faire. Crée-la ici, ou laisse Claude la créer pour toi.', h('button', { class: 'btn primary', on: { click: openNewTask } }, icon('plus', 16), 'Créer la première tâche'))));
  }

  const conflictKeys = new Set((st.presence || []).filter((p) => p.conflict).map((p) => p.projectKey));
  const section = (g) => {
    const open = !S.collapsed[`task:${g.key}`];
    const lanes = L.LANES.filter((l) => (l.id !== 'done' || f.showDone) && g.lanes[l.id].length);
    return h('section', { class: `card project ${open ? 'open' : ''}` },
      h('button', { class: 'project-head', 'aria-expanded': String(open), on: { click: () => { S.collapsed[`task:${g.key}`] = open; save('ah.collapsed', S.collapsed); renderView(true); } } },
        h('span', { class: 'chev' }, icon('chevron', 18)),
        h('div', { style: 'min-width:0' }, h('h2', {}, g.name), g.path ? h('div', { class: 'faint mono clip', style: 'max-width:420px' }, g.path) : null),
        h('div', { class: 'meta' },
          conflictKeys.has(g.key) ? chip('review', 'Plusieurs agents ici') : null,
          g.counts.ask ? chip('waiting', `${g.counts.ask} question${g.counts.ask > 1 ? 's' : ''}`) : null,
          g.counts.review ? chip('review', `${g.counts.review} à valider`) : null,
          g.counts.blocked ? chip('failed', `${g.counts.blocked} à débloquer`) : null,
          h('span', { class: 'muted' }, `${g.counts.done}/${g.counts.total}`),
          h('div', { class: 'progress prog' }, h('i', { style: `width:${Math.round(g.progress * 100)}%` })))),
      open ? lanes.map((l) =>
        h('div', { class: 'lane' },
          h('div', { class: 'lane-head' }, h('span', { class: `glyph ${laneClass[l.id]}` }, icon(laneIcon[l.id], 17)), h('h3', {}, l.label), h('span', { class: 'n' }, g.counts[l.id]), l.hint ? h('span', { class: 'hint' }, `· ${l.hint}`) : null),
          g.lanes[l.id].map(taskRow))) : null,
      open && !f.showDone && g.counts.done ? h('div', { class: 'done-note' }, `${g.counts.done} terminée${g.counts.done > 1 ? 's' : ''} masquée${g.counts.done > 1 ? 's' : ''} : coche « Afficher les terminées » pour les voir.`) : null,
      open && !lanes.length && !g.counts.done ? h('div', { class: 'empty' }, 'Aucune tâche ici.') : null);
  };
  return h('div', {}, toolbar, groups.map(section));
}

/* ───── Conversations Claude ───── */
function sessionsView(st) {
  const f = S.filters;
  const { groups, hiddenOld } = L.groupSessions(st.sessions, { text: f.text, showOld: f.showOld });
  const conflictKeys = new Set((st.presence || []).filter((p) => p.conflict).map((p) => p.projectKey));
  const toolbar = h('div', {},
    h('p', { class: 'intro' }, 'Chaque ligne est une conversation avec Claude, rangée par projet. « En cours » veut dire que Claude est en train d’agir. Clique sur une ligne pour voir ce qu’elle a fait, ou lui écrire.'),
    h('div', { class: 'toolbar' }, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.showOld, on: { change: (e) => { f.showOld = e.target.checked; renderView(true); } } }),
      `Afficher les conversations anciennes (plus de 7 jours)${hiddenOld ? ` · ${hiddenOld} masquée${hiddenOld > 1 ? 's' : ''}` : ''}`)));
  if (!groups.length) return h('div', {}, toolbar, h('div', { class: 'card' }, empty('Aucune conversation à afficher')));
  return h('div', {}, toolbar, groups.map((g) =>
    h('section', { class: 'group' },
      h('div', { class: 'group-head' }, icon('folder', 17), h('h2', {}, g.name), h('span', { class: 'faint' }, `${g.sessions.length} conversation${g.sessions.length > 1 ? 's' : ''}`),
        g.running ? h('span', { class: 'chip s-running' }, `${g.running} en cours`) : null, conflictKeys.has(g.key) ? chip('review', 'Plusieurs agents sur ce projet') : null),
      h('div', { class: 'card' }, g.sessions.map((s) =>
        h('button', { class: 'session', on: { click: () => openPanel('session', s.id) } },
          h('span', { class: `dot ${s.status === 'running' ? 'live' : ''}` }),
          h('span', { class: 'grow' }, h('div', { class: 'title clip', style: 'font-weight:600' }, s.title),
            s.note?.note ? h('div', { class: 'now clip' }, `Annonce : ${s.note.note}`) : s.now ? h('div', { class: 'now clip' }, s.now) : null),
          h('span', { class: 'when' }, s.status === 'running' ? 'En cours' : L.relativeTime(s.lastActivityAt))))))));
}

/* ───── ChatGPT ───── */
function codexView(st) {
  const accounts = h('div', { class: 'accounts' }, st.accounts.map((a) => {
    const limited = a.limitedUntil && Date.parse(a.limitedUntil) > Date.now();
    return h('div', { class: 'card account' },
      h('div', { class: 'name' }, avatar(a.id), `Compte ${a.name}`, a.isDefault ? h('span', { class: 'chip plain' }, 'par défaut') : null),
      h('div', { class: 'stat' },
        !a.loggedIn ? chip('failed', 'Non connecté') : limited ? chip('limited', `Quota atteint · reprise vers ${L.clockTime(a.limitedUntil)}`) : chip('done', 'Disponible')),
      h('div', { class: 'stat' }, a.running ? h('span', { class: 'chip s-running' }, `${a.running} travail${a.running > 1 ? 'x' : ''} en cours`) : 'Aucun travail en cours'),
      a.note?.note ? h('div', { class: 'muted' }, a.note.note) : null);
  }));
  const byProject = new Map();
  for (const r of st.runs.slice(0, 30)) {
    const k = r.projectKey || '';
    if (!byProject.has(k)) byProject.set(k, { name: r.projectName || 'Sans projet', runs: [] });
    byProject.get(k).runs.push(r);
  }
  const runRow = (r) =>
    h('button', { class: 'run row', on: { click: () => openPanel('run', r.id) } },
      chip(r.status === 'needs-input' ? 'waiting' : r.status),
      h('span', { class: 'grow' }, h('div', { class: 'title clip' }, r.title),
        r.status === 'running' ? h('div', { class: 'live-line' }, h('span', { class: 'dot live' }), h('span', { class: 'clip' }, L.runLiveText(r)))
          : h('div', { class: 'stat' }, `Compte ${r.account || '?'}`, r.durationSec != null ? L.formatDuration(r.durationSec) : null,
            r.readOnly ? 'audit en lecture seule' : r.changes ? `${r.changes.files} fichier${r.changes.files > 1 ? 's' : ''} modifié${r.changes.files > 1 ? 's' : ''}` : null,
            r.fixes ? `${r.fixes} correction${r.fixes > 1 ? 's' : ''} auto` : null,
            r.tests && !r.tests.skipped ? chip(r.tests.passed ? 'done' : 'failed', r.tests.passed ? 'Tests OK' : 'Tests en échec') : null)),
      h('span', { class: 'faint', style: 'font-size:13px;white-space:nowrap' }, L.relativeTime(r.startedAt)));
  return h('div', {},
    h('p', { class: 'intro' }, 'ChatGPT est ton deuxième ouvrier. Dans une tâche, clique sur « Lancer sur ChatGPT » : il travaille à part, dans une copie du projet, puis te rend son résultat à valider. Ses comptes ont un quota : s’il est atteint, la tâche patiente en file d’attente.'),
    accounts,
    sectionTitle('Travaux récents'),
    byProject.size ? [...byProject.values()].map((g) =>
      h('section', { class: 'group' }, h('div', { class: 'group-head' }, icon('folder', 17), h('h2', {}, g.name), h('span', { class: 'faint' }, `${g.runs.length} travail${g.runs.length > 1 ? 'x' : ''}`)),
        h('div', { class: 'card' }, g.runs.map(runRow)))) : h('div', { class: 'card' }, empty('Aucun travail pour le moment')));
}

/* ───── Messages ───── */
function messagesView(st) {
  const q = S.filters.text.trim().toLowerCase();
  const msgs = st.messages.filter((m) => !q || `${m.body} ${name(m.from)} ${name(m.to)} ${m.taskId || ''}`.toLowerCase().includes(q));
  const row = (m) =>
    h('div', { class: `msg ${m.kind === 'event' ? 'event' : ''} ${m.kind === 'ask' ? 'ask' : ''} ${st.userUnread.includes(m.id) || S.seenUnread.has(m.id) ? 'unread' : ''}` },
      avatar(m.from),
      h('div', {}, h('div', { class: 'who' }, h('b', {}, name(m.from)), h('span', { class: 'muted' }, `→ ${name(m.to)}`),
        m.taskId ? h('button', { class: 'chip plain', on: { click: () => openPanel('task', m.taskId) } }, m.taskId) : null,
        h('span', { class: 'faint', style: 'font-size:13px' }, L.relativeTime(m.ts))),
        h('div', { class: 'body' }, m.body)));

  const to = h('select', { class: 'input', 'aria-label': 'Destinataire', style: 'width:220px' },
    [['*', 'Tout le monde'], ['codex:a', 'ChatGPT a'], ['codex:b', 'ChatGPT b'], ...st.sessions.filter((s) => s.status === 'running' || Date.now() - Date.parse(s.lastActivityAt || 0) < 7 * 864e5).map((s) => [s.id, s.title])]
      .map(([v, t]) => h('option', { value: v }, t)));
  const text = h('textarea', { class: 'input', rows: 1, placeholder: 'Écrire un message… (Entrée pour envoyer, Maj+Entrée pour un retour à la ligne)', 'aria-label': 'Message', value: S.drafts.msg || '' });
  text.addEventListener('input', () => (S.drafts.msg = text.value));
  const send = async () => {
    const body = text.value.trim();
    if (!body) return;
    if (await act(() => api('/api/messages', 'POST', { to: to.value, body }))) {
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
    h('p', { class: 'intro' }, 'Les messages sont le canal de discussion : toi, tes conversations Claude et ChatGPT s’y écrivent. Une conversation Claude lit ton message à son prochain tour.'),
    h('div', { class: 'card' }, h('div', { class: 'thread' }, msgs.length ? msgs.map(row) : empty('Aucun message'))),
    h('div', { class: 'composer' }, to, text, h('button', { class: 'btn primary', on: { click: send } }, icon('send', 17), 'Envoyer')));
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
const copyBtn = (text, label) => h('button', { class: 'btn sm', on: { click: () => navigator.clipboard?.writeText(text).then(() => toast('Copié'), () => toast(text)) } }, icon('copy', 15), label);

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
    // une tâche archivée ou supprimée n'est plus dans l'état : on ferme le volet
    panel.hidden = scrim.hidden = true;
    S.panel = null;
    return;
  }
  const sig = `${type}:${id}:${JSON.stringify(item)}:${type === 'task' ? JSON.stringify(st.accounts) + JSON.stringify(st.tasks.map((t) => [t.id, t.status])) + JSON.stringify(st.runs.filter((r) => r.id === item.runId)) : ''}`;
  if (sig === S.panelSig && !panel.hidden) return;
  S.panelSig = sig;
  const req = ++panelRequest;
  let extra = null;
  try {
    if (type === 'session') extra = await api(`/api/sessions/${encodeURIComponent(id)}/tail?n=60`);
    if (type === 'run') extra = await api(`/api/runs/${encodeURIComponent(id)}`);
    if (type === 'task' && item.result) extra = await api(`/api/tasks/${encodeURIComponent(id)}`);
  } catch (e) {
    extra = { error: e.message };
  }
  if (req !== panelRequest || !S.panel) return;
  const builders = { task: taskPanel, session: sessionPanel, run: runPanel };
  const { title, subtitle, body } = builders[type](item, extra);
  panel.replaceChildren(
    h('div', { class: 'panel-head' },
      h('div', { style: 'flex:1;min-width:0' }, h('h2', {}, title), subtitle ? h('div', { class: 'muted', style: 'margin-top:6px' }, subtitle) : null),
      h('button', { class: 'btn ghost sm', 'aria-label': 'Fermer', on: { click: closePanel } }, icon('close', 19))),
    h('div', { class: 'panel-body' }, body));
  panel.hidden = scrim.hidden = false;
}

function taskPanel(t, full) {
  const st = state();
  const lane = L.laneOf(t.status);
  const run = t.runId ? st.runs.find((r) => r.id === t.runId) : null;
  const dispatch = L.canDispatch(t, st);
  const queue = L.canQueue(t);
  const result = full?.result || t.result;
  const setStatus = (s, ok) => act(() => api(`/api/tasks/${encodeURIComponent(t.id)}`, 'PATCH', { status: s, note: ok }), ok);

  const stateBox = h('div', { class: `state-box ${laneClass[lane]}` },
    h('span', { class: 'glyph' }, icon(laneIcon[lane], 22)),
    h('div', {}, h('b', {}, L.STATUS_LABEL[t.status] || t.status), h('span', {}, L.taskStateText(t, st))));

  // — Question de ChatGPT : la réponse est la première chose à faire
  const answerBox = (() => {
    if (t.status !== 'waiting') return null;
    const q = run?.question || [...(t.notes || [])].reverse().find((n) => n.text.startsWith('Question de Codex'))?.text.replace(/^Question de Codex :\s*/, '') || 'ChatGPT attend une précision.';
    const input = draft(`answer:${t.id}`, h('textarea', { class: 'input', rows: 3, placeholder: 'Ta réponse…', 'aria-label': 'Ta réponse' }));
    return section('La question', h('div', { class: 'pre' }, q),
      h('div', { style: 'margin-top:12px;display:grid;gap:10px' }, input,
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', on: { click: async () => {
          const v = input.value.trim();
          if (!v) return toast('Écris ta réponse d’abord', true);
          if (await act(() => api(`/api/tasks/${encodeURIComponent(t.id)}/answer`, 'POST', { answer: v }), 'Réponse envoyée : ChatGPT reprend le travail')) S.drafts[`answer:${t.id}`] = '';
        } } }, icon('send', 16), 'Envoyer la réponse'))));
  })();

  // — Travail en cours
  const liveBox = run?.status === 'running'
    ? section('En ce moment', h('div', { class: 'live-card' },
      h('div', { class: 'live-line' }, h('span', { class: 'dot live' }), h('b', {}, L.runLiveText(run))),
      run.progress?.files?.length ? h('div', { class: 'muted' }, `${run.progress.files.length} fichier${run.progress.files.length > 1 ? 's' : ''} touché${run.progress.files.length > 1 ? 's' : ''} : ${run.progress.files.slice(0, 4).join(', ')}${run.progress.files.length > 4 ? '…' : ''}`) : null,
      h('button', { class: 'btn sm', style: 'justify-self:start', on: { click: () => openPanel('run', run.id) } }, 'Voir le travail')))
    : null;

  // — Résultat
  const resultBox = result?.text
    ? section(t.status === 'waiting' ? 'Ce que ChatGPT a écrit' : 'Résultat', h('div', { class: 'pre' }, result.text), result.data ? h('details', { style: 'margin-top:10px' }, h('summary', { class: 'muted' }, 'Données structurées'), h('div', { class: 'pre mono', style: 'margin-top:8px' }, JSON.stringify(result.data, null, 2))) : null)
    : null;

  // — Actions
  const confirmBox = h('div', { hidden: true });
  let account = dispatch.accounts.find((a) => !a.disabled)?.name || '';
  const accountPick = h('div', { class: 'actions' }, dispatch.accounts.map((a) =>
    h('label', { class: 'check', title: a.reason || '' }, h('input', { type: 'radio', name: 'acct', value: a.name, disabled: a.disabled, checked: a.name === account, on: { change: () => (account = a.name) } }),
      `Compte ${a.name}${a.reason ? ` (${a.reason})` : ''}`)));
  const launch = () => {
    confirmBox.hidden = false;
    confirmBox.replaceChildren(h('div', { class: 'confirm' },
      h('div', {}, `Lancer « ${t.title} » sur ChatGPT (compte ${account}) maintenant ? Cela consomme du quota ChatGPT.`),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary sm', on: { click: () => act(() => api(`/api/tasks/${encodeURIComponent(t.id)}/dispatch`, 'POST', { account }), `${t.id} lancée sur ChatGPT ${account}`) } }, 'Oui, lancer'),
        h('button', { class: 'btn sm', on: { click: () => (confirmBox.hidden = true) } }, 'Annuler'))));
  };
  const showLaunch = ['todo', 'queued', 'claimed', 'blocked', 'failed'].includes(t.status);
  const launchBox = showLaunch ? section('Confier à ChatGPT',
    t.status === 'queued' ? h('p', { class: 'muted', style: 'margin-bottom:10px' }, 'Elle est en file : elle partira toute seule. Tu peux aussi la lancer tout de suite ou la retirer de la file.') : h('p', { class: 'muted', style: 'margin-bottom:10px' }, 'ChatGPT travaille dans une copie du projet puis te rend un résultat à valider.'),
    accountPick,
    h('div', { class: 'actions', style: 'margin-top:12px' },
      h('button', { class: 'btn primary', disabled: !dispatch.ok, on: { click: launch } }, icon('play', 16), 'Lancer maintenant'),
      queue.ok ? h('button', { class: 'btn', on: { click: () => act(() => api(`/api/tasks/${encodeURIComponent(t.id)}/queue`, 'POST', { account: 'any' }), 'Mise en file d’attente') } }, icon('clock', 16), 'Mettre en file d’attente') : null,
      t.status === 'queued' ? h('button', { class: 'btn', on: { click: () => act(() => api(`/api/tasks/${encodeURIComponent(t.id)}/unqueue`, 'POST', {}), 'Retirée de la file') } }, 'Retirer de la file') : null),
    dispatch.ok ? null : h('p', { class: 'muted', style: 'margin-top:10px' }, dispatch.reason),
    confirmBox) : null;

  const statusButtons = h('div', { class: 'actions' },
    t.status === 'review' ? h('button', { class: 'btn good', on: { click: () => setStatus('done', 'Validée') } }, icon('check', 17), 'Valider : marquer terminée') : null,
    ...L.nextStatuses(t.status).filter((s) => !(t.status === 'review' && s === 'done')).map((s) =>
      h('button', { class: `btn sm ${s === 'done' ? 'primary' : ''}`, on: { click: () => setStatus(s, `${t.id} : ${(L.STATUS_LABEL[s] || s).toLowerCase()}`) } },
        { done: 'Marquer terminée', todo: t.status === 'done' ? 'Rouvrir' : 'Remettre à faire', blocked: 'Marquer bloquée' }[s] || s)),
    t.status === 'done' ? h('button', { class: 'btn sm', on: { click: () => act(() => api(`/api/tasks/${encodeURIComponent(t.id)}`, 'PATCH', { archived: true, note: 'Archivée' }), 'Tâche archivée') } }, icon('archive', 15), 'Archiver') : null);

  const note = draft(`note:${t.id}`, h('textarea', { class: 'input', rows: 2, placeholder: 'Ajouter une note…', 'aria-label': 'Note' }));
  const assignee = h('select', { class: 'input', 'aria-label': 'Assigner à', on: { change: (e) => act(() => api(`/api/tasks/${encodeURIComponent(t.id)}`, 'PATCH', { assignee: e.target.value || null })) } },
    h('option', { value: '' }, 'Non assignée'),
    [{ id: 'codex:a' }, { id: 'codex:b' }, ...st.sessions.filter((s) => s.status === 'running' || s.id === t.assignee)].map((a) => h('option', { value: a.id, selected: a.id === t.assignee }, name(a.id))));

  return {
    title: t.title,
    subtitle: h('span', { class: 'stat' }, h('span', { class: 'mono' }, t.id), projectChip(t.projectName), t.sandbox === 'read-only' ? h('span', { class: 'chip plain' }, 'audit en lecture seule') : null),
    body: [
      stateBox,
      answerBox,
      liveBox,
      resultBox,
      section('Que faire ?', statusButtons),
      launchBox,
      t.brief ? section('Détail de la tâche', h('div', { class: 'pre' }, t.brief)) : null,
      section('Informations', kv([
        ['Assignée à', t.assignee ? h('span', { class: 'stat' }, avatar(t.assignee, true), name(t.assignee)) : 'Personne'],
        ['Priorité', L.PRIORITY_LABEL[t.priority]],
        t.deps?.length ? ['Dépend de', t.deps.join(', ')] : null,
        t.project ? ['Dossier', h('span', { class: 'mono' }, t.project)] : null,
        ['Créée par', name(t.createdBy)],
        ['Mise à jour', L.relativeTime(t.updatedAt)],
        run ? ['Travail', h('button', { class: 'chip plain', on: { click: () => openPanel('run', run.id) } }, `${run.id.slice(0, 22)} · ${L.STATUS_LABEL[run.status] || run.status}`)] : null,
      ]), h('div', { style: 'margin-top:14px' }, h('label', { class: 'field' }, h('span', {}, 'Assigner à'), assignee))),
      section('Notes', t.notes?.length ? h('div', { class: 'notes' }, [...t.notes].reverse().map((n) => h('div', { class: 'note' }, h('small', {}, `${name(n.by)} · ${L.relativeTime(n.ts)}`), n.text))) : h('p', { class: 'muted' }, 'Aucune note.'),
        h('div', { style: 'margin-top:12px;display:grid;gap:10px' }, note,
          h('div', { class: 'actions' }, h('button', { class: 'btn sm', on: { click: async () => { const v = note.value.trim(); if (!v) return; if (await act(() => api(`/api/tasks/${encodeURIComponent(t.id)}`, 'PATCH', { note: v }))) S.drafts[`note:${t.id}`] = ''; } } }, 'Ajouter la note')))),
    ],
  };
}

function sessionPanel(s, extra) {
  const entries = extra?.entries || [];
  const msg = draft(`to:${s.id}`, h('textarea', { class: 'input', rows: 3, placeholder: 'Écrire à cette conversation…', 'aria-label': 'Message pour la conversation' }));
  return {
    title: s.title,
    subtitle: h('span', { class: 'stat' }, h('span', { class: `dot ${s.status === 'running' ? 'live' : ''}` }), s.status === 'running' ? 'En cours' : `Inactive · ${L.relativeTime(s.lastActivityAt)}`, projectChip(s.projectName)),
    body: [
      section('Écrire à cette conversation',
        h('div', { style: 'display:grid;gap:10px' }, msg,
          h('div', { class: 'actions' }, h('button', { class: 'btn primary sm', on: { click: async () => { const v = msg.value.trim(); if (!v) return; if (await act(() => api('/api/messages', 'POST', { to: s.id, body: v }), 'Message envoyé : elle le lira à son prochain tour')) { S.drafts[`to:${s.id}`] = ''; msg.value = ''; } } } }, icon('send', 15), 'Envoyer'),
            h('span', { class: 'faint' }, 'Lu à son prochain tour, ou tout de suite si elle écoute.')))),
      section('Ce qu’elle a fait récemment', extra?.error ? h('p', { class: 'muted' }, extra.error) : entries.length ? h('div', { class: 'tail' }, entries.map((e) =>
        h('div', { class: `e ${e.role}` }, h('small', {}, `${{ user: 'Toi', assistant: 'Claude', tool: `Outil · ${e.name}` }[e.role]} · ${L.relativeTime(e.ts)}`), e.text))) : h('p', { class: 'muted' }, 'Pas de fil disponible.')),
      section('Informations', kv([['Dossier', h('span', { class: 'mono' }, s.cwd || '—')], ['Modèle', s.model || '—'], ['Tours', s.completedTurns ?? '—'], s.note?.note ? ['Annonce', s.note.note] : null,
        s.link ? ['Lien', h('span', { class: 'actions' }, copyBtn(s.link, 'Copier le lien'))] : null])),
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
  } } }, 'Voir les modifications');
  return {
    title: r.title,
    subtitle: h('span', { class: 'stat' }, chip(r.status === 'needs-input' ? 'waiting' : r.status), `Compte ${r.account || '?'}`, projectChip(r.projectName)),
    body: [
      r.status === 'running' ? section('En ce moment', h('div', { class: 'live-card' }, h('div', { class: 'live-line' }, h('span', { class: 'dot live' }), h('b', {}, L.runLiveText(r))),
        r.progress?.files?.length ? h('div', { class: 'muted' }, `Fichiers touchés : ${r.progress.files.join(', ')}`) : null)) : null,
      r.taskId ? h('div', {}, h('button', { class: 'btn sm', on: { click: () => openPanel('task', r.taskId) } }, `Ouvrir la tâche ${r.taskId}`)) : null,
      section('Résumé de ChatGPT', h('div', { class: 'pre' }, full?.lastMessage || r.summary || 'Pas de résumé.')),
      section('Informations', kv([
        ['Démarré', L.relativeTime(r.startedAt)], r.durationSec != null ? ['Durée', L.formatDuration(r.durationSec)] : null,
        r.readOnly ? ['Mode', 'Audit en lecture seule : rien n’a été modifié'] : null,
        r.changes && !r.readOnly ? ['Modifications', `${r.changes.files} fichier(s), +${r.changes.added} / −${r.changes.deleted}`] : null,
        r.fixes ? ['Corrections auto', `${r.fixes} essai(s) après des tests en échec`] : null,
        r.tests?.cmd ? ['Tests', `${r.tests.cmd} → ${r.tests.skipped ? 'non lancés' : r.tests.passed ? 'OK' : `ÉCHEC (code ${r.tests.exit})`}`] : null,
        r.branch && !r.cleaned ? ['Branche', h('span', { class: 'mono' }, r.branch)] : null])),
      r.status === 'completed' && !r.cleaned && !r.readOnly ? section('Suite', h('div', { class: 'actions' }, copyBtn(`ah merge ${r.id}`, 'Copier la commande de fusion'), copyBtn(`ah show ${r.id} --patch`, 'Copier : voir le détail'))) : null,
      full?.errors?.length ? section('Erreurs', h('div', { class: 'pre' }, full.errors.join('\n'))) : null,
      full?.tests?.tail ? section('Sortie des tests', h('div', { class: 'pre mono' }, full.tests.tail)) : null,
      r.changes?.files && !r.readOnly && !r.cleaned ? section('Modifications', h('div', {}, diffBtn), diffBox) : null,
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
  const assignee = h('select', { class: 'input', 'aria-label': 'Confier à' }, h('option', { value: '' }, 'Personne pour l’instant'),
    ['codex:a', 'codex:b'].map((a) => h('option', { value: a }, name(a))), st.sessions.filter((s) => s.status === 'running').map((s) => h('option', { value: s.id }, s.title)));
  const audit = h('input', { type: 'checkbox' });
  const prio = h('select', { class: 'input', 'aria-label': 'Priorité' }, L.PRIORITY_LABEL.map((l, i) => h('option', { value: i, selected: i === 1 }, l)));
  const open = st.tasks.filter(L.isOpen);
  const depBoxes = open.map((t) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: t.id }), h('span', { class: 'clip' }, `${t.id} · ${t.title}`)));
  const form = h('form', { method: 'dialog', on: { submit: async (e) => {
    e.preventDefault();
    const deps = depBoxes.map((l) => l.firstChild).filter((c) => c.checked).map((c) => c.value);
    const ok = await act(() => api('/api/tasks', 'POST', { title: title.value, brief: brief.value, project: project.value || null, assignee: assignee.value || null, priority: +prio.value, deps, ...(audit.checked ? { sandbox: 'read-only', includeDirty: true } : {}) }), 'Tâche créée');
    if (ok) dlg.close();
  } } },
    h('h2', {}, 'Nouvelle tâche'),
    h('label', { class: 'field' }, h('span', {}, 'Titre'), title),
    h('label', { class: 'field' }, h('span', {}, 'Détail (facultatif)'), brief),
    h('div', { class: 'split' }, h('label', { class: 'field' }, h('span', {}, 'Projet'), project), h('label', { class: 'field' }, h('span', {}, 'Priorité'), prio)),
    h('label', { class: 'field' }, h('span', {}, 'Confier à'), assignee),
    h('label', { class: 'check' }, audit, 'Audit en lecture seule : ChatGPT lit le projet (modifications en cours comprises) sans rien modifier'),
    open.length ? h('div', { class: 'field' }, h('span', {}, 'À faire après…'), h('div', { class: 'deps' }, depBoxes)) : null,
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
