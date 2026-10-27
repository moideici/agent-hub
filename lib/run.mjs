import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { die, ensureDir, fmtDuration, log, slug, tail, timestampId } from './util.mjs';
import { loadGlobal, loadRepo } from './config.mjs';
import { pickAccounts, limitedUntil, markLimited, parseResetTime } from './accounts.mjs';
import { runCodex, killTree } from './codex.mjs';
import {
  mainRoot, hasCommit, headSha, currentBranch, addWorktree, removeWorktree, deleteBranch,
  excludeLocal, commitAll, diffNumstat, diffPatch, copyDirty, dirtySummary, git,
} from './git.mjs';
import { runDirFor, worktreeFor, saveRun } from './runs.mjs';

export function buildPrompt({ brief, branch, test }) {
  return `You are a worker agent dispatched by "agent-hub". An orchestrator agent wrote the task below and will review your work afterwards.

Rules:
- Work only inside the current directory: it is an isolated git worktree on branch "${branch}". Never read or modify files outside it.
- Do NOT run git commit, push, merge, checkout or branch commands. Leave your changes uncommitted; the hub commits them.
- Do not install global tools, do not touch credentials or .env files, and do not use the network unless the task requires it.
- Follow the conventions in AGENTS.md / CLAUDE.md / README if they exist.
- Stay strictly in scope. If the task is ambiguous or blocked, stop and explain it in your final message instead of guessing.
${test ? `- Verify your work by running: ${test}\n` : '- No automatic test command is configured; verify your work as best you can.\n'}
Your final message must contain: (1) what you changed, file by file; (2) how you verified it and the result; (3) anything uncertain, skipped or left unfinished.

# Task

${brief.trim()}
`;
}

