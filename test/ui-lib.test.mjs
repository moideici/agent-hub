import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../ui/lib.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const ago = (min) => new Date(NOW - min * 60_000).toISOString();

const task = (over) => ({ id: 'T-001', title: 'x', status: 'todo', priority: 1, projectKey: 'a', projectName: 'Projet A', project: 'C:\\p\\a', deps: [], notes: [], createdAt: ago(100), updatedAt: ago(10), ...over });
const sess = (over) => ({ id: 'claude:1', title: 'S', status: 'idle', projectKey: 'a', projectName: 'Projet A', lastActivityAt: ago(60), ...over });

test('relativeTime: français, bornes et valeurs invalides', () => {
  assert.equal(L.relativeTime(ago(0.2), NOW), "à l'instant");
  assert.equal(L.relativeTime(ago(5), NOW), 'il y a 5 min');
  assert.equal(L.relativeTime(ago(180), NOW), 'il y a 3 h');
  assert.equal(L.relativeTime(ago(60 * 24 * 3), NOW), 'il y a 3 j');
  assert.equal(L.relativeTime(null, NOW), '');
  assert.equal(L.relativeTime('pas une date', NOW), '');
  assert.equal(L.relativeTime(new Date(NOW + 5000).toISOString(), NOW), "à l'instant"); // futur : jamais négatif
});

test('shortPath, formatDuration, initials, hueOf', () => {
  assert.equal(L.shortPath('C:\\Users\\gabor\\code\\multi'), 'multi');
  assert.equal(L.shortPath('/home/x/proj/'), 'proj');
  assert.equal(L.shortPath(''), '');
  assert.equal(L.formatDuration(null), '');
  assert.equal(L.formatDuration(42), '42 s');
  assert.equal(L.formatDuration(125), '2 min 05 s');
  assert.equal(L.formatDuration(3725), '1 h 02 min');
  assert.equal(L.initials('Plateforme de coordination'), 'PD');
  assert.equal(L.initials('Codex'), 'CO');
  assert.equal(L.initials(''), '?');
  assert.equal(L.hueOf('claude:abc'), L.hueOf('claude:abc'));
  assert.ok(L.hueOf('x') >= 0 && L.hueOf('x') < 360);
});

test('agentName: utilisateur, tous, Codex, session connue et inconnue', () => {
  const state = { sessions: [{ id: 'claude:1', title: 'Ma session' }] };
  assert.equal(L.agentName('user', state), 'Toi');
  assert.equal(L.agentName('*', state), 'Tout le monde');
  assert.equal(L.agentName('codex:b', state), 'ChatGPT b');
  assert.equal(L.agentName('claude:1', state), 'Ma session');
  assert.equal(L.agentName('claude:zzz', state), 'Session Claude');
  assert.equal(L.agentName(null, state), '—');
  assert.equal(L.agentKind('codex:a'), 'codex');
});

test('groupTasksByProject: par projet puis par colonne, compteurs et ordre', () => {
  const tasks = [
    task({ id: 'T-001', status: 'done' }),
    task({ id: 'T-002', status: 'review' }),
    task({ id: 'T-003', status: 'running', priority: 3 }),
    task({ id: 'T-004', status: 'claimed', priority: 1 }),
    task({ id: 'T-005', status: 'failed' }),
    task({ id: 'T-006', projectKey: 'b', projectName: 'Projet B', status: 'todo', updatedAt: ago(1) }),
    task({ id: 'T-007', projectKey: '', projectName: 'Sans projet', status: 'todo' }),
  ];
  const groups = L.groupTasksByProject(tasks);
  assert.deepEqual(groups.map((g) => g.name), ['Projet A', 'Projet B', 'Sans projet']); // A d'abord : tâches à traiter
  const a = groups[0];
  assert.deepEqual(a.lanes.doing.map((t) => t.id), ['T-003', 'T-004']); // priorité décroissante
  assert.deepEqual(a.lanes.review.map((t) => t.id), ['T-002']);
  assert.deepEqual(a.lanes.blocked.map((t) => t.id), ['T-005']);
  assert.equal(a.lanes.done.length, 0); // terminées masquées
  assert.deepEqual(a.counts, { todo: 0, doing: 2, review: 1, blocked: 1, done: 1, open: 4, total: 5 });
  assert.equal(a.progress, 1 / 5);
  assert.equal(a.attention, 2);
  assert.equal(L.groupTasksByProject(tasks, { showDone: true })[0].lanes.done.length, 1);
});

