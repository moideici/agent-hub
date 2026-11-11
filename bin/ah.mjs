#!/usr/bin/env node
import { cmdRun } from '../lib/run.mjs';
import { cmdReview } from '../lib/review.mjs';
import { cmdStatus, cmdShow, cmdMerge, cmdClean } from '../lib/runs.mjs';
import { cmdAccounts, cmdDoctor, cmdInit } from '../lib/admin.mjs';
import { cmdTask, cmdMsg, cmdSay, cmdWatch, cmdInboxHook, cmdWhoami, cmdServe } from '../lib/coord-cli.mjs';
import { cmdQueue, cmdWait, cmdLock, cmdBrief } from '../lib/coord-cmds.mjs';
import { cmdGpu, cmdOllama, cmdBench } from '../lib/ollama-cmds.mjs';

const HELP = `ah — agent-hub : délègue des tâches de code à Codex (GPT, OAuth ChatGPT) dans des worktrees git isolés.

Usage:
  ah run <brief.md|->   [--acct a|b|auto] [--test "cmd"] [--no-tests] [--title "..."]
                        [--include-dirty] [--sandbox workspace-write|read-only] [--model M] [--effort E]
                        [--timeout MIN] [--repo DIR] [--json] [--verbose] [--fix N]
  ah run --continue <runId> --answer "…"                    reprend un run qui a posé une question
  ah review [runId]     [--base REF] [--focus "..."] [--acct a|b|auto] [--json]   relecture read-only par Codex
  ah status             [--all] [--json]                    liste les runs
  ah show <runId>       [--patch] [--json]
  ah merge <runId>      [--squash] [--force]                fusionne la branche agent/<id> puis nettoie
  ah clean [runId]      [--force] [--all]                   supprime worktree (+ branche si fusionnée)
  ah accounts                                               comptes ChatGPT/Codex, quotas
  ah doctor                                                 diagnostic
  ah init                                                   crée .agent-hub.json + AGENTS.md dans le dépôt

Coordination (sessions Claude, Codex, utilisateur) :
  ah serve              [--port 4317] [--open]              dashboard web sur localhost (URL avec jeton)
  ah task add "titre"   [--brief texte|fichier|-] [--project DIR] [--assign qui] [--dep T-1,T-2] [--prio 0-3]
  ah task list|show|next|claim|set|dispatch                 tâches partagées (dispatch = lance Codex)
  ah task queue T-1 [T-2] [--acct a|b|any]                  en file : part toute seule dès qu'une place se libère
  ah task answer T-1 "réponse"                              répond à la question d'un run Codex
  ah task escalate T-1 [--acct a|b] | --dismiss             envoie à ChatGPT une tâche qu'un modèle local a ratée (après ta vérification)
  ah run … --acct 9b|27b|local                              même chose avec un modèle local (Ollama), un seul à la fois
  ah gpu                                                    mémoire de la carte et qui l'occupe
  ah ollama status | setup [nom] | smoke [nom]              état, préparation (modèles dérivés), essai rapide
  ah bench run --models 9b,27b [--levels 0-6] [--tasks ids] benchmark des modèles locaux (bench/ollama/tasks)
  ah task result T-1 [--text …] [--data f.json] · results    résultat structuré d'une tâche
  ah task archive T-1 | archive --done · unarchive · delete --yes
  ah queue [pump]                                           état de la file d'attente
  ah wait T-1 [T-2] [--any] [--timeout MIN]                 attend la fin (à lancer en arrière-plan)
  ah lock [dossier] [--note …] · lock list · unlock         « je travaille sur ce projet » (consultatif)
  ah brief                                                  résumé pour moi (tâches, réponses attendues, messages)
  ah msg send <à> "texte" [--task T-1] · ah msg inbox [--peek] · ah msg list
  ah say "ce que je fais" [--task T-1]                      statut visible dans le dashboard
  ah watch                                                  flux des messages (avec Monitor : réveille la session)
  ah whoami                                                 identité de l'appelant
  <à> = user · * · codex:a · codex:b · titre ou id d'une session Claude

Codes de sortie de \`run\`: 0 ok · 1 échec · 2 quota atteint · 3 timeout · 4 question posée · 10 terminé mais tests en échec
Le brief "-" est lu sur stdin.`;

const BOOL = new Set([
  'json', 'help', 'include-dirty', 'no-tests', 'squash', 'force', 'all', 'patch', 'verbose', 'peek', 'hook', 'open', 'no-escalate',
  'any', 'done', 'yes', 'archived', 'dismiss', 'keep',
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
    case 'task': cmdTask(opts); break;
    case 'msg': cmdMsg(opts); break;
    case 'say': cmdSay(opts); break;
    case 'watch': await cmdWatch(opts); break;
    case 'inbox': if (opts.hook) cmdInboxHook(); else cmdMsg({ ...opts, _: ['inbox'] }); break;
    case 'whoami': cmdWhoami(); break;
    case 'serve': await cmdServe(opts); break;
    case 'queue': cmdQueue(opts); break;
    case 'wait': await cmdWait(opts); break;
    case 'lock': cmdLock(opts); break;
    case 'unlock': cmdLock(opts, true); break;
    case 'brief': cmdBrief(opts); break;
    case 'gpu': await cmdGpu(opts); break;
    case 'ollama': await cmdOllama(opts); break;
    case 'bench': await cmdBench(opts); break;
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
