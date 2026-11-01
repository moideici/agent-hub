import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUB_DIR, ensureDir } from './util.mjs';
import { addTask, updateTask, getTask, listTasks, post } from './bus.mjs';
import { findSession, sessionTail } from './sessions.mjs';
import { findRun } from './runs.mjs';
import { buildState, stateHash, dispatchTask, resolveAddress } from './coord.mjs';
import { diffPatch } from './git.mjs';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const TOKEN_FILE = path.join(HUB_DIR, 'server-token');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

export function loadToken() {
  const t = fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '';
  if (t.length >= 32) return t;
  const fresh = crypto.randomBytes(24).toString('hex');
  ensureDir(HUB_DIR);
  fs.writeFileSync(TOKEN_FILE, fresh + '\n');
  return fresh;
}

const sameToken = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function cookieToken(req) {
  const m = /(?:^|;\s*)ah=([^;]+)/.exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : '';
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        reject(new Error('corps trop gros'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON invalide'));
      }
    });
    req.on('error', reject);
  });
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};
const text = (res, code, s, type = 'text/plain; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(s);
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(UI_DIR, rel);
  if (!file.startsWith(UI_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return text(res, 404, 'introuvable');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

/**
 * Serveur du dashboard. Écoute uniquement en local, exige un jeton (cookie), refuse les hôtes inattendus
 * (anti DNS-rebinding) et les écritures venant d'une autre origine (anti CSRF).
 */
export function startServer({ port = 4317, host = '127.0.0.1', token = loadToken(), pollMs = 1500 } = {}) {
  const allowedHosts = new Set();
  const clients = new Set();
  let lastHash = '';

  const timer = setInterval(() => {
    if (!clients.size) return;
    try {
      const h = stateHash(buildState());
      if (h !== lastHash) {
        lastHash = h;
        for (const c of clients) c.write(`data: ${JSON.stringify({ v: h })}\n\n`);
      }
    } catch {
      /* état momentanément illisible : prochain tour */
    }
  }, pollMs);
  timer.unref();

  async function api(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    let g;

    if (m === 'GET' && p === '/api/state') return json(res, 200, buildState());
    if (m === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ v: lastHash })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (m === 'GET' && (g = /^\/api\/sessions\/(.+)\/tail$/.exec(p))) {
      const s = findSession(decodeURIComponent(g[1]));
      if (!s) return json(res, 404, { error: 'session introuvable' });
      const { transcript, ...meta } = s;
      return json(res, 200, { session: meta, entries: sessionTail(s, Math.min(+url.searchParams.get('n') || 40, 200)) });
    }
    if (m === 'GET' && (g = /^\/api\/runs\/([^/]+)\/diff$/.exec(p))) {
      const r = findRun(decodeURIComponent(g[1]));
      const f = path.join(r.dir, 'diff.patch');
      const patch = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : diffPatch(r.repoRoot, r.base, r.branch);
      return text(res, 200, patch.length > 400_000 ? `${patch.slice(0, 400_000)}\n… (tronqué)` : patch);
    }
    if (m === 'GET' && (g = /^\/api\/runs\/([^/]+)$/.exec(p))) {
      const r = findRun(decodeURIComponent(g[1]));
      const last = path.join(r.dir, 'last.txt');
      return json(res, 200, { ...r, lastMessage: fs.existsSync(last) ? fs.readFileSync(last, 'utf8').slice(0, 20_000) : null });
    }
    if (m === 'GET' && p === '/api/tasks') return json(res, 200, listTasks());
    if (m === 'POST' && p === '/api/tasks') {
      const b = await readBody(req);
      const assignee = b.assignee ? resolveAddress(b.assignee) : null;
      return json(res, 201, addTask({ ...b, assignee, createdBy: 'user' }));
    }
    if (m === 'PATCH' && (g = /^\/api\/tasks\/([^/]+)$/.exec(p))) {
      const b = await readBody(req);
      if (b.assignee) b.assignee = resolveAddress(b.assignee);
      return json(res, 200, updateTask(decodeURIComponent(g[1]), b, 'user'));
    }
    if (m === 'POST' && (g = /^\/api\/tasks\/([^/]+)\/dispatch$/.exec(p))) {
      const b = await readBody(req);
      return json(res, 200, dispatchTask(decodeURIComponent(g[1]), b.account || 'a', 'user'));
    }
    if (m === 'POST' && p === '/api/messages') {
      const b = await readBody(req);
      const to = resolveAddress(b.to);
      if (b.taskId && !getTask(b.taskId)) throw new Error(`tâche introuvable: ${b.taskId}`);
      return json(res, 201, post({ from: 'user', to, body: b.body, taskId: b.taskId || null }));
    }
    return json(res, 404, { error: 'route inconnue' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const hostHdr = String(req.headers.host || '').toLowerCase();
      if (!allowedHosts.has(hostHdr)) return text(res, 403, 'hôte refusé');
      const url = new URL(req.url, `http://${hostHdr}`);

      if (url.pathname === '/' && url.searchParams.has('t')) {
        if (!sameToken(url.searchParams.get('t'), token)) return text(res, 403, 'jeton invalide');
        res.writeHead(302, {
          'set-cookie': `ah=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
          location: '/',
          'cache-control': 'no-store',
        });
        return res.end();
      }
      if (!sameToken(cookieToken(req), token) && !sameToken(req.headers['x-ah-token'], token)) {
        return text(res, 401, "Accès refusé. Ouvre l'URL affichée par `ah serve` (elle contient ?t=…).");
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const o = req.headers.origin;
        if (o && o !== `http://${hostHdr}`) return text(res, 403, 'origine refusée');
      }
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      return serveStatic(res, url.pathname);
    } catch (e) {
      if (!res.headersSent) json(res, 400, { error: e.message });
      else res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      allowedHosts.add(`127.0.0.1:${actual}`);
      allowedHosts.add(`localhost:${actual}`);
      resolve({
        server,
        port: actual,
        token,
        url: `http://127.0.0.1:${actual}/?t=${token}`,
        close: () => new Promise((r) => {
          clearInterval(timer);
          for (const c of clients) c.end();
          server.close(() => r());
          server.closeAllConnections?.();
        }),
      });
    });
  });
}
