import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadGlobal } from './config.mjs';
import { HUB_DIR, ensureDir, run as runCmd } from './util.mjs';
import { ollamaVersion, ollamaTags, ollamaPs, ollamaChat, runOllama } from './ollama.mjs';
import { gpuInfoSync, vramByProcess } from './gpu.mjs';
import { repoKey, RUNS_DIR, WORKTREES_DIR } from './runs.mjs';

const AH_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ah.mjs');
const BENCH_TASKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bench', 'ollama', 'tasks');
const mib = (bytes) => Math.round(bytes / 1048576);

/* ───────────── ah gpu ───────────── */

export async function cmdGpu(opts) {
  const cfg = loadGlobal();
  const gpu = gpuInfoSync();
  const hosts = [...new Set([...cfg.local.map((l) => l.host), 'http://127.0.0.1:11434'])];
  let loaded = [];
  for (const h of hosts) {
    try {
      loaded = (await ollamaPs(h)).models || [];
      break;
    } catch {
      /* Ollama arrêté */
    }
  }
  const procs = vramByProcess(20);
  if (opts.json) return console.log(JSON.stringify({ gpu, ollamaLoaded: loaded.map((m) => ({ name: m.name, sizeVramMiB: mib(m.size_vram || 0) })), processes: procs }, null, 2));
  if (!gpu) return console.log('Aucune carte NVIDIA détectée (nvidia-smi absent ou muet).');
  console.log(`${gpu.name} : ${gpu.usedMiB} / ${gpu.totalMiB} Mo utilisés, ${gpu.freeMiB} Mo libres`);
  if (loaded.length) console.log(`Ollama a en mémoire : ${loaded.map((m) => `${m.name} (${mib(m.size_vram || 0)} Mo de VRAM)`).join(', ')}`);
  const others = procs.filter((p) => !/^ollama/i.test(p.name));
  if (others.length) {
    console.log('\nQui occupe la carte (hors Ollama) :');
    for (const p of others.slice(0, 12)) console.log(`  ${String(p.mib).padStart(5)} Mo  ${p.name} (pid ${p.pid})`);
    const light = others.filter((p) => !/^(dwm|csrss|explorer|System)$/i.test(p.name));
    const gain = light.reduce((n, p) => n + p.mib, 0);
    console.log(`\nLe bureau Windows (dwm, explorer) ne se libère pas. Fermer les autres applications ci-dessus rendrait environ ${gain} Mo.`);
  }
}

/* ───────────── ah ollama ───────────── */

/** Découpe la sortie de `ollama show --modelfile` en blocs FROM / TEMPLATE / RENDERER / PARSER / PARAMETER. */
export function parseModelfile(text) {
  const out = { from: [], keep: [], params: [] };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*#/.test(l) || !l.trim()) continue;
    if (/^FROM\s/i.test(l)) out.from.push(l.replace(/^FROM\s+/i, '').trim());
    else if (/^PARAMETER\s/i.test(l)) out.params.push(l);
    else if (/^LICENSE\b/i.test(l)) break;
    else if (/^(TEMPLATE|SYSTEM|RENDERER|PARSER|MESSAGE)\b/i.test(l)) {
      let block = l;
      if ((l.match(/"""/g) || []).length === 1) {
        while (++i < lines.length) {
          block += `\n${lines[i]}`;
          if (lines[i].includes('"""')) break;
        }
      }
      out.keep.push(block);
    }
  }
  return out;
}

/** Contenu du Modelfile qui dérive `l.model` de `l.base` avec les réglages du hub (ou du seul fichier de poids si `noVision`). */
export function buildModelfile(l, base) {
  const lines = [];
  if (l.noVision) {
    if (!base.from.length) throw new Error(`impossible de retrouver les poids de ${l.base}`);
    lines.push(`FROM ${base.from[0]}`, ...base.keep); // texte seul : sans le module vision (≈ 0,6 Go de VRAM en moins)
  } else {
    lines.push(`FROM ${l.base}`);
  }
  const p = { num_ctx: l.ctx, temperature: l.temperature, top_p: l.topP, top_k: l.topK, presence_penalty: l.presencePenalty };
  for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null) lines.push(`PARAMETER ${k} ${v}`);
  return `${lines.join('\n')}\n`;
}