test('groupTasksByProject: filtres projet, sans projet, assigné et texte', () => {
  const tasks = [
    task({ id: 'T-001', assignee: 'codex:a', title: 'Écrire le moteur' }),
    task({ id: 'T-002', projectKey: 'b', projectName: 'B', title: 'Autre chose' }),
    task({ id: 'T-003', projectKey: '', projectName: 'Sans projet', title: 'Orpheline' }),
  ];
  assert.deepEqual(L.groupTasksByProject(tasks, { project: 'b' }).map((g) => g.name), ['B']);
  assert.deepEqual(L.groupTasksByProject(tasks, { project: '__none' }).map((g) => g.name), ['Sans projet']);
  assert.deepEqual(L.groupTasksByProject(tasks, { assignee: 'codex:a' }).map((g) => g.name), ['Projet A']);
  assert.deepEqual(L.groupTasksByProject(tasks, { text: 'MOTEUR' }).map((g) => g.name), ['Projet A']);
  assert.deepEqual(L.groupTasksByProject([], {}), []);
  assert.deepEqual(L.groupTasksByProject(undefined, {}), []);
});

test('groupSessions: actives d’abord, anciennes masquées, filtre texte', () => {
  const sessions = [
    sess({ id: 'claude:1', title: 'Ancienne', lastActivityAt: ago(60 * 24 * 10) }),
    sess({ id: 'claude:2', title: 'Récente', lastActivityAt: ago(30) }),
    sess({ id: 'claude:3', title: 'Active', status: 'running', lastActivityAt: ago(0) }),
    sess({ id: 'claude:4', title: 'Autre projet', projectKey: 'b', projectName: 'B', lastActivityAt: ago(5) }),
  ];
  const r = L.groupSessions(sessions, { now: NOW });
  assert.equal(r.hiddenOld, 1);
  assert.deepEqual(r.groups.map((g) => g.name), ['Projet A', 'B']); // groupe avec une session active en premier
  assert.deepEqual(r.groups[0].sessions.map((s) => s.title), ['Active', 'Récente']);
  assert.equal(L.groupSessions(sessions, { now: NOW, showOld: true }).hiddenOld, 0);
  assert.deepEqual(L.groupSessions(sessions, { now: NOW, text: 'autre' }).groups.map((g) => g.name), ['B']);
  assert.deepEqual(L.groupSessions([], { now: NOW }), { groups: [], hiddenOld: 0 });
});

test('attentionItems: à relire, échecs, bloquées, messages, quota, tests — du plus urgent au moins urgent', () => {
  const state = {
    tasks: [task({ id: 'T-001', status: 'review', title: 'A' }), task({ id: 'T-002', status: 'failed', title: 'B' }), task({ id: 'T-003', status: 'blocked', title: 'C' }), task({ id: 'T-004', status: 'done' })],
    messages: [{ id: 7, from: 'codex:a', to: 'user', body: 'fini', ts: ago(2) }],
    userUnread: [7],
    accounts: [{ id: 'codex:a', name: 'a', limitedUntil: new Date(NOW + 3600_000).toISOString() }, { id: 'codex:b', name: 'b', limitedUntil: ago(30) }],
    runs: [{ id: 'r1', title: 'run', status: 'completed', tests: { cmd: 'npm test', passed: false }, endedAt: ago(30), cleaned: false }, { id: 'r2', status: 'completed', tests: { cmd: 'npm test', passed: false }, endedAt: ago(60 * 24 * 5) }],
    sessions: [],
  };
  const items = L.attentionItems(state, NOW);
  // niveau d'abord (échec > action > alerte), puis le plus récent en premier à l'intérieur d'un niveau
  assert.deepEqual(items.map((i) => i.kind), ['failed', 'messages', 'review', 'quota', 'blocked', 'tests']);
  assert.match(items.find((i) => i.kind === 'messages').detail, /ChatGPT a : fini/);
  assert.equal(items.filter((i) => i.kind === 'quota').length, 1); // quota b déjà passé : ignoré
  assert.deepEqual(L.attentionItems({}, NOW), []);
});

