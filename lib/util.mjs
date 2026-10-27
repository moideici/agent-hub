import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const HUB_DIR = process.env.AH_HOME ? path.resolve(process.env.AH_HOME) : path.join(HOME, '.agent-hub');

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(HOME, p.slice(2));
  return p;
}

export function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

export function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

export function slug(s, max = 40) {
  const out = String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return out || 'task';
}

export function timestampId(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function tail(s, lines = 40) {
  const arr = String(s || '').replace(/\r/g, '').trimEnd().split('\n');
  return arr.slice(-lines).join('\n');
}

export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });
  return { code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

export function log(...args) {
  console.error('[ah]', ...args);
}

export function die(msg, code = 1) {
  console.error(`ah: ${msg}`);
  process.exit(code);
}

export function fmtDuration(sec) {
  sec = Math.round(sec);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return `${m}m${String(sec % 60).padStart(2, '0')}s`;
}

export function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
