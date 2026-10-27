import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, ensureDir, HUB_DIR } from './util.mjs';
import { STATE_FILE } from './config.mjs';
import { codexEnv, resolveCodex } from './codex.mjs';
import { run } from './util.mjs';

export function readState() {
  return readJson(STATE_FILE, { limited: {} }) || { limited: {} };
}

export function limitedUntil(name) {
  const until = readState().limited?.[name];
  if (!until) return null;
  return new Date(until).getTime() > Date.now() ? until : null;
}

export function markLimited(name, untilIso) {
  ensureDir(HUB_DIR);
  const st = readState();
  st.limited = st.limited || {};
  st.limited[name] = untilIso;
  writeJson(STATE_FILE, st);
}

export function clearLimited(name) {
  const st = readState();
  if (st.limited?.[name]) {
    delete st.limited[name];
    writeJson(STATE_FILE, st);
  }
}

export function isLoggedIn(account) {
  return fs.existsSync(path.join(account.home, 'auth.json'));
}

export function loginStatus(account) {
  if (!isLoggedIn(account)) return 'non connecté';
  const { cmd, pre, shell } = resolveCodex();
  const r = run(cmd, [...pre, 'login', 'status'], { env: codexEnv(account.home), shell });
  const out = (r.stdout + r.stderr).trim().split('\n').filter(Boolean).pop() || '';
  return r.code === 0 ? out || 'connecté' : `erreur: ${out}`;
}

/** Ordre d'essai pour un run. Retourne { list, explicit }. */
export function pickAccounts(cfg, requested) {
  const usable = cfg.accounts.filter(isLoggedIn);
  if (!usable.length) {
    throw new Error('aucun compte Codex connecté. Lance `ah accounts` pour voir comment en ajouter un.');
  }
  if (requested && requested !== 'auto') {
    const a = cfg.accounts.find((x) => x.name === requested);
    if (!a) throw new Error(`compte inconnu "${requested}" (comptes: ${cfg.accounts.map((x) => x.name).join(', ')})`);
    if (!isLoggedIn(a)) throw new Error(`compte "${requested}" non connecté (${a.home})`);
    return { list: [a], explicit: true };
  }
  const free = usable.filter((a) => !limitedUntil(a.name));
  if (requested === 'auto') {
    if (!cfg.autoRotate) {
      throw new Error(
        'la bascule automatique entre comptes est désactivée. Active-la en connaissance de cause: ' +
          '"autoRotate": true dans ~/.agent-hub/config.json (vérifie d\'abord les conditions d\'utilisation d\'OpenAI).',
      );
    }
    const ordered = [...free, ...usable.filter((a) => limitedUntil(a.name))];
    return { list: ordered, explicit: false, auto: true };
  }
  const def = usable.find((a) => a.name === cfg.defaultAccount) || usable[0];
  return { list: [def], explicit: false };
}

/** "try again at 7:58 PM" -> prochaine occurrence locale en ISO. */
export function parseResetTime(message, now = new Date()) {
  const m = /try again at\s+(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(message || '');
  if (!m) return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  let h = +m[1] % 12;
  if (/pm/i.test(m[3])) h += 12;
  const d = new Date(now);
  d.setHours(h, +m[2], 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