test('runningNow, projectsOverview et activityFeed', () => {
  const state = {
    sessions: [sess({ id: 'claude:1', status: 'running', now: 'Bash: npm test' }), sess({ id: 'claude:2', projectKey: 'z', projectName: 'Z', lastActivityAt: ago(60 * 24 * 20) })],
    runs: [{ id: 'r1', title: 'Run A', status: 'running', account: 'b', startedAt: ago(3), projectKey: 'a', projectName: 'Projet A' }, { id: 'r0', title: 'Vieux', status: 'completed', account: 'a', startedAt: ago(60 * 24 * 9), endedAt: ago(60 * 24 * 9), projectKey: 'a' }],
    tasks: [task({ id: 'T-001', status: 'done', notes: [{ ts: ago(8), by: 'claude:1', text: 'fait' }, { ts: ago(7), by: 'agent-hub', text: 'bruit' }] }), task({ id: 'T-002', status: 'todo' })],
    messages: [{ id: 1, ts: ago(1), from: 'user', to: 'claude:1', body: 'salut', kind: 'msg' }],
  };
  assert.deepEqual(L.runningNow(state).map((x) => x.type), ['run', 'session']);
  const overview = L.projectsOverview(state, NOW);
  assert.deepEqual(overview.map((p) => p.name), ['Projet A']); // Z : aucune tâche ouverte, inactif depuis 20 jours
  assert.equal(overview[0].done, 1);
  assert.equal(overview[0].total, 2);
  assert.equal(overview[0].running, 2);
  const feed = L.activityFeed(state, 10, NOW);
  assert.ok(feed[0].ts >= feed[feed.length - 1].ts); // récent d'abord
  assert.ok(!feed.some((e) => e.text.includes('bruit'))); // notes du hub ignorées
  assert.ok(!feed.some((e) => e.text.includes('Vieux'))); // run de plus de 7 jours ignoré
  assert.equal(L.activityFeed(state, 2, NOW).length, 2);
  assert.deepEqual(L.activityFeed({}, 5, NOW), []);
});

test('canDispatch: raisons de refus et comptes', () => {
  const accounts = [{ name: 'a', loggedIn: true }, { name: 'b', loggedIn: true, limitedUntil: new Date(NOW + 3600_000).toISOString() }];
  const state = { accounts, tasks: [task({ id: 'T-001', status: 'done' })], limits: { maxParallelCodex: 2 } };
  const ok = L.canDispatch(task({ id: 'T-002', status: 'todo' }), state);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.accounts.map((a) => a.disabled), [false, true]);
  assert.match(L.canDispatch(task({ project: null }), state).reason, /pas de dossier/);
  assert.match(L.canDispatch(task({ status: 'review' }), state).reason, /à relire/);
  assert.match(L.canDispatch(task({ deps: ['T-001', 'T-009'] }), state).reason, /Attend T-009/);
  const busy = { ...state, tasks: [task({ id: 'T-010', status: 'running', assignee: 'codex:a' }), task({ id: 'T-011', status: 'running', assignee: 'codex:b' })] };
  assert.match(L.canDispatch(task({}), busy).reason, /maximum 2/);
  assert.match(L.canDispatch(task({}), { ...state, accounts: [{ name: 'a', loggedIn: false }] }).reason, /Aucun compte/);
  assert.equal(L.canDispatch(null, state).ok, false);
});

test('nextStatuses et stateSignature', () => {
  assert.deepEqual(L.nextStatuses('review'), ['done', 'todo']);
  assert.deepEqual(L.nextStatuses('inconnu'), []);
  assert.equal(L.stateSignature({ now: 'a', x: 1 }), L.stateSignature({ now: 'b', x: 1 })); // l'horloge ne compte pas
  assert.notEqual(L.stateSignature({ x: 1 }), L.stateSignature({ x: 2 }));
});
