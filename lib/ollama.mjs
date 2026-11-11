import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { killTree } from './codex.mjs';

/**
 * Agent de code local : une boucle « le modèle appelle des outils » au-dessus de l'API d'Ollama.
 * Pensé pour de petits modèles : peu d'outils, prompt court, sorties tronquées, contexte surveillé, erreurs d'outil
 * renvoyées au modèle (jamais de plantage). Les outils sont BORNÉS au dossier du projet (le worktree) : pas de shell libre,
 * pas de réseau, pas d'écriture dans .git / node_modules / .env, fichiers de test existants protégés.
 * Émet les mêmes événements que `codex exec --json` pour réutiliser la progression et le journal du hub.
 */
export const DEFAULT_HOST = 'http://127.0.0.1:11434';

/* ───────────── API Ollama ───────────── */

async function api(host, route, body, { timeoutMs = 600_000, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${host}${route}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* corps non JSON */
    }
    if (!res.ok) {
      const e = new Error(data?.error || `HTTP ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') {
      const x = new Error(`délai dépassé (${Math.round(timeoutMs / 1000)} s)`);
      x.timeout = true;
      throw x;
    }
    if (e.status) throw e;
    const x = new Error(`Ollama injoignable sur ${host} : lance l'application Ollama (${e.cause?.code || e.message})`);
    x.unreachable = true;
    throw x;
  } finally {
    clearTimeout(timer);
  }
}

export const ollamaVersion = (host = DEFAULT_HOST) => api(host, '/api/version', undefined, { timeoutMs: 3000 }).then((d) => d.version);
export const ollamaTags = (host = DEFAULT_HOST) => api(host, '/api/tags', undefined, { timeoutMs: 5000 });
export const ollamaPs = (host = DEFAULT_HOST) => api(host, '/api/ps', undefined, { timeoutMs: 3000 });
export const ollamaChat = (host, body, timeoutMs) => api(host, '/api/chat', { ...body, stream: false }, { timeoutMs });

/** Version synchrone (curl) de /api/ps : sert au planificateur, qui n'est pas asynchrone. null si Ollama ne répond pas. */
export function ollamaPsSync(host = DEFAULT_HOST) {
  const r = spawnSync('curl', ['-s', '-m', '2', `${host}/api/ps`], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/* ───────────── Outils ───────────── */

class ToolError extends Error {}

const SKIP_DIRS = new Set(['node_modules', '.git', '.agent-hub', '__pycache__', '.venv', 'venv', 'dist', 'build', 'target']);
const isTestPath = (rel) => /(^|\/)(tests?|__tests__)\//i.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(rel) || /(^|\/)test_[^/]*\.py$/i.test(rel);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… (tronqué, ${s.length - n} caractères en plus)` : s);

const fn = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const str = (description) => ({ type: 'string', description });

export const TOOL_SCHEMAS = {
  list_files: fn('list_files', 'List files and folders of the project (node_modules and .git are hidden).', { path: str('Folder relative to the project root. Default "."'), depth: { type: 'integer', description: 'Maximum depth, default 2' } }),
  read_file: fn('read_file', 'Read a text file with line numbers. Long files are cut: use start_line and end_line to read a range.', { path: str('File path relative to the project root'), start_line: { type: 'integer', description: 'First line (1-based)' }, end_line: { type: 'integer', description: 'Last line' } }, ['path']),
  search: fn('search', 'Search a regular expression (case-insensitive) in the project files. Returns file:line: text.', { pattern: str('Regular expression'), path: str('File or folder to search in. Default "."') }, ['pattern']),
  write_file: fn('write_file', 'Create a new file, or fully overwrite one. For small changes to an existing file prefer replace_in_file.', { path: str('File path relative to the project root'), content: str('Complete file content') }, ['path', 'content']),
  replace_in_file: fn('replace_in_file', 'Replace an exact piece of text in an existing file. old_text must appear exactly once: include enough surrounding lines to make it unique, copied exactly from read_file (without line numbers).', { path: str('File path'), old_text: str('Exact text to replace'), new_text: str('Replacement text') }, ['path', 'old_text', 'new_text']),
  run_tests: fn('run_tests', 'Run the project test command and return the result (exit code and the end of the output).'),
  ask_question: fn('ask_question', 'Ask the person who gave the task ONE precise question when essential information is missing. Ends your work until they answer.', { question: str('The question') }, ['question']),
  finish: fn('finish', 'Call when the task is complete, or when you cannot go further. Give a short summary: what you changed, how you checked it, what remains uncertain.', { summary: str('Short summary') }, ['summary']),
};

const READ_ONLY_TOOLS = ['list_files', 'read_file', 'search', 'ask_question', 'finish'];
const ALL_TOOLS = Object.keys(TOOL_SCHEMAS);

function execShell(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')); // sinon un `node --test` lancé par les tests du hub « réussit » toujours
    const child = spawn(command, { cwd, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const add = (d) => {
      out += d.toString('utf8');
      if (out.length > 400_000) out = out.slice(-200_000);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('error', (e) => add(`\n[ah] ${e.message}\n`));
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: timedOut ? -1 : code, timedOut, out });
    });
  });
}