export async function cmdOllama(opts) {
  const [sub, name] = opts._;
  const cfg = loadGlobal();
  switch (sub) {
    case 'status': {
      const host = cfg.local[0]?.host || 'http://127.0.0.1:11434';
      let version = null;
      try {
        version = await ollamaVersion(host);
      } catch (e) {
        console.log(`Ollama : ${e.message}`);
      }
      if (version) {
        const tags = (await ollamaTags(host)).models || [];
        const ps = (await ollamaPs(host)).models || [];
        console.log(`Ollama ${version} sur ${host} · ${tags.length} modèles installés · en mémoire : ${ps.map((m) => `${m.name} (${mib(m.size_vram || 0)} Mo VRAM / ${mib(m.size || 0)} Mo)`).join(', ') || 'aucun'}`);
        for (const l of cfg.local) {
          const ok = tags.some((m) => m.name === l.model || m.name === `${l.model}:latest`);
          console.log(`  ${l.id.padEnd(12)} ${l.model.padEnd(22)} ${ok ? 'prêt' : 'à créer (ah ollama setup)'} · rôle ${l.role} · contexte ${l.ctx}${l.think !== undefined ? ` · réflexion ${l.think}` : ''}`);
        }
        if (!cfg.local.length) console.log('Aucun modèle local déclaré dans ~/.agent-hub/config.json ("local": [...]). Voir docs/OLLAMA.md.');
      }
      return;
    }
    case 'setup': {
      const targets = cfg.local.filter((l) => l.base && (!name || l.name === name));
      if (!targets.length) throw new Error('aucun modèle local avec un "base" à préparer (voir docs/OLLAMA.md)');
      for (const l of targets) {
        const show = runCmd('ollama', ['show', '--modelfile', l.base]);
        if (show.code !== 0) throw new Error(`ollama show ${l.base} a échoué : ${(show.stderr || show.stdout).trim().split('\n').pop()}`);
        const mf = buildModelfile(l, parseModelfile(show.stdout));
        const file = path.join(os.tmpdir(), `ah-modelfile-${l.name}.txt`);
        fs.writeFileSync(file, mf);
        console.log(`Création de ${l.model} (depuis ${l.base}${l.noVision ? ', texte seul' : ''}) …`);
        const r = spawnSync('ollama', ['create', l.model, '-f', file], { encoding: 'utf8', windowsHide: true, timeout: 600_000 });
        fs.rmSync(file, { force: true });
        if (r.status !== 0) throw new Error(`ollama create ${l.model} a échoué : ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
        console.log(`✔ ${l.model} prêt`);
      }
      return;
    }
    case 'smoke': {
      const l = cfg.local.find((x) => x.name === name) || cfg.local[0];
      if (!l) throw new Error('aucun modèle local configuré');
      const t0 = Date.now();
      const r = await ollamaChat(l.host, {
        model: l.model,
        messages: [{ role: 'user', content: 'Call the finish tool with the summary "ok".' }],
        tools: [{ type: 'function', function: { name: 'finish', description: 'Finish', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } }],
        options: { num_ctx: l.ctx, temperature: 0 }, ...(l.think !== undefined ? { think: l.think } : {}), keep_alive: l.keepAlive,
      }, 600_000);
      const ps = (await ollamaPs(l.host)).models?.find((m) => m.name === l.model || m.model === l.model);
      const res = {
        model: l.model, secondes: +((Date.now() - t0) / 1000).toFixed(1), chargementS: +((r.load_duration || 0) / 1e9).toFixed(1),
        promptTokens: r.prompt_eval_count, evalTokens: r.eval_count, tokParSec: r.eval_duration ? +(r.eval_count / (r.eval_duration / 1e9)).toFixed(1) : null,
        appelOutilValide: !!r.message?.tool_calls?.some((c) => c.function?.name === 'finish'),
        vramMo: ps ? mib(ps.size_vram || 0) : null, tailleMo: ps ? mib(ps.size || 0) : null, surGpuPct: ps?.size ? Math.round(((ps.size_vram || 0) / ps.size) * 100) : null,
      };
      return console.log(JSON.stringify(res, null, 2));
    }
    default:
      throw new Error('usage: ah ollama status | setup [nom] | smoke [nom]');
  }
}

/* ───────────── ah bench ───────────── */

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
const sh = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true });

/** Liste des tâches du benchmark, filtrées par niveaux (`0-3`, `0,2,5`) et/ou identifiants. */
export function selectTasks({ levels = null, tasks = null, dir = BENCH_TASKS } = {}) {
  if (!fs.existsSync(dir)) return [];
  const wantLevels = levels === null ? null : new Set(String(levels).split(',').flatMap((p) => {
    const m = /^(\d)-(\d)$/.exec(p.trim());
    return m ? Array.from({ length: +m[2] - +m[1] + 1 }, (_, i) => +m[1] + i) : [+p];
  }));
  const wantIds = tasks ? new Set(String(tasks).split(',')) : null;
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, d.name, 'task.json'), 'utf8'));
    return { ...meta, dir: path.join(dir, d.name) };
  }).filter((t) => (!wantLevels || wantLevels.has(t.level)) && (!wantIds || wantIds.has(t.id))).sort((a, b) => a.level - b.level || a.id.localeCompare(b.id));
}

/** Une tâche avec un modèle : dépôt jetable, `ah run`, verdict des tests du hub, détection de triche sur les tests. */
export function benchOne(task, model, { timeoutMin = 20, fix = null, work }) {
  const repo = path.join(work, model, task.id, 'repo');
  fs.rmSync(path.dirname(repo), { recursive: true, force: true });
  copyTree(path.join(task.dir, 'repo'), repo);
  const g = (...a) => sh('git', a, repo);
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('-c', 'user.name=bench', '-c', 'user.email=bench@localhost', 'commit', '-qm', 'tâche de départ');
  const args = [AH_BIN, 'run', path.join(task.dir, 'brief.md'), '--repo', repo, '--acct', model, '--json', '--timeout', String(timeoutMin)];
  if (fix !== null) args.push('--fix', String(fix));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: (timeoutMin + 5) * 60_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  const rec = { model, task: task.id, level: task.level, title: task.title, exit: r.status, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
  try {
    const run = JSON.parse(r.stdout);
    const stats = [...(run.attempts || [])].reverse().find((a) => a.stats)?.stats || {};
    const startTests = new Set(fs.readdirSync(path.join(task.dir, 'repo'), { recursive: true }).map((f) => String(f).replace(/\\/g, '/')));
    const touchedTests = (run.changes?.files || []).map((f) => f.file).filter((f) => startTests.has(f) && /(^|\/)(test|tests)\/|\.(test|spec)\./.test(f));
    Object.assign(rec, {
      status: run.status, testsPassed: !!run.tests?.passed && !run.tests?.skipped, fixes: run.fixes || 0, touchedTests,
      steps: (run.attempts || []).reduce((n, a) => n + (a.stats?.steps || 0), 0), toolErrors: (run.attempts || []).reduce((n, a) => n + (a.stats?.toolErrors || 0), 0),
      tokPerSec: stats.tokPerSec ?? null, outTokens: run.usage?.output_tokens ?? null, files: (run.changes?.files || []).length, error: run.errors?.[0] || null, runId: run.id,
    });
    rec.passed = rec.status === 'completed' && rec.testsPassed && touchedTests.length === 0; // modifier un test existant = triche
    rec.passedFirst = rec.passed && rec.fixes === 0;
  } catch {
    Object.assign(rec, { status: 'crash', passed: false, passedFirst: false, error: (r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' | ').slice(0, 300) });
  }
  return rec;
}

export function summarize(records) {
  const models = [...new Set(records.map((r) => r.model))];
  const levels = [...new Set(records.map((r) => r.level))].sort((a, b) => a - b);
  const lines = ['| Niveau | ' + models.map((m) => `${m} : réussi du 1er coup / après correction / total · temps médian`).join(' | ') + ' |', '|---|' + models.map(() => '---').join('|') + '|'];
  for (const lv of levels) {
    const cells = models.map((m) => {
      const rs = records.filter((r) => r.model === m && r.level === lv);
      if (!rs.length) return '—';
      return `${rs.filter((r) => r.passedFirst).length} / ${rs.filter((r) => r.passed).length} / ${rs.length} · ${median(rs.map((r) => r.seconds))} s`;
    });
    lines.push(`| ${lv} | ${cells.join(' | ')} |`);
  }
  const verdicts = [];
  for (const m of models) {
    const l0 = records.filter((r) => r.model === m && r.level === 0);
    if (l0.length) verdicts.push(`${m} : niveau 0 (« nulles ») ${l0.filter((r) => r.passed).length}/${l0.length}${l0.every((r) => r.passed) ? ' ✔ toutes réussies' : ' ✘ des tâches triviales échouent'}`);
    const cheat = records.filter((r) => r.model === m && r.touchedTests?.length);
    if (cheat.length) verdicts.push(`${m} : ${cheat.length} tâche(s) où des tests existants ont été modifiés (comptées en échec)`);
  }
  return `${lines.join('\n')}\n\n${verdicts.join('\n')}`;
}

export async function cmdBench(opts) {
  const [sub] = opts._;
  if (sub && sub !== 'run') throw new Error('usage: ah bench run --models 9b,27b [--levels 0-6] [--tasks id,id] [--timeout MIN] [--fix N] [--keep]');
  const cfg = loadGlobal();
  const models = String(opts.models || cfg.local.map((l) => l.name).join(',')).split(',').filter(Boolean);
  if (!models.length) throw new Error('aucun modèle : --models 9b,27b');
  const tasks = selectTasks({ levels: opts.levels ?? null, tasks: opts.tasks ?? null });
  if (!tasks.length) throw new Error('aucune tâche de benchmark (bench/ollama/tasks) ne correspond');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const work = path.join(ensureDir(path.join(HUB_DIR, 'bench')), stamp);
  const out = path.join(HUB_DIR, 'bench', `bench-${stamp}.json`);
  const records = [];
  console.log(`Benchmark : ${tasks.length} tâches × ${models.length} modèle(s) (${models.join(', ')}), délai ${opts.timeout || 20} min par tâche.\n`);
  for (const model of models) {
    for (const task of tasks) {
      const rec = benchOne(task, model, { timeoutMin: +opts.timeout || 20, fix: opts.fix !== undefined ? +opts.fix : null, work });
      records.push(rec);
      fs.writeFileSync(out, JSON.stringify(records, null, 2));
      console.log(`${rec.passed ? '✔' : '✘'} ${model.padEnd(6)} L${task.level} ${task.id.padEnd(28)} ${String(rec.seconds).padStart(7)} s  étapes ${rec.steps ?? '-'}  erreurs d'outil ${rec.toolErrors ?? '-'}  correction ${rec.fixes ?? '-'}${rec.error ? `  [${String(rec.error).slice(0, 80)}]` : ''}`);
      // ménage : on ne laisse ni run ni worktree du dépôt jetable dans ~/.agent-hub
      if (!opts.keep) {
        const key = repoKey(path.join(work, model, task.id, 'repo'));
        fs.rmSync(path.join(RUNS_DIR, key), { recursive: true, force: true });
        fs.rmSync(path.join(WORKTREES_DIR, key), { recursive: true, force: true });
      }
    }
  }
  if (!opts.keep) fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${summarize(records)}\n\nRésultats détaillés : ${out}`);
}
