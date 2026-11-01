import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { die, ensureDir, fmtDuration, log, slug, tail, timestampId } from './util.mjs';
import { loadGlobal, loadRepo } from './config.mjs';
import { pickAccounts, limitedUntil, markLimited, parseResetTime } from './accounts.mjs';
import { runCodex, killTree } from './codex.mjs';
import {
  mainRoot, hasCommit, headSha, currentBranch, addWorktree, removeWorktree, deleteBranch,
  excludeLocal, commitAll, diffNumstat, diffPatch, copyDirty, dirtySummary,
} from './git.mjs';
import { runDirFor, worktreeFor, saveRun, findRun } from './runs.mjs';
import { onRunStarted, onRunFinished, failTaskIfNotStarted } from './bus.mjs';
import { makeProgress } from './progress.mjs';

const RULES = (branch) => `Rules:
- Work only inside the current directory: it is an isolated git worktree on branch "${branch}". Never read or modify files outside it.
- Do NOT run git commit, push, merge, checkout or branch commands. Leave your changes uncommitted; the hub commits them.
- Do not install global tools, do not touch credentials or .env files, and do not use the network unless the task requires it.
- Follow the conventions in AGENTS.md / CLAUDE.md / README if they exist.
- Stay strictly in scope. If the task is blocked or lacks information you cannot safely guess, make no risky change and end your final message with a line starting with "QUESTION:" followed by ONE precise question; the orchestrator will answer and you will be resumed.`;

export function buildPrompt({ brief, branch, test, previous = null }) {
  const resumed = previous
    ? `\n# Previous exchange\nYou already worked on this task: your earlier changes are in the worktree. You asked:\n${previous.question}\n\nThe orchestrator answered:\n${previous.answer}\n\nContinue the task with this answer.\n`
    : '';
  return `You are a worker agent dispatched by "agent-hub". An orchestrator agent wrote the task below and will review your work afterwards.

${RULES(branch)}
${test ? `- Verify your work by running: ${test}\n` : '- No automatic test command is configured; verify your work as best you can.\n'}
Your final message must contain: (1) what you changed, file by file; (2) how you verified it and the result; (3) anything uncertain, skipped or left unfinished.
${resumed}
# Task

${brief.trim()}
`;
}

/** Prompt de correction : les tests du hub ont échoué après le travail de Codex. */
export function buildFixPrompt({ brief, branch, test, output, attempt }) {
  return `You are a worker agent dispatched by "agent-hub". Your previous work on the task below is in the worktree, but the hub ran the project's tests independently and they FAIL (automatic correction attempt ${attempt}).

${RULES(branch)}
- Fix the code so the tests pass. Do NOT modify, delete, skip or weaken tests, and do not change the test command.

Test command: ${test}

Failing output (tail):
\`\`\`
${output}
\`\`\`

Your final message must say what was wrong and what you changed.

# Original task

${brief.trim()}
`;
}

