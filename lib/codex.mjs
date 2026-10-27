import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Trouve comment lancer Codex sans passer par un shell (le prompt part sur stdin,
 * donc aucun problème de quoting). Priorité : AH_CODEX_BIN, puis le codex.js du
 * paquet npm global, puis `codex` du PATH.
 */
let resolved = null;
export function resolveCodex() {
  if (resolved) return resolved;
  const override = process.env.AH_CODEX_BIN;
  if (override) {
    if (/\.(c|m)?js$/i.test(override)) return (resolved = { cmd: process.execPath, pre: [override], shell: false });
    return (resolved = { cmd: override, pre: [], shell: /\.(cmd|bat)$/i.test(override) });
  }
  const rel = ['node_modules', '@openai', 'codex', 'bin', 'codex.js'];
  const candidates = [];
  if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', ...rel));
  for (const c of candidates) {
    if (fs.existsSync(c)) return (resolved = { cmd: process.execPath, pre: [c], shell: false });
  }
  const root = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true, windowsHide: true });
  if (root.status === 0 && root.stdout.trim()) {
    const c = path.join(root.stdout.trim(), '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(c)) return (resolved = { cmd: process.execPath, pre: [c], shell: false });
  }
  return (resolved = { cmd: 'codex', pre: [], shell: process.platform === 'win32' });
}

/** Environnement du processus Codex : OAuth ChatGPT uniquement (jamais de clé API). */
export function codexEnv(home) {
  const env = { ...process.env, CODEX_HOME: home };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
}

export function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

function sandboxFor(home, setting) {
  if (process.platform !== 'win32') return null;
  if (setting && setting !== 'auto') return setting;
  // Le mode "elevated" nécessite l'installation préalable (admin) dans CODEX_HOME.
  return fs.existsSync(path.join(home, '.sandbox')) ? 'elevated' : 'unelevated';
}

/**
 * Lance `codex exec` en non-interactif.
 * Retourne { code, timedOut, finalMessage, errors, usage, limited, threadId }.
 */
export function runCodex(o) {
  return new Promise((resolve) => {
    const { cmd, pre, shell } = resolveCodex();
    const args = [...pre, 'exec', '--json', '-s', o.sandbox, '-C', o.cwd];
    if (!o.useUserConfig) args.push('--ignore-user-config');
    const winSb = sandboxFor(o.home, o.windowsSandbox);
    if (winSb) args.push('-c', `windows.sandbox="${winSb}"`);
    if (o.model) args.push('-m', o.model);
    if (o.effort) args.push('-c', `model_reasoning_effort="${o.effort}"`);
    if (o.schemaFile) args.push('--output-schema', o.schemaFile);
    if (o.lastFile) args.push('-o', o.lastFile);
    if (o.ephemeral) args.push('--ephemeral');
    args.push('-');

    const jsonl = o.jsonlFile ? fs.createWriteStream(o.jsonlFile) : null;
    const errLog = o.stderrFile ? fs.createWriteStream(o.stderrFile) : null;

    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: codexEnv(o.home),
      shell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const res = { code: null, timedOut: false, finalMessage: '', errors: [], usage: null, threadId: null };
    let buf = '';

    const handle = (line) => {
      if (!line.trim()) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      switch (ev.type) {
        case 'thread.started':
          res.threadId = ev.thread_id || null;
          break;
        case 'error':
          if (ev.message && !res.errors.includes(ev.message)) res.errors.push(ev.message);
          break;
        case 'turn.failed':
          if (ev.error?.message && !res.errors.includes(ev.error.message)) res.errors.push(ev.error.message);
          break;
        case 'turn.completed':
          res.usage = ev.usage || res.usage;
          break;
        case 'item.completed':
          if (ev.item?.type === 'agent_message' && ev.item.text) res.finalMessage = ev.item.text;
          o.onEvent?.(ev);
          break;
        default:
          o.onEvent?.(ev);
      }
    };

    child.stdout.on('data', (d) => {
      jsonl?.write(d);
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => errLog?.write(d));

    const timer = o.timeoutMs
      ? setTimeout(() => {
          res.timedOut = true;
          killTree(child);
        }, o.timeoutMs)
      : null;

    const finish = (code) => {
      if (timer) clearTimeout(timer);
      if (buf.trim()) handle(buf);
      jsonl?.end();
      errLog?.end();
      res.code = code;
      res.limited = res.errors.some((e) => /usage limit|rate limit|quota|limit.*reached/i.test(e));
      if (o.lastFile && fs.existsSync(o.lastFile)) {
        const txt = fs.readFileSync(o.lastFile, 'utf8').trim();
        if (txt) res.finalMessage = txt;
      }
      resolve(res);
    };

    child.on('error', (e) => {
      res.errors.push(`impossible de lancer codex: ${e.message}`);
      finish(-1);
    });
    child.on('close', (code) => finish(code));

    child.stdin.on('error', () => {});
    child.stdin.end(o.prompt);
  });
}
