import fs from 'node:fs';
import path from 'node:path';
import { listTasks, getTask, lockProject, unlockProject, listLocks } from './bus.mjs';
import { me, pumpQueue, briefFor, projectOf } from './coord.mjs';

const line = (t) => `${t.id.padEnd(6)} ${t.status.padEnd(8)} p${t.priority} ${(t.assignee || '-').padEnd(24).slice(0, 24)} ${t.title}`;

/** ah queue [pump] : état de la file d'attente et lancement de ce qui peut partir. */
export function cmdQueue(opts) {
  const [sub] = opts._;
  if (sub === 'pump' || !sub) {
    for (const x of pumpQueue()) console.log(`✔ ${x.id} lancée sur le compte ${x.acct}`);
  }
  const queued = listTasks({ status: 'queued' }).filter((t) => !t.archived);
  if (opts.json) return console.log(JSON.stringify(queued, null, 2));
  console.log(queued.length ? `En file (${queued.length}) :\n${queued.map(line).join('\n')}` : "File d'attente vide.");
}

const SETTLED = new Set(['review', 'done', 'failed', 'blocked', 'waiting']);

/**
 * ah wait T-001 [T-002 …] [--any] [--timeout MIN] : attend que les tâches soient « posées » (à relire, terminées, en échec,
 * bloquées ou en attente d'une réponse), puis les résume. Sortie 0 si tout va bien, 1 en cas d'échec ou de blocage,
 * 3 au délai dépassé, 4 si Codex attend une réponse. À lancer avec run_in_background : une seule notification à la fin.
 */
export async function cmdWait(opts) {
  const ids = opts._;
  if (!ids.length) throw new Error('usage: ah wait T-001 [T-002 …] [--any] [--timeout MIN]');
  const limit = Date.now() + (opts.timeout ? +opts.timeout : 60) * 60_000;
  for (;;) {
    pumpQueue(); // aide la file à avancer pendant qu'on attend
    const tasks = ids.map((id) => {
      const t = getTask(id);
      if (!t) throw new Error(`tâche introuvable: ${id}`);
      return t;
    });
    const settled = tasks.filter((t) => SETTLED.has(t.status));
    if (opts.any ? settled.length > 0 : settled.length === tasks.length) {
      for (const t of tasks) console.log(`${t.id} → ${t.status}${SETTLED.has(t.status) ? '' : ' (en cours)'}  ${t.title}`);
      if (tasks.some((t) => t.status === 'waiting')) process.exit(4);
      process.exit(tasks.some((t) => ['failed', 'blocked'].includes(t.status)) ? 1 : 0);
    }
    if (Date.now() > limit) {
      for (const t of tasks) console.log(`${t.id} → ${t.status}  ${t.title}`);
      console.log('délai dépassé');
      process.exit(3);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** ah lock [dossier] [--note "…"] · ah lock list · ah unlock [dossier] : « je travaille sur ce projet » (consultatif, expire après 6 h). */
export function cmdLock(opts, unlock = false) {
  const who = me();
  if (!unlock && opts._[0] === 'list') {
    const locks = listLocks();
    if (opts.json) return console.log(JSON.stringify(locks, null, 2));
    return console.log(locks.length ? locks.map((l) => `${l.key.padEnd(30)} ${l.holder} depuis ${l.since.slice(11, 16)}${l.note ? ` — ${l.note}` : ''}`).join('\n') : 'Aucun projet réservé.');
  }
  const p = projectOf(path.resolve(opts._[0] || process.cwd()));
  if (unlock) {
    console.log(unlockProject(p.key, who) ? `✔ ${p.name} libéré` : `${p.name} n'était pas réservé`);
    return;
  }
  const r = lockProject(p.key, { holder: who, note: opts.note || '', path: p.path });
  console.log(`✔ ${p.name} réservé pour ${who} (expire sans rafraîchissement après 6 h)`);
  if (r.previous) console.log(`⚠ ${r.previous.holder} avait déjà réservé ce projet${r.previous.note ? ` (${r.previous.note})` : ''} : coordonnez-vous (ah msg send).`);
}

/** ah brief [--hook] : résumé pour l'agent courant. Avec --hook : sortie JSON pour le hook SessionStart de Claude Code. */
export function cmdBrief(opts) {
  let who = me();
  let event = 'SessionStart';
  if (opts.hook) {
    let input = {};
    try {
      input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    } catch {
      /* pas de JSON : pas de résumé */
    }
    if (!input.session_id) return;
    who = `claude:${input.session_id}`;
    event = input.hook_event_name || event;
  }
  const text = briefFor(who);
  if (opts.hook) {
    if (text) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
    return;
  }
  console.log(text || 'Rien de particulier : aucune tâche, aucun message, aucun projet réservé.');
}
