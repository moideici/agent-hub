import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOME, readJson } from './util.mjs';

/**
 * Lecture (seule) des sessions Claude Code de l'app desktop :
 *  - métadonnées : <données app>/claude-code-sessions/<compte>/<org>/local_<uuid>.json
 *  - transcription : ~/.claude/projects/<dossier>/<cliSessionId>.jsonl
 * Rien n'est jamais écrit ici.
 */
const ACTIVE_WINDOW_MS = 60_000;

function metadataRoots() {
  if (process.env.AH_CLAUDE_SESSIONS_DIR) return [process.env.AH_CLAUDE_SESSIONS_DIR];
  const roots = [];
  const local = process.env.LOCALAPPDATA;
  const bases = [];
  if (local) bases.push(path.join(local, 'Claude-Data'), path.join(local, 'Claude'));
  if (process.env.APPDATA) bases.push(path.join(process.env.APPDATA, 'Claude'));
  if (process.platform === 'darwin') bases.push(path.join(HOME, 'Library', 'Application Support', 'Claude'));
  if (process.platform === 'linux') bases.push(path.join(HOME, '.config', 'Claude'));
  for (const b of bases) {
    if (!fs.existsSync(b)) continue;
    const direct = path.join(b, 'claude-code-sessions');
    if (fs.existsSync(direct)) roots.push(direct);
    for (const d of safeReaddir(b)) {
      const p = path.join(b, d, 'claude-code-sessions');
      if (fs.existsSync(p)) roots.push(p);
    }
  }
  return roots;
}

const safeReaddir = (d) => {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
};

function* walkMetadata(dir, depth = 0) {
  for (const e of safeReaddir(dir)) {
    const p = path.join(dir, e);
    if (/^local_.*\.json$/.test(e)) yield p;
    else if (depth < 3) {
      try {
        if (fs.statSync(p).isDirectory()) yield* walkMetadata(p, depth + 1);
      } catch {
        /* dossier disparu */
      }
    }
  }
}

function transcriptIndex() {
  const base = process.env.AH_CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
  const idx = new Map();
  for (const d of safeReaddir(base)) {
    for (const f of safeReaddir(path.join(base, d))) {
      if (f.endsWith('.jsonl')) idx.set(f.slice(0, -6), path.join(base, d, f));
    }
  }
  return idx;
}

/** Sessions Claude connues, les plus récentes d'abord. */
export function listSessions({ includeArchived = false, limit = 60 } = {}) {
  const idx = transcriptIndex();
  const t = Date.now();
  const out = [];
  for (const root of metadataRoots()) {
    for (const file of walkMetadata(root)) {
      const m = readJson(file);
      if (!m?.sessionId) continue;
      if (m.isArchived && !includeArchived) continue;
      const cliId = m.cliSessionId || null;
      const transcript = cliId ? idx.get(cliId) || null : null;
      let mtime = 0;
      if (transcript) {
        try {
          mtime = fs.statSync(transcript).mtimeMs;
        } catch {
          /* transcription déplacée */
        }
      }
      const last = Math.max(m.lastActivityAt || 0, mtime);
      out.push({
        id: `claude:${cliId || m.sessionId}`,
        kind: 'claude',
        hostId: m.sessionId,
        cliId,
        title: m.title || '(sans titre)',
        cwd: m.cwd || null,
        model: m.model || null,
        completedTurns: m.completedTurns ?? null,
        permissionMode: m.permissionMode || null,
        createdAt: m.createdAt ? new Date(m.createdAt).toISOString() : null,
        lastActivityAt: last ? new Date(last).toISOString() : null,
        archived: !!m.isArchived,
        status: transcript && t - mtime < ACTIVE_WINDOW_MS ? 'running' : 'idle',
        link: `claude://claude.ai/epitaxy/${m.sessionId}`,
        transcript,
      });
    }
  }
  out.sort((a, b) => (a.lastActivityAt < b.lastActivityAt ? 1 : -1));
  return out.slice(0, limit);
}

export function findSession(ref) {
  if (!ref) return null;
  const all = listSessions({ includeArchived: true, limit: 500 });
  const r = String(ref).toLowerCase();
  const exact = all.find((s) => s.id.toLowerCase() === r || s.hostId.toLowerCase() === r || s.cliId?.toLowerCase() === r);
  if (exact) return exact;
  const part = all.filter((s) => s.title.toLowerCase().includes(r));
  return part.length === 1 ? part[0] : null;
}

/* ───── Aperçu de ce que fait une session (fin de transcription) ───── */

const cache = new Map(); // fichier -> { key, entries }

function readTailText(file, bytes) {
  const st = fs.statSync(file);
  const n = Math.min(st.size, bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(n);
    fs.readSync(fd, b, 0, n, st.size - n);
    const s = b.toString('utf8');
    return st.size > n ? s.slice(s.indexOf('\n') + 1) : s; // 1re ligne éventuellement coupée
  } finally {
    fs.closeSync(fd);
  }
}

const clip = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

function toolSummary(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['description', 'command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'skill']) {
    if (typeof input[k] === 'string' && input[k]) return clip(input[k], 160);
  }
  const first = Object.values(input).find((v) => typeof v === 'string');
  return first ? clip(first, 160) : '';
}

function parseEntries(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if ((j.type !== 'user' && j.type !== 'assistant') || !j.message) continue;
    const c = j.message.content;
    const ts = j.timestamp || null;
    if (typeof c === 'string') {
      if (j.type === 'user' && !c.startsWith('<')) entries.push({ ts, role: 'user', text: clip(c, 700) });
      continue;
    }
    if (!Array.isArray(c)) continue;
    for (const part of c) {
      if (part.type === 'text' && part.text?.trim()) {
        if (j.type === 'user' && part.text.trim().startsWith('<')) continue; // rappels système
        entries.push({ ts, role: j.type, text: clip(part.text, 700) });
      } else if (part.type === 'tool_use') {
        entries.push({ ts, role: 'tool', name: part.name, text: toolSummary(part.input) });
      }
    }
  }
  return entries;
}

/** Dernières actions d'une session (texte, appels d'outils), les plus récentes en dernier. */
export function sessionTail(session, n = 30) {
  if (!session?.transcript) return [];
  let st;
  try {
    st = fs.statSync(session.transcript);
  } catch {
    return [];
  }
  const key = `${st.size}:${st.mtimeMs}`;
  let c = cache.get(session.transcript);
  if (!c || c.key !== key) {
    c = { key, entries: parseEntries(readTailText(session.transcript, 1_500_000)) };
    cache.set(session.transcript, c);
  }
  return c.entries.slice(-n);
}

/** Ce que fait la session maintenant : dernière action d'outil ou dernier message. */
export function sessionNow(session) {
  const tail = sessionTail(session, 8);
  const last = tail[tail.length - 1];
  if (!last) return null;
  return last.role === 'tool' ? `${last.name}: ${last.text}` : `${last.role === 'user' ? 'Toi' : 'Claude'}: ${last.text}`;
}
