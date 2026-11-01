import fs from 'node:fs';
import path from 'node:path';

const clip = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** Codex lance ses commandes dans une enveloppe PowerShell : on ne garde que la commande utile. */
export function shortCommand(cmd) {
  let c = String(cmd || '');
  const m = /-Command\s+"([\s\S]*)"\s*$/.exec(c) || /-Command\s+'([\s\S]*)'\s*$/.exec(c);
  if (m) c = m[1];
  return clip(c, 140);
}

/**
 * Progression d'un run en direct, écrite dans <run>/progress.json (lue par le dashboard et `ah show`).
 * Alimentée par les événements JSON de `codex exec` : commande en cours, fichiers touchés, dernier message.
 */
export function makeProgress(file, worktree) {
  const state = {
    phase: 'codex', events: 0, commands: 0, lastCommand: null, lastMessage: null, files: [],
    startedAt: new Date().toISOString(), updatedAt: null,
  };
  let lastWrite = 0;

  function flush(force = false) {
    const t = Date.now();
    if (!force && t - lastWrite < 800) return;
    lastWrite = t;
    state.updatedAt = new Date().toISOString();
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    } catch {
      /* la progression est un confort : jamais bloquante */
    }
  }

  return {
    state,
    set(patch) {
      Object.assign(state, patch);
      flush(true);
    },
    feed(ev) {
      state.events++;
      const item = ev?.item;
      if (ev?.type === 'item.started' && item?.type === 'command_execution') {
        state.commands++;
        state.lastCommand = shortCommand(item.command);
      } else if (item?.type === 'file_change') {
        for (const c of item.changes || []) {
          const rel = worktree ? path.relative(worktree, c.path || '') : c.path;
          const name = rel && !rel.startsWith('..') ? rel : c.path;
          if (name && !state.files.includes(name) && state.files.length < 60) state.files.push(name);
        }
      } else if (ev?.type === 'item.completed' && item?.type === 'agent_message') {
        state.lastMessage = clip(item.text, 240);
      }
      flush();
    },
    flush: () => flush(true),
  };
}

export function readProgress(runDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, 'progress.json'), 'utf8'));
  } catch {
    return null;
  }
}
