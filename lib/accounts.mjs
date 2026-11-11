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

/** Identifiant du compte ChatGPT derrière un CODEX_HOME (sans jamais exposer de jeton). */
export function accountId(account) {
  const auth = readJson(path.join(account.home, 'auth.json'), null);
  return auth?.tokens?.account_id || null;
}

/** Nom du compte déjà listé avant celui-ci qui est en réalité le même compte ChatGPT, sinon null. */
export function duplicateOf(account, all) {
  const id = accountId(account);
  if (!id) return null;
  for (const other of all) {
    if (other.name === account.name) return null;
    if (isLoggedIn(other) && accountId(other) === id) return other.name;
  }
  return null;
}

export function loginStatus(account) {
  if (!isLoggedIn(account)) return 'non connecté';
  const { cmd, pre, shell } = resolveCodex();
  const r = run(cmd, [...pre, 'login', 'status'], { env: codexEnv(account.home), shell });
  const out = (r.stdout + r.stderr).trim().split('\n').filter(Boolean).pop() || '';
  return r.code === 0 ? out || 'connecté' : `erreur: ${out}`;
}

/** Modèle local demandé (`9b`, `ollama:9b`, ou `local` = le premier « coder »), sinon null. */
export function pickLocal(cfg, requested) {
  if (!requested || requested === 'auto' || !cfg.local?.length) return null;
  const name = String(requested).replace(/^ollama:/, '');
  if (name === 'local') return cfg.local.find((l) => l.role === 'coder') || cfg.local[0];
  return cfg.local.find((l) => l.name === name) || null;
}

/** Ordre d'essai pour un run. Retourne { list, explicit }. */
export function pickAccounts(cfg, requested) {
  const local = pickLocal(cfg, requested);
  if (local) return { list: [local], explicit: true, local: true };
  // Un même compte ChatGPT connecté dans deux dossiers partage le même quota : on ne le compte qu'une fois.
  const usable = cfg.accounts.filter((a) => isLoggedIn(a) && !duplicateOf(a, cfg.accounts));
  if (!usable.length) {
    throw new Error('aucun compte Codex connecté. Lance `ah accounts` pour voir comment en ajouter un.');
  }
  if (requested && requested !== 'auto') {
    const a = cfg.accounts.find((x) => x.name === requested);
    if (!a) throw new Error(`compte inconnu "${requested}" (comptes: ${cfg.accounts.map((x) => x.name).join(', ')})`);
    if (!isLoggedIn(a)) throw new Error(`compte "${requested}" non connecté (${a.home})`);
    const dup = duplicateOf(a, cfg.accounts);
    if (dup) throw new Error(`le compte "${requested}" est le même compte ChatGPT que "${dup}" (même quota). Reconnecte-le avec un autre compte: voir \`ah accounts\`.`);
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

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * "try again at 7:58 PM" -> prochaine occurrence locale en ISO.
 * "try again at Dec 4th, 2026 2:48 PM" (plafond hebdomadaire ou mensuel) -> cette date précise.
 */
export function parseResetTime(message, now = new Date()) {
  const full = /try again at\s+([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(message || '');
  if (full && MONTHS[full[1].slice(0, 3).toLowerCase()] !== undefined) {
    let h = +full[4] % 12;
    if (/pm/i.test(full[6])) h += 12;
    return new Date(+full[3], MONTHS[full[1].slice(0, 3).toLowerCase()], +full[2], h, +full[5], 0, 0).toISOString();
  }
  const m = /try again at\s+(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(message || '');
  if (!m) return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  let h = +m[1] % 12;
  if (/pm/i.test(m[3])) h += 12;
  const d = new Date(now);
  d.setHours(h, +m[2], 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}
