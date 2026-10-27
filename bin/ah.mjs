#!/usr/bin/env node
import { cmdRun } from '../lib/run.mjs';
import { cmdReview } from '../lib/review.mjs';
import { cmdStatus, cmdShow, cmdMerge, cmdClean } from '../lib/runs.mjs';
import { cmdAccounts, cmdDoctor, cmdInit } from '../lib/admin.mjs';

const HELP = `ah — agent-hub : délègue des tâches de code à Codex (GPT, OAuth ChatGPT) dans des worktrees git isolés.

Usage:
  ah run <brief.md|->   [--acct a|b|auto] [--test "cmd"] [--no-tests] [--title "..."]
                        [--include-dirty] [--sandbox workspace-write|read-only] [--model M] [--effort E]
                        [--timeout MIN] [--repo DIR] [--json] [--verbose]
  ah review [runId]     [--base REF] [--focus "..."] [--acct a|b|auto] [--json]   relecture read-only par Codex
  ah status             [--all] [--json]                    liste les runs
  ah show <runId>       [--patch] [--json]
  ah merge <runId>      [--squash] [--force]                fusionne la branche agent/<id> puis nettoie
  ah clean [runId]      [--force] [--all]                   supprime worktree (+ branche si fusionnée)
  ah accounts                                               comptes ChatGPT/Codex, quotas
  ah doctor                                                 diagnostic
  ah init                                                   crée .agent-hub.json + AGENTS.md dans le dépôt

Codes de sortie de \`run\`: 0 ok · 1 échec · 2 quota atteint · 3 timeout · 10 terminé mais tests en échec
Le brief "-" est lu sur stdin.`;

const BOOL = new Set([
  'json', 'help', 'include-dirty', 'no-tests', 'squash', 'force', 'all', 'patch', 'verbose',
]);

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-') o._.push(a);
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) o[k] = v;
      else if (BOOL.has(k)) o[k] = true;
      else o[k] = argv[++i];
    } else o._.push(a);
  }
  return o;
}

const [cmd, ...rest] = process.argv.slice(2);
const opts = parse(rest);

try {
  switch (cmd) {
    case 'run': await cmdRun(opts); break;
    case 'review': await cmdReview(opts); break;
    case 'status': cmdStatus(opts); break;
    case 'show': cmdShow(opts); break;
    case 'merge': cmdMerge(opts); break;
    case 'clean': cmdClean(opts); break;
    case 'accounts': cmdAccounts(opts); break;
    case 'doctor': cmdDoctor(opts); break;
    case 'init': cmdInit(opts); break;
    case undefined: case 'help': case '--help': case '-h': console.log(HELP); break;
    default:
      console.error(`commande inconnue: ${cmd}\n`);
      console.error(HELP);
      process.exit(1);
  }
} catch (e) {
  console.error(`ah: ${e.message}`);
  process.exit(1);
}