class Workspace {
  constructor(root, { testCmd = null, testTimeoutMs = 180_000, protectTests = true, emit = () => {} } = {}) {
    this.root = path.resolve(root);
    this.realRoot = fs.realpathSync(this.root);
    this.testCmd = testCmd;
    this.testTimeoutMs = testTimeoutMs;
    this.protectTests = protectTests;
    this.emit = emit;
    this.changed = new Set();
    this.testFilesEdited = false;
  }

  /** Chemin demandé par le modèle -> { abs, rel }, toujours à l'intérieur du projet. */
  resolve(p) {
    if (typeof p !== 'string' || !p.trim()) throw new ToolError('path is required');
    const abs = path.resolve(this.root, p.trim());
    const rel = path.relative(this.root, abs).split(path.sep).join('/');
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ToolError(`path "${p}" is outside the project`);
    if (fs.existsSync(abs) && !rel.startsWith('node_modules')) {
      const real = fs.realpathSync(abs);
      if (path.relative(this.realRoot, real).startsWith('..')) throw new ToolError(`path "${p}" points outside the project`);
    }
    return { abs, rel: rel || '.' };
  }

  assertWritable(rel, abs) {
    const first = rel.split('/')[0];
    if (['.git', 'node_modules', '.agent-hub'].includes(first) || /(^|\/)\.env(\.|$)/.test(rel)) throw new ToolError(`writing to "${rel}" is not allowed`);
    if (this.protectTests && isTestPath(rel) && fs.existsSync(abs)) {
      this.testFilesEdited = true;
      throw new ToolError(`"${rel}" is an existing test file: it is read-only for this task. Change the source code instead.`);
    }
  }