function titleOf(brief, explicit) {
  if (explicit) return explicit;
  const h = /^#\s+(.+)$/m.exec(brief);
  const first = h ? h[1] : (brief.split('\n').find((l) => l.trim()) || 'task');
  return first.replace(/^[#>\-*\s]+/, '').trim().slice(0, 70) || 'task';
}

function runShell(command, cwd, timeoutMs, logFile) {
  return new Promise((resolve) => {
    const out = fs.createWriteStream(logFile);
    const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout.on('data', (d) => out.write(d));
    child.stderr.on('data', (d) => out.write(d));
    child.on('error', (e) => out.write(`\n[ah] ${e.message}\n`));
    child.on('close', (code) => {
      clearTimeout(t);
      out.end(() => resolve({ code: timedOut ? -1 : code, timedOut }));
    });
  });
}

function linkDeps(root, wt, names) {
  const linked = [];
  for (const n of names || []) {
    const src = path.join(root, n);
    const dst = path.join(wt, n);
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    try {
      fs.symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir');
      linked.push(n);
    } catch (e) {
      log(`lien ${n} impossible: ${e.message}`);
    }
  }
  return linked;
}

/** ah run <brief.md|-> */
export async function cmdRun(opts) {
  const cwd = process.cwd();
  const root = mainRoot(path.resolve(opts.repo || cwd));
  if (!root) die(`pas un dépôt git: ${path.resolve(opts.repo || cwd)} — fais \`git init\` + un premier commit (les worktrees en ont besoin).`);
  if (!hasCommit(root)) die('le dépôt n\'a aucun commit. Fais un premier commit.');
  if (!opts._[0]) die('usage: ah run <brief.md|-> [--acct a|b|auto] [--test "cmd"] [--title "..."]');

  const gcfg = loadGlobal();
  const rcfg = loadRepo(root);
  const brief = opts._[0] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(cwd, opts._[0]), 'utf8');
  if (!brief.trim()) die('brief vide');

  const title = titleOf(brief, opts.title);
  const id = `${timestampId()}-${slug(title, 28)}`;
  const branch = `agent/${id}`;
  const dir = ensureDir(runDirFor(root, id));
  const wt = worktreeFor(root, id);
  const testCmd = opts['no-tests'] ? null : opts.test || rcfg.test || null;

  let picked;
  try {
    picked = pickAccounts(gcfg, opts.acct);
  } catch (e) {
    die(e.message);
  }
  if (!picked.explicit && !picked.auto) {
    const until = limitedUntil(picked.list[0].name);
    if (until) {
      die(`le compte "${picked.list[0].name}" a atteint son quota (jusqu'à ${new Date(until).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}). Utilise --acct <autre> ou --acct auto.`, 2);
    }
  }

  const baseSha = headSha(root);
  const run = {
    id, title, dir, repoRoot: root, branch, base: baseSha, baseBranch: currentBranch(root), worktree: wt,
    account: null, status: 'running', pid: process.pid, startedAt: new Date().toISOString(),
    tests: { cmd: testCmd }, attempts: [], errors: [],
  };
  fs.writeFileSync(path.join(dir, 'brief.md'), brief);
  saveRun(run);

  log(`run ${id}`);
  addWorktree(root, wt, branch, baseSha);
  const notes = [];
  if (opts['include-dirty']) notes.push(...copyDirty(root, wt));
  else {
    const dirty = dirtySummary(root);
    if (dirty.length) notes.push(`⚠ ${dirty.length} modification(s) non commitée(s) dans le dépôt ne sont PAS dans le worktree (--include-dirty pour les inclure)`);
  }
  const linkNames = rcfg.link || [];
  for (const n of linkNames) excludeLocal(root, `/${n}`);
  const linked = linkDeps(root, wt, linkNames);
  run.linked = linked; // mémorisé pour que le nettoyage supprime les liens AVANT le worktree
  if (linked.length) notes.push(`dépendances liées: ${linked.join(', ')}`);
  notes.forEach((n) => log(n));
  run.notes = notes;

  const t0 = Date.now();
  if (rcfg.setup) {
    log(`setup: ${rcfg.setup}`);
    const s = await runShell(rcfg.setup, wt, gcfg.testTimeoutMin * 60_000, path.join(dir, 'setup.log'));
    if (s.code !== 0) log(`setup en échec (exit ${s.code}), on continue — voir setup.log`);
  }

  const prompt = buildPrompt({ brief, branch, test: testCmd });
  fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);

  let result = null;
  let usedAccount = null;
  for (const acct of picked.list) {
    usedAccount = acct.name;
    log(`codex (compte ${acct.name}) …`);
    result = await runCodex({
      home: acct.home, cwd: wt, prompt,
      sandbox: opts.sandbox || rcfg.sandbox,
      model: opts.model || gcfg.model, effort: opts.effort || gcfg.effort,
      useUserConfig: gcfg.useUserConfig, windowsSandbox: gcfg.windowsSandbox,
      timeoutMs: (opts.timeout ? +opts.timeout : gcfg.timeoutMin) * 60_000,
      jsonlFile: path.join(dir, 'events.jsonl'), stderrFile: path.join(dir, 'stderr.log'),
      lastFile: path.join(dir, 'last.txt'),
      onEvent: opts.verbose ? (ev) => log(`· ${ev.type}${ev.item ? ' ' + ev.item.type : ''}`) : undefined,
    });
    run.attempts.push({ account: acct.name, code: result.code, limited: result.limited, errors: result.errors });
    if (result.limited) {
      const until = parseResetTime(result.errors.join(' '));
      markLimited(acct.name, until);
      log(`compte ${acct.name}: quota atteint (jusqu'à ${new Date(until).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })})`);
      continue; // tente le compte suivant s'il y en a (mode auto)
    }
    break;
  }
  run.account = usedAccount;
  run.usage = result.usage;
  run.errors = result.errors;
  run.summary = result.finalMessage;

  // Verdict
  if (result.limited) run.status = 'limited';
  else if (result.timedOut) run.status = 'timeout';
  else if (result.code !== 0) run.status = 'failed';
  else run.status = 'completed';

  // Commit des changements de l'agent + diff
  const sha = commitAll(wt, `agent(${usedAccount}): ${title}\n\nagent-hub run ${id}`);
  run.commit = sha;
  run.changes = diffNumstat(root, baseSha, branch);
  if (run.changes.files.length) fs.writeFileSync(path.join(dir, 'diff.patch'), diffPatch(root, baseSha, branch));

  // Tests indépendants (on ne croit pas l'agent sur parole)
  if (testCmd && run.status === 'completed' && run.changes.files.length) {
    log(`tests: ${testCmd}`);
    const tr = await runShell(testCmd, wt, gcfg.testTimeoutMin * 60_000, path.join(dir, 'test.log'));
    run.tests = {
      cmd: testCmd, exit: tr.code, passed: tr.code === 0, timedOut: tr.timedOut,
      tail: tail(fs.readFileSync(path.join(dir, 'test.log'), 'utf8'), 25),
    };
  } else {
    run.tests = { cmd: testCmd, exit: null, passed: !testCmd, skipped: true };
  }

  // Rien produit et rien à garder : on nettoie
  if (!run.changes.files.length && run.status !== 'completed') {
    removeWorktree(root, wt, linked);
    deleteBranch(root, branch, true);
    run.cleaned = true;
  }

  run.endedAt = new Date().toISOString();
  run.durationSec = (Date.now() - t0) / 1000;
  run.pid = null;
  saveRun(run);
  report(run, opts);

  // 0 ok · 1 échec · 2 quota · 3 timeout · 10 terminé mais tests en échec
  const testsFailed = run.tests.cmd && !run.tests.skipped && !run.tests.passed;
  const codes = { completed: testsFailed ? 10 : 0, failed: 1, limited: 2, timeout: 3 };
  process.exit(codes[run.status] ?? 1);
}

function report(run, opts) {
  if (opts.json) {
    console.log(JSON.stringify(run, null, 2));
    return;
  }
  const icon = { completed: '✔', failed: '✘', limited: '⏸', timeout: '⏱' }[run.status] || '?';
  console.log(`\n${icon} ${run.id}  [${run.status}]  compte ${run.account}  ${fmtDuration(run.durationSec)}`);
  if (run.changes) console.log(`  changes  ${run.changes.files.length} fichier(s) +${run.changes.added}/-${run.changes.deleted}`);
  if (run.tests?.cmd) {
    console.log(`  tests    ${run.tests.cmd} -> ${run.tests.skipped ? 'non lancés' : run.tests.passed ? 'OK' : `ÉCHEC (exit ${run.tests.exit})`}`);
  }
  if (run.errors?.length) console.log(`  erreurs  ${run.errors.join(' | ')}`);
  if (run.summary) console.log(`\n${run.summary.split('\n').slice(0, 25).join('\n')}\n`);
  if (!run.cleaned) console.log(`  suite    ah show ${run.id} --patch | ah merge ${run.id} | ah clean ${run.id}`);
}