/** Dernière « QUESTION: … » de la réponse finale de l'agent, ou null. */
export function extractQuestion(text) {
  const s = String(text || '');
  const i = s.lastIndexOf('QUESTION:');
  if (i < 0 || (i > 0 && s[i - 1] !== '\n')) return null;
  return s.slice(i + 'QUESTION:'.length).trim() || null;
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

const readTextOrFile = (v) => (fs.existsSync(v) && fs.statSync(v).isFile() ? fs.readFileSync(v, 'utf8') : String(v));

/** ah run <brief.md|-> [...]  ·  ah run --continue <runId> --answer "..." */
export async function cmdRun(opts) {
  if (opts.task) {
    // Si le run meurt avant d'avoir démarré (dépôt invalide, brief manquant…), la tâche liée ne doit pas rester "running".
    process.on('exit', (code) => {
      if (code) {
        try { failTaskIfNotStarted(opts.task, `ah run a échoué avant de démarrer (code ${code}); voir bus/briefs/${opts.task}.log`); } catch { /* le bus est illisible : rien à faire */ }
      }
    });
  }
  const cwd = process.cwd();

  // Reprise d'un run qui avait posé une question
  let cont = null;
  if (opts.continue) {
    const old = findRun(opts.continue);
    if (old.status !== 'needs-input') die(`le run ${old.id} n'attend pas de réponse (statut "${old.status}")`);
    if (!old.worktree || !fs.existsSync(old.worktree)) die(`le worktree du run ${old.id} n'existe plus : impossible de le reprendre`);
    if (!opts.answer || !String(opts.answer).trim()) die('--answer "ta réponse" requis avec --continue');
    cont = { run: old, answer: readTextOrFile(opts.answer) };
  }

  const root = cont ? cont.run.repoRoot : mainRoot(path.resolve(opts.repo || cwd));
  if (!root) die(`pas un dépôt git: ${path.resolve(opts.repo || cwd)} — fais \`git init\` + un premier commit (les worktrees en ont besoin).`);
  if (!hasCommit(root)) die('le dépôt n\'a aucun commit. Fais un premier commit.');
  if (!cont && !opts._[0]) die('usage: ah run <brief.md|-> [--acct a|b|auto] [--test "cmd"] [--title "..."]');

  const gcfg = loadGlobal();
  const rcfg = loadRepo(root);
  const brief = cont ? fs.readFileSync(path.join(cont.run.dir, 'brief.md'), 'utf8') : opts._[0] === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(cwd, opts._[0]), 'utf8');
  if (!brief.trim()) die('brief vide');

  const title = cont ? cont.run.title : titleOf(brief, opts.title);
  const id = cont ? cont.run.id : `${timestampId()}-${slug(title, 28)}`;
  const branch = cont ? cont.run.branch : `agent/${id}`;
  const dir = cont ? cont.run.dir : ensureDir(runDirFor(root, id));
  const wt = cont ? cont.run.worktree : worktreeFor(root, id);
  const testCmd = opts['no-tests'] ? null : opts.test || (cont ? cont.run.tests?.cmd : null) || rcfg.test || null;
  const readOnly = (cont ? cont.run.readOnly : (opts.sandbox || rcfg.sandbox) === 'read-only') || false;
  const sandbox = readOnly ? 'read-only' : opts.sandbox || rcfg.sandbox;
  const maxFix = opts.fix != null ? +opts.fix : gcfg.fixAttempts ?? 1;

  let picked;
  try {
    picked = pickAccounts(gcfg, opts.acct || (cont ? cont.run.account : undefined));
  } catch (e) {
    die(e.message);
  }
  if (!picked.explicit && !picked.auto) {
    const until = limitedUntil(picked.list[0].name);
    if (until) {
      die(`le compte "${picked.list[0].name}" a atteint son quota (jusqu'à ${new Date(until).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}). Utilise --acct <autre> ou --acct auto.`, 2);
    }
  }

  const baseSha = cont ? cont.run.base : headSha(root);
  const run = cont
    ? { ...cont.run, status: 'running', pid: process.pid, resumedAt: new Date().toISOString(), errors: [], taskId: opts.task || cont.run.taskId || null, history: [...(cont.run.history || []), { question: cont.run.question, answer: cont.answer, at: new Date().toISOString() }], question: null }
    : {
      id, title, dir, repoRoot: root, branch, base: baseSha, baseBranch: currentBranch(root), worktree: wt,
      account: null, status: 'running', pid: process.pid, startedAt: new Date().toISOString(),
      tests: { cmd: testCmd }, attempts: [], errors: [], taskId: opts.task || null, readOnly,
    };
  if (!cont) fs.writeFileSync(path.join(dir, 'brief.md'), brief);
  saveRun(run);
  try { onRunStarted(run); } catch (e) { log(`lien tâche: ${e.message}`); }

  log(`run ${id}${cont ? ' (reprise)' : ''}`);
  let linked = run.linked || [];
  if (!cont) {
    addWorktree(root, wt, branch, baseSha);
    const notes = [];
    if (opts['include-dirty']) notes.push(...copyDirty(root, wt));
    else {
      const dirty = dirtySummary(root);
      if (dirty.length) notes.push(`⚠ ${dirty.length} modification(s) non commitée(s) dans le dépôt ne sont PAS dans le worktree (--include-dirty pour les inclure)`);
    }
    const linkNames = rcfg.link || [];
    for (const n of linkNames) excludeLocal(root, `/${n}`);
    linked = linkDeps(root, wt, linkNames);
    run.linked = linked; // mémorisé pour que le nettoyage supprime les liens AVANT le worktree
    if (linked.length) notes.push(`dépendances liées: ${linked.join(', ')}`);
    notes.forEach((n) => log(n));
    run.notes = notes;
  }

  const t0 = Date.now();
  if (rcfg.setup && !cont) {
    log(`setup: ${rcfg.setup}`);
    const s = await runShell(rcfg.setup, wt, gcfg.testTimeoutMin * 60_000, path.join(dir, 'setup.log'));
    if (s.code !== 0) log(`setup en échec (exit ${s.code}), on continue — voir setup.log`);
  }

  const progress = makeProgress(path.join(dir, 'progress.json'), wt);
  const verbose = opts.verbose ? (ev) => log(`· ${ev.type}${ev.item ? ' ' + ev.item.type : ''}`) : null;
  let seq = run.attempts.length; // numérote les fichiers de journal : events.jsonl, events-1.jsonl…
  const codexOnce = async (acct, prompt, kind) => {
    const n = seq++;
    const suffix = n === 0 ? '' : `-${n}`;
    fs.writeFileSync(path.join(dir, `prompt${suffix}.md`), prompt);
    return runCodex({
      home: acct.home, cwd: wt, prompt, sandbox,
      model: opts.model || gcfg.model, effort: opts.effort || gcfg.effort,
      useUserConfig: gcfg.useUserConfig, windowsSandbox: gcfg.windowsSandbox,
      timeoutMs: (opts.timeout ? +opts.timeout : gcfg.timeoutMin) * 60_000,
      jsonlFile: path.join(dir, `events${suffix}.jsonl`), stderrFile: path.join(dir, `stderr${suffix}.log`),
      lastFile: path.join(dir, `last${suffix}.txt`),
      onEvent: (ev) => { progress.feed(ev); verbose?.(ev); },
      kind,
    });
  };

  const prompt = buildPrompt({ brief, branch, test: testCmd, previous: cont ? { question: cont.run.question, answer: cont.answer } : null });

  let result = null;
  let usedAccount = null;
  for (const acct of picked.list) {
    usedAccount = acct.name;
    log(`codex (compte ${acct.name}) …`);
    result = await codexOnce(acct, prompt, cont ? 'resume' : 'main');
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

  const question = run.status === 'completed' ? extractQuestion(result.finalMessage) : null;
  if (question) {
    run.status = 'needs-input';
    run.question = question;
  }

  // Commit des changements + diff (un audit en lecture seule ne garde rien : les fichiers recopiés par --include-dirty n'ont rien à faire dans un commit)
  const snapshot = () => {
    if (readOnly) {
      run.commit = null;
      run.changes = { files: [], added: 0, deleted: 0 };
      return;
    }
    run.commit = commitAll(wt, `agent(${usedAccount}): ${title}\n\nagent-hub run ${id}`);
    run.changes = diffNumstat(root, baseSha, branch);
    if (run.changes.files.length) fs.writeFileSync(path.join(dir, 'diff.patch'), diffPatch(root, baseSha, branch));
  };
  // Tests indépendants (on ne croit pas l'agent sur parole)
  const verify = async () => {
    if (testCmd && run.status === 'completed' && run.changes.files.length) {
      progress.set({ phase: 'tests' });
      log(`tests: ${testCmd}`);
      const tr = await runShell(testCmd, wt, gcfg.testTimeoutMin * 60_000, path.join(dir, 'test.log'));
      run.tests = {
        cmd: testCmd, exit: tr.code, passed: tr.code === 0, timedOut: tr.timedOut,
        tail: tail(fs.readFileSync(path.join(dir, 'test.log'), 'utf8'), 25),
      };
    } else {
      run.tests = { cmd: testCmd, exit: null, passed: !testCmd, skipped: true };
    }
  };

  snapshot();
  if (run.status !== 'needs-input') await verify();

  // Correction automatique : si les tests du hub échouent, Codex reçoit le journal d'échec (nombre d'essais plafonné)
  const needsFix = () => !readOnly && run.status === 'completed' && testCmd && run.tests && !run.tests.skipped && !run.tests.passed && !run.tests.timedOut;
  let fixTry = 0;
  while (needsFix() && fixTry < maxFix) {
    fixTry++;
    run.fixes = (run.fixes || 0) + 1;
    progress.set({ phase: `correction ${fixTry}/${maxFix}` });
    log(`tests en échec : correction automatique ${fixTry}/${maxFix}`);
    const failing = tail(fs.readFileSync(path.join(dir, 'test.log'), 'utf8'), 80);
    const acct = picked.list.find((a) => a.name === usedAccount) || picked.list[0];
    const r = await codexOnce(acct, buildFixPrompt({ brief, branch, test: testCmd, output: failing, attempt: fixTry }), 'fix');
    run.attempts.push({ account: acct.name, code: r.code, limited: r.limited, errors: r.errors, kind: 'fix' });
    if (r.limited) markLimited(acct.name, parseResetTime(r.errors.join(' ')));
    if (r.limited || r.timedOut || r.code !== 0) {
      run.errors = [...run.errors, ...r.errors];
      break;
    }
    run.summary = `${run.summary}\n\n[Correction automatique ${fixTry}] ${r.finalMessage}`;
    snapshot();
    await verify();
  }

  // Rien à garder (échec sans changement, ou audit en lecture seule terminé) : on nettoie. Un run qui attend une réponse garde son worktree.
  if (run.status !== 'needs-input' && (readOnly || (!run.changes.files.length && run.status !== 'completed'))) {
    removeWorktree(root, wt, linked);
    deleteBranch(root, branch, true);
    run.cleaned = true;
  }

  run.endedAt = new Date().toISOString();
  run.durationSec = (run.durationSec || 0) + (Date.now() - t0) / 1000;
  run.pid = null;
  progress.set({ phase: 'terminé' });
  saveRun(run);
  try { onRunFinished(run); } catch (e) { log(`lien tâche: ${e.message}`); }
  report(run, opts);
  try {
    // Une place vient de se libérer : on lance la tâche suivante de la file d'attente, s'il y en a une
    const { pumpQueue } = await import('./coord.mjs');
    pumpQueue();
  } catch (e) {
    log(`file d'attente: ${e.message}`);
  }

  // 0 ok · 1 échec · 2 quota · 3 timeout · 4 question posée · 10 terminé mais tests en échec
  const testsFailed = run.tests.cmd && !run.tests.skipped && !run.tests.passed;
  const codes = { completed: testsFailed ? 10 : 0, failed: 1, limited: 2, timeout: 3, 'needs-input': 4 };
  process.exit(codes[run.status] ?? 1);
}

function report(run, opts) {
  if (opts.json) {
    console.log(JSON.stringify(run, null, 2));
    return;
  }
  const icon = { completed: '✔', failed: '✘', limited: '⏸', timeout: '⏱', 'needs-input': '?' }[run.status] || '?';
  console.log(`\n${icon} ${run.id}  [${run.status}]  compte ${run.account}  ${fmtDuration(run.durationSec)}`);
  if (run.changes) console.log(`  changes  ${run.changes.files.length} fichier(s) +${run.changes.added}/-${run.changes.deleted}`);
  if (run.tests?.cmd) {
    console.log(`  tests    ${run.tests.cmd} -> ${run.tests.skipped ? 'non lancés' : run.tests.passed ? 'OK' : `ÉCHEC (exit ${run.tests.exit})`}`);
  }
  if (run.fixes) console.log(`  correction automatique: ${run.fixes} essai(s)`);
  if (run.errors?.length) console.log(`  erreurs  ${run.errors.join(' | ')}`);
  if (run.summary) console.log(`\n${run.summary.split('\n').slice(0, 25).join('\n')}\n`);
  if (run.status === 'needs-input') console.log(`  question  ${run.question}\n  réponse   ah run --continue ${run.id} --answer "..."`);
  else if (!run.cleaned) console.log(`  suite    ah show ${run.id} --patch | ah merge ${run.id} | ah clean ${run.id}`);
}