  walk(dir, depth, maxDepth, out, prefix = '') {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name) && e.isDirectory()) continue;
      if (out.length >= 200) return;
      out.push(`${prefix}${e.name}${e.isDirectory() ? '/' : ''}`);
      if (e.isDirectory() && depth < maxDepth) this.walk(path.join(dir, e.name), depth + 1, maxDepth, out, `${prefix}  `);
    }
  }

  list_files({ path: p = '.', depth = 2 } = {}) {
    const { abs } = this.resolve(p || '.');
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new ToolError(`"${p}" is not a folder`);
    const out = [];
    this.walk(abs, 1, Math.min(Math.max(+depth || 2, 1), 5), out);
    return out.length ? out.join('\n') : '(empty folder)';
  }

  read_file({ path: p, start_line: start, end_line: end } = {}) {
    const { abs, rel } = this.resolve(p);
    if (!fs.existsSync(abs)) throw new ToolError(`file "${rel}" does not exist. Use list_files to see what exists.`);
    if (fs.statSync(abs).isDirectory()) throw new ToolError(`"${rel}" is a folder: use list_files`);
    if (fs.statSync(abs).size > 1_000_000) throw new ToolError(`"${rel}" is too large`);
    const text = fs.readFileSync(abs, 'utf8');
    if (text.includes('\0')) throw new ToolError(`"${rel}" is a binary file`);
    const lines = text.split(/\r?\n/);
    const from = Math.max(1, +start || 1);
    const to = Math.min(lines.length, +end || from + 299);
    const body = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(4)}| ${l}`).join('\n');
    const more = to < lines.length ? `\n… (${lines.length} lines in total; use start_line/end_line for the rest)` : '';
    return clip(`${rel} (${lines.length} lines)\n${body}${more}`, 24_000);
  }

  search({ pattern, path: p = '.' } = {}) {
    if (typeof pattern !== 'string' || !pattern) throw new ToolError('pattern is required');
    let re;
    try {
      re = new RegExp(pattern, 'i');
    } catch (e) {
      throw new ToolError(`invalid regular expression: ${e.message}`);
    }
    const { abs } = this.resolve(p || '.');
    const files = [];
    const visit = (f) => {
      const st = fs.statSync(f);
      if (st.isDirectory()) {
        for (const e of fs.readdirSync(f, { withFileTypes: true })) {
          if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
          if (files.length < 2000) visit(path.join(f, e.name));
        }
      } else if (st.size < 512_000) files.push(f);
    };
    if (!fs.existsSync(abs)) throw new ToolError(`"${p}" does not exist`);
    visit(abs);
    const hits = [];
    for (const f of files) {
      let text;
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\0')) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < 60; i++) {
        if (re.test(lines[i])) hits.push(`${path.relative(this.root, f).split(path.sep).join('/')}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
      }
      if (hits.length >= 60) break;
    }
    return hits.length ? hits.join('\n') + (hits.length >= 60 ? '\n… (60 matches shown)' : '') : 'no match';
  }

  write_file({ path: p, content } = {}) {
    const { abs, rel } = this.resolve(p);
    if (typeof content !== 'string') throw new ToolError('content is required (a string)');
    this.assertWritable(rel, abs);
    if (content.length > 300_000) throw new ToolError('content is too large');
    const existed = fs.existsSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    this.changed.add(rel);
    this.emit({ type: 'item.started', item: { id: `w-${this.changed.size}`, type: 'file_change', changes: [{ path: abs, kind: existed ? 'update' : 'add' }], status: 'in_progress' } });
    return `${existed ? 'overwrote' : 'created'} ${rel} (${content.split('\n').length} lines)`;
  }

  replace_in_file({ path: p, old_text: oldText, new_text: newText } = {}) {
    const { abs, rel } = this.resolve(p);
    if (typeof oldText !== 'string' || !oldText) throw new ToolError('old_text is required');
    if (typeof newText !== 'string') throw new ToolError('new_text is required (a string, may be empty)');
    if (!fs.existsSync(abs)) throw new ToolError(`file "${rel}" does not exist: use write_file to create it`);
    this.assertWritable(rel, abs);
    let text = fs.readFileSync(abs, 'utf8');
    const crlf = text.includes('\r\n');
    if (crlf) text = text.replace(/\r\n/g, '\n');
    const needle = oldText.replace(/\r\n/g, '\n');
    const count = text.split(needle).length - 1;
    if (count === 0) throw new ToolError(`old_text was not found in ${rel}. Read the file again (read_file) and copy the text exactly, without the line numbers.`);
    if (count > 1) throw new ToolError(`old_text appears ${count} times in ${rel}. Add more surrounding lines so that it appears exactly once.`);
    const at = text.indexOf(needle);
    const line = text.slice(0, at).split('\n').length;
    let next = text.replace(needle, () => newText.replace(/\r\n/g, '\n'));
    if (crlf) next = next.replace(/\n/g, '\r\n');
    fs.writeFileSync(abs, next);
    this.changed.add(rel);
    this.emit({ type: 'item.started', item: { id: `r-${this.changed.size}`, type: 'file_change', changes: [{ path: abs, kind: 'update' }], status: 'in_progress' } });
    return `replaced in ${rel} at line ${line}`;
  }

  async run_tests() {
    if (!this.testCmd) throw new ToolError('no test command is configured for this project');
    const r = await execShell(this.testCmd, this.root, this.testTimeoutMs);
    const lines = r.out.replace(/\r/g, '').trimEnd().split('\n');
    // sortie TAP de node:test : on garde surtout les échecs et le bilan
    const interesting = lines.filter((l) => /not ok|# (tests|pass|fail)|Error|expected|actual|at .*\.m?js:\d+/i.test(l));
    const body = clip((interesting.length > 8 && interesting.length < lines.length ? interesting.slice(-70) : lines.slice(-60)).join('\n'), 6000);
    return `${r.timedOut ? 'TIMEOUT' : `exit code ${r.code}`}\n${body}`;
  }
}

