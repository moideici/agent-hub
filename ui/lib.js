const timestamp = value => value == null || value === '' ? NaN : new Date(value).getTime();
export function relativeTime(value, now = Date.now()) {
  const time = timestamp(value);
  if (!Number.isFinite(time)) return 'Date inconnue';
  const seconds = Math.max(0, Math.floor((Number(now) - time) / 1000));
  if (seconds < 60) return 'à l’instant';
  if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `il y a ${Math.floor(seconds / 3600)} h`;
  return `il y a ${Math.floor(seconds / 86400)} j`;
}
export function shortPath(value) { return String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '—'; }
export const columns = [
  {id:'todo', label:'À faire', statuses:['todo']},
  {id:'running', label:'En cours', statuses:['claimed','running']},
  {id:'review', label:'À relire', statuses:['review']},
  {id:'done', label:'Terminées', statuses:['done']},
  {id:'blocked', label:'Bloquées / échecs', statuses:['blocked','failed']},
];
export function groupTasks(tasks = []) { return Object.fromEntries(columns.map(c => [c.id, tasks.filter(t => c.statuses.includes(t.status))])); }
export function sortSessions(sessions = []) { return [...sessions].sort((a,b) => Number(b.status === 'running') - Number(a.status === 'running') || (timestamp(b.lastActivityAt) || 0) - (timestamp(a.lastActivityAt) || 0)); }
export function agentName(id, sessions = [], accounts = []) {
  if (!id) return 'Non assignée';
  if (id === '*') return 'Tous';
  if (id === 'user') return 'Vous';
  return sessions.find(s => s.id === id)?.title || accounts.find(a => a.id === id)?.name || (id.startsWith('codex:') ? `Codex ${id.slice(6).toUpperCase()}` : id);
}
export function formatDuration(value) {
  if (value == null || !Number.isFinite(Number(value)) || Number(value) < 0) return '—';
  const seconds = Math.floor(Number(value));
  return seconds < 60 ? `${seconds} s` : seconds < 3600 ? `${Math.floor(seconds/60)} min ${seconds%60} s` : `${Math.floor(seconds/3600)} h ${Math.floor(seconds%3600/60)} min`;
}
export function canDispatch(task, state, account = 'a', now = Date.now()) {
  if (!task?.project?.trim()) return {ok:false, raison:'Renseignez le chemin du projet pour lancer cette tâche.'};
  if (!['todo','claimed','blocked','failed'].includes(task.status)) return {ok:false, raison:'Ce statut ne permet pas de lancer la tâche.'};
  const acct = (state.accounts || []).find(a => a.id === `codex:${account}`);
  if (!acct) return {ok:false, raison:'Compte indisponible.'};
  if (!acct.loggedIn) return {ok:false, raison:'Ce compte est déconnecté.'};
  if (timestamp(acct.limitedUntil) > Number(now)) return {ok:false, raison:'Quota ChatGPT atteint pour ce compte.'};
  if ((state.runs || []).filter(r => r.status === 'running').length >= (state.limits?.maxParallelCodex ?? 3)) return {ok:false, raison:'Nombre maximal de runs Codex en cours atteint.'};
  return {ok:true, raison:''};
}