/* ───────────── Appels d'outils écrits « à la main » par le modèle ───────────── */

/** Certains petits modèles écrivent l'appel d'outil dans leur texte (<tool_call>{…}</tool_call> ou bloc json) au lieu d'utiliser le champ prévu. */
export function parseInlineToolCalls(content, names) {
  const out = [];
  const candidates = [];
  for (const m of String(content || '').matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) candidates.push(m[1]);
  for (const m of String(content || '').matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]);
  const whole = String(content || '').trim();
  if (whole.startsWith('{')) candidates.push(whole);
  for (const c of candidates) {
    try {
      const j = JSON.parse(c);
      const name = j.name || j.function?.name || j.tool;
      const args = j.arguments ?? j.function?.arguments ?? j.parameters ?? {};
      if (names.includes(name)) out.push({ function: { name, arguments: args } });
    } catch {
      /* pas du JSON valide */
    }
  }
  return out.slice(0, 4);
}

const parseArgs = (a) => {
  if (a && typeof a === 'object') return a;
  try {
    return JSON.parse(a || '{}');
  } catch {
    return {};
  }
};

/* ───────────── Boucle d'agent ───────────── */

const SYSTEM = `You are a careful coding agent. You work inside a project directory and can only act through tools.
Method: 1) look at the project and read the relevant files; 2) make the smallest change that solves the task (replace_in_file for existing files, write_file for new files); 3) call run_tests and fix what fails; 4) call finish with a short summary.
Rules: paths are relative to the project root. Read a file before editing it and copy text exactly. Never edit existing test files: change the source code instead. Do not invent files, functions or APIs: check that they exist. If the task is ambiguous or information is missing, call ask_question instead of guessing. Call one tool at a time and keep your messages short. Write summaries in the language of the task.`;

const estimateTokens = (messages) => Math.round(messages.reduce((n, m) => n + (m.content?.length || 0) + JSON.stringify(m.tool_calls || '').length, 0) / 3.2);

/** Retire les plus anciennes sorties d'outils quand le contexte approche de sa limite. */
function compact(messages, ctx) {
  const limit = ctx * 0.7;
  let dropped = 0;
  for (let i = 2; i < messages.length - 6 && estimateTokens(messages) > limit; i++) {
    const m = messages[i];
    if (m.role === 'tool' && m.content.length > 80) {
      m.content = '[older tool output removed to save context]';
      dropped++;
    }
  }
  return dropped;
}

/**
 * Exécute une tâche avec un modèle Ollama. Même forme de résultat que runCodex :
 * { code, timedOut, finalMessage, errors, usage, limited, threadId } + stats.
 * o : { account (modèle local normalisé), cwd, prompt, testCmd, readOnly, timeoutMs, onEvent, jsonlFile, lastFile, stderrFile }
 */
export async function runOllama(o) {
  const acct = o.account;
  const host = acct.host || DEFAULT_HOST;
  const res = {
    code: null, timedOut: false, finalMessage: '', errors: [], usage: { input_tokens: 0, output_tokens: 0 }, threadId: null, limited: false,
    stats: { steps: 0, toolCalls: 0, toolErrors: 0, nudges: 0, tests: 0, writes: 0, evalSec: 0, evalTokens: 0, loadSec: 0, testFilesEdited: false },
  };
  const jsonl = o.jsonlFile ? fs.createWriteStream(o.jsonlFile) : null;
  const log = o.stderrFile ? fs.createWriteStream(o.stderrFile) : null;
  const emit = (ev) => {
    jsonl?.write(`${JSON.stringify(ev)}\n`);
    try {
      o.onEvent?.(ev);
    } catch {
      /* un observateur défaillant ne doit pas casser le run */
    }
  };
  const done = (code) => {
    res.code = code;
    res.stats.tokPerSec = res.stats.evalSec > 0 ? +(res.stats.evalTokens / res.stats.evalSec).toFixed(1) : null;
    res.stats.testFilesEdited = ws?.testFilesEdited || false;
    if (!res.finalMessage) res.finalMessage = res.errors.length ? '' : 'Le modèle n’a donné aucun résumé.';
    if (o.lastFile && res.finalMessage) fs.writeFileSync(o.lastFile, res.finalMessage);
    jsonl?.end();
    log?.end();
    return res;
  };

  // Vérifications avant de commencer : Ollama répond, le modèle existe
  let ws = null;
  try {
    const tags = await ollamaTags(host);
    const known = (tags.models || []).map((m) => m.name);
    if (!known.includes(acct.model) && !known.includes(`${acct.model}:latest`)) {
      res.errors.push(`modèle "${acct.model}" introuvable dans Ollama (modèles : ${known.join(', ') || 'aucun'}). Lance \`ah ollama setup\`.`);
      return done(1);
    }
  } catch (e) {
    res.errors.push(e.message);
    return done(1);
  }

  ws = new Workspace(o.cwd, { testCmd: o.readOnly ? null : o.testCmd, protectTests: acct.protectTests !== false, emit });
  const toolNames = o.readOnly ? READ_ONLY_TOOLS : ALL_TOOLS.filter((n) => n !== 'run_tests' || o.testCmd);
  const tools = toolNames.map((n) => TOOL_SCHEMAS[n]);
  const options = Object.fromEntries(Object.entries({
    num_ctx: acct.ctx, temperature: acct.temperature, top_p: acct.topP, top_k: acct.topK, presence_penalty: acct.presencePenalty, num_predict: acct.numPredict,
  }).filter(([, v]) => v !== undefined && v !== null));

  const messages = [
    { role: 'system', content: `${SYSTEM}${o.readOnly ? '\nThis is a READ-ONLY review: you cannot modify anything. Explore, then call finish with your report.' : ''}` },
    { role: 'user', content: o.prompt },
  ];
  const deadline = o.timeoutMs ? Date.now() + o.timeoutMs : Infinity;
  emit({ type: 'thread.started', thread_id: `ollama-${Date.now()}` });
  emit({ type: 'turn.started' });

  let nudges = 0;
  let lastKey = '';
  let repeats = 0;
  const maxSteps = acct.maxSteps || 40;
  let finished = false;

  for (let step = 1; step <= maxSteps && !finished; step++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      res.timedOut = true;
      break;
    }
    res.stats.steps = step;
    compact(messages, acct.ctx || 32768);

    let r;
    try {
      r = await ollamaChat(host, {
        model: acct.model, messages, tools, options, keep_alive: acct.keepAlive || '30m',
        ...(acct.think !== undefined && acct.think !== null ? { think: acct.think } : {}),
      }, Math.min(remaining, (acct.stepTimeoutSec || 600) * 1000));
    } catch (e) {
      if (e.timeout) res.timedOut = true;
      res.errors.push(e.message);
      log?.write(`${e.message}\n`);
      break;
    }
    res.usage.input_tokens += r.prompt_eval_count || 0;
    res.usage.output_tokens += r.eval_count || 0;
    res.stats.evalTokens += r.eval_count || 0;
    res.stats.evalSec += (r.eval_duration || 0) / 1e9;
    res.stats.loadSec += (r.load_duration || 0) / 1e9;
    emit({ type: 'turn.stats', step, prompt_tokens: r.prompt_eval_count, eval_tokens: r.eval_count, eval_ms: Math.round((r.eval_duration || 0) / 1e6) });

    const msg = r.message || {};
    let calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const content = msg.content || '';
    if (!calls.length && content) calls = parseInlineToolCalls(content, toolNames);
    messages.push({ role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) });

    if (!calls.length) {
      // Le modèle parle au lieu d'agir : on le relance, puis on se contente de sa réponse comme résumé
      if (++nudges >= 3) {
        res.finalMessage = content.trim();
        res.stats.nudges += nudges;
        break;
      }
      messages.push({ role: 'user', content: 'Reply with a tool call. When the work is complete, call finish with a short summary.' });
      continue;
    }
    res.stats.nudges += nudges;
    nudges = 0;

    for (const call of calls.slice(0, 4)) {
      const name = call.function?.name;
      const args = parseArgs(call.function?.arguments);
      res.stats.toolCalls++;
      const key = `${name}:${JSON.stringify(args)}`;
      repeats = key === lastKey ? repeats + 1 : 0;
      lastKey = key;

      if (name === 'finish') {
        res.finalMessage = String(args.summary || content || '').trim();
        finished = true;
        break;
      }
      if (name === 'ask_question') {
        res.finalMessage = `QUESTION: ${String(args.question || '').trim()}`;
        finished = true;
        break;
      }
      emit({ type: 'item.started', item: { id: `c-${res.stats.toolCalls}`, type: 'command_execution', command: `${name} ${args.path || args.pattern || ''}`.trim() } });
      let out;
      try {
        if (!toolNames.includes(name)) throw new ToolError(`unknown tool "${name}". Available tools: ${toolNames.join(', ')}`);
        out = await ws[name](args);
        if (name === 'run_tests') res.stats.tests++;
        if (name === 'write_file' || name === 'replace_in_file') res.stats.writes++;
      } catch (e) {
        res.stats.toolErrors++;
        out = `Error: ${e instanceof ToolError ? e.message : `tool failed (${e.message})`}`;
      }
      if (repeats >= 2) out += '\nNote: you already made this exact call. Do something different: edit a file, run the tests, or finish.';
      emit({ type: 'item.completed', item: { id: `c-${res.stats.toolCalls}`, type: 'command_execution', status: out.startsWith('Error:') ? 'failed' : 'completed' } });
      messages.push({ role: 'tool', tool_name: name, content: clip(String(out), 8000) });
      if (repeats >= 5) {
        res.errors.push('boucle détectée : le modèle répète la même action');
        finished = true;
        break;
      }
    }
  }

  if (!finished && !res.timedOut && !res.errors.length && !res.finalMessage) {
    res.limitReached = res.stats.steps >= maxSteps;
    res.finalMessage = res.limitReached ? `Limite de ${maxSteps} étapes atteinte avant la fin.` : '';
  }
  if (res.finalMessage) emit({ type: 'item.completed', item: { type: 'agent_message', text: res.finalMessage } });
  emit({ type: 'turn.completed', usage: res.usage });
  return done(res.errors.length && !res.finalMessage ? 1 : 0);
}
