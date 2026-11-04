# agent-hub (`ah`)

Dépôt : <https://github.com/moidefr/agent-hub> (privé) · dernière mise à jour de la doc : 04/11/2026 · 80 tests.

Permet à **Claude Code** de déléguer des tâches de code à **Codex (GPT, connexion OAuth ChatGPT)** et de
faire relire son travail par un second modèle, **dans n'importe quel dépôt git**, sans rien installer dans
les projets. Deux parties :

1. **Délégation** (`ah run`, `ah review`, `ah merge`…) : ChatGPT travaille à part, dans une copie du projet, puis tu relis et fusionnes.
2. **Coordination** (`ah serve`, `ah task`, `ah msg`…) : un dashboard local, des tâches partagées, des messages, une file d'attente.
   Voir [Coordination et dashboard](#coordination-et-dashboard-ah-serve).

```
Claude Code (chef de chantier : spécifie, relit, fusionne)
   │  skill /delegate  →  ah run brief.md
   ▼
ah ── git worktree isolé (agent/<id>) ── codex exec (compte ChatGPT A ou B, OAuth)
   │                                         │
   │◄── diff + tests relancés par le hub ◄───┘
   ▼
ah show --patch  →  relecture  →  ah merge   (ou ah clean)
```

- **OAuth uniquement** : le hub retire `OPENAI_API_KEY`/`CODEX_API_KEY` de l'environnement de Codex, il ne
  consomme que tes abonnements ChatGPT (jamais de facturation à l'API).
- **GitHub = dépôts uniquement** : aucune intégration Copilot. Le bus de communication, c'est git
  (branches `agent/*`, worktrees, `AGENTS.md`).
- **Zéro dépendance** : Node ≥ 20, git, Codex CLI.

## Installation (déjà faite sur ce PC)
```powershell
npm i -g @openai/codex          # Codex CLI
cd C:\Users\gabor\code\agent-hub
npm link                        # expose la commande `ah`
# skill pour Claude Code, valable pour tous les projets (junction vers ce dépôt) :
New-Item -ItemType Junction -Path $env:USERPROFILE\.claude\skills\delegate -Target (Resolve-Path skills\delegate)
ah doctor
```
Autre PC : cloner le dépôt, refaire ces 3 étapes, puis connecter les comptes.

## Comptes ChatGPT
Un compte = un dossier `CODEX_HOME`. Découverte automatique :

| Nom | Dossier | Origine |
|---|---|---|
| `a` | `~/.codex` | connexion de l'app/CLI Codex habituelle |
| autres | `~/.codex-accounts/<nom>` | `codex login --device-auth` avec `CODEX_HOME` pointant sur ce dossier |

Ajouter un compte `b` :
```powershell
$env:CODEX_HOME = "$HOME\.codex-accounts\b"
codex login --device-auth       # ouvre le lien dans une fenêtre privée, connecte le BON compte, saisis le code
```
`ah accounts` affiche l'état de connexion et les quotas atteints. Si deux dossiers contiennent en réalité le même
compte ChatGPT (même `account_id`, donc même quota — typique quand le navigateur était encore connecté au premier
compte), `ah` le signale (`⚠ MÊME compte…`), l'ignore et refuse `--acct <doublon>`. Les fichiers `auth.json` sont des secrets :
ils restent hors des dépôts.

**Quota** : Codex a une fenêtre de 5 h + un plafond hebdomadaire par compte. Quand il est atteint, `ah` le détecte
(« try again at 7:58 PM »), mémorise l'heure de reprise dans `~/.agent-hub/state.json` et sort avec le code 2.
Sans `--acct`, le compte par défaut (`defaultAccount`, sinon le premier) est utilisé ; s'il est épuisé, `ah` refuse
proprement en suggérant l'autre. La bascule **automatique** (`--acct auto`) est désactivée par défaut : active
`"autoRotate": true` dans `~/.agent-hub/config.json` uniquement après avoir vérifié les conditions d'utilisation d'OpenAI
sur l'usage de plusieurs comptes.

## Utilisation
```powershell
ah doctor                                   # diagnostic (node, git, codex, comptes, tests détectés)
ah init                                     # (optionnel) .agent-hub.json + AGENTS.md dans le dépôt courant
ah run brief.md --json                      # délègue ; "-" lit le brief sur stdin
ah run brief.md --acct b --effort high --test "npm run test:unit"
ah status                                   # runs du dépôt (--all : tous)
ah show <id> [--patch]                      # résumé / diff
ah review [<id>] [--base main] [--focus ".."] --json   # relecture read-only par Codex
ah merge <id> [--squash]                    # fusionne agent/<id> puis nettoie
ah clean [<id>]                             # supprime worktree (+ branche si fusionnée)
ah accounts
ah run brief.md --fix 2                     # nombre d'essais de correction automatique si les tests du hub échouent (0 = aucun)
ah run --continue <id> --answer "..."       # reprend un run qui a posé une QUESTION:
```
Codes de sortie de `ah run` : `0` ok · `1` échec · `2` quota atteint · `3` timeout · `4` question posée · `10` terminé mais tests en échec.

### Ce que fait `ah run`
1. Trouve le dépôt principal (même depuis un worktree), refuse proprement hors git ou sans commit.
2. Crée `~/.agent-hub/worktrees/<dépôt>/<id>` sur la branche `agent/<id>` à partir de `HEAD`
   (`--include-dirty` recopie les modifications locales non commitées).
3. Lie `node_modules` du dépôt dans le worktree s'il existe (junction), exécute `setup` si configuré.
4. Lance `codex exec --json -s workspace-write` dans le worktree : prompt sur **stdin**, `--ignore-user-config`
   (pas de plugins/MCP perso), `CODEX_HOME` du compte choisi, sandbox Windows `unelevated` (jamais d'UAC).
5. Commit les changements sur la branche (identité `agent-hub`), calcule le diff, **relance les tests lui-même**.
   Si ses tests échouent, Codex est relancé **une fois** avec le journal d'échec (interdiction de toucher aux tests) avant de te déranger
   (`--fix N`, `fixAttempts` dans la config).
6. Si Codex termine par une ligne `QUESTION: …`, le run passe en `needs-input` (code 4) et son worktree est conservé : `ah task answer`
   (ou `ah run --continue`) le reprend avec ta réponse.
7. Écrit tout dans `~/.agent-hub/runs/<dépôt>/<id>/` : `run.json`, `brief.md`, `prompt*.md`, `events*.jsonl`, `last*.txt`, `diff.patch`,
   `test.log`, `stderr*.log`, `progress.json` (progression en direct : commande en cours, fichiers touchés).
8. Avec `--sandbox read-only` (audit), rien n'est commité : le worktree et la branche sont supprimés, seul le rapport est gardé dans `run.json`.

### Fonctionne sur chaque projet
Aucune configuration requise. Détection automatique du type de projet et de la commande de tests :

| Fichier | Commande de test |
|---|---|
| `package.json` (`scripts.test`) | `npm test` / `pnpm test` / `yarn test` selon le lockfile |
| `pyproject.toml`, `pytest.ini`… + dossier `tests` | `python -m pytest -q` |
| `Cargo.toml` | `cargo test` |
| `go.mod` | `go test ./...` |
| `gradlew(.bat)` | `gradlew test` |
| `*.sln` / `*.csproj` | `dotnet test` |
| `Makefile` avec cible `test` | `make test` |

Surcharge par projet (optionnel) dans `<repo>/.agent-hub.json` :
```json
{ "test": "npm run test:unit", "setup": "npm ci", "link": ["node_modules"], "sandbox": "workspace-write" }
```
`"test": null` désactive les tests. Config globale optionnelle `~/.agent-hub/config.json` :
`accounts`, `defaultAccount`, `autoRotate`, `model`, `effort`, `timeoutMin`, `testTimeoutMin`, `windowsSandbox`
(`auto`|`elevated`|`unelevated`), `useUserConfig`.

## Coordination et dashboard (`ah serve`)
Un dashboard local (`http://127.0.0.1:4317/?t=<jeton>`) répond à une question : **« que dois-je faire maintenant ? »**.
- **Accueil** : ce qui attend ta décision (une question de ChatGPT, un travail à valider, un échec, des messages), ce qui tourne en direct, les projets.
- **Tâches** : rangées **par projet, puis par état** (attend ta réponse · à valider · à débloquer · en cours · en file · à faire · terminées).
- **Conversations** (tes sessions Claude, par projet), **ChatGPT** (comptes, quotas, travaux), **Messages**.

```bash
ah serve --open                       # ouvre le dashboard
ah task add "titre" --project . --assign codex:a --dep T-001
ah task next | claim | set T-001 --status review | dispatch T-001 --acct a
ah task queue T-001 T-002             # part toute seule dès qu'une place se libère (3 en parallèle)
ah wait T-001 T-002                   # attend la fin (à lancer en arrière-plan)
ah task answer T-001 "réponse"        # répond à la question d'un run ChatGPT
ah task results --json                # tous les rapports ; ah task archive --done pour ranger
ah msg send "<titre de session>" "texte" · ah msg inbox · ah say "ce que je fais"
ah lock · ah brief                    # « je travaille ici » · résumé de ce qui m'attend
```
- Détails, API et sécurité : [docs/COORDINATION.md](docs/COORDINATION.md). Fonctions avancées (file d'attente, correction automatique, questions,
  résultats, audits en lecture seule, réservations, archivage) : [docs/FONCTIONS-AVANCEES.md](docs/FONCTIONS-AVANCEES.md).
- Les sessions reçoivent leurs messages par des hooks Claude Code (`ah inbox --hook`, posés dans `~/.claude/settings.json`) ou en lançant
  `ah watch` avec l'outil Monitor. Le hook `SessionStart` (`ah brief --hook`) n'est **pas** posé : voir la procédure dans FONCTIONS-AVANCEES.
- Le dashboard ne peut pas réveiller une session inactive ; elle lit ses messages à son prochain tour.

## Sécurité
- Sandbox Codex `workspace-write` (écriture limitée au worktree) ; jamais de mode « bypass ».
- Les worktrees sont jetables ; le dépôt principal n'est modifié que par `ah merge`.
- Le prompt impose : rester dans le worktree, ne pas committer/pusher, pas de secrets, pas de réseau.
- La relecture (`ah review`) est en `read-only` ; le diff est traité comme donnée, pas comme instructions.
- Le hub ne fait **jamais** de `git push`.
- Le dashboard écoute uniquement sur `127.0.0.1`, exige un jeton (cookie `HttpOnly; SameSite=Strict`), vérifie l'hôte (anti DNS-rebinding)
  et l'origine des écritures (anti CSRF), n'expose jamais de chemins de fichiers et n'écrit dans le DOM que via `textContent`.
- Un lancement sur Codex ne part que sur ordre explicite (clic, `ah task dispatch`, ou `ah task queue`) ; la file respecte le maximum de 3
  runs en parallèle et le quota de chaque compte. **Attention** : un hub de démonstration (`AH_HOME` jetable) dont la file contient des tâches
  lancerait de vrais runs avec les comptes de `~/.codex` : y déclarer un compte factice non connecté.
- Les dépendances liées dans un worktree (junction `node_modules`) sont **retirées avant** toute suppression du worktree, et
  leur cible n'est jamais touchée. Correctif du 27/10/2026 : avant lui, `ah merge`/`ah clean` pouvait vider le `node_modules`
  du dépôt principal sous Windows (test de régression dans `test/pipeline.test.mjs`).

## Validé en réel (27/10/2026)
Avec le vrai Codex 0.164 (compte `b`, sandbox `unelevated`) : `ah run` (tâche triviale puis tâche réelle avec tests : 23 tests
unitaires écrits en 1 min 21), `ah show --patch`, `ah review` (verdict structuré), `ah merge` (worktree et branche nettoyés).
La détection de quota a été vérifiée sur le compte épuisé (message « try again at … » → statut `limited`, code 2).

**Coordination (01/11/2026)** : deux sessions Claude et Codex sur deux tâches liées (le lancement trop tôt est refusé, la réponse de Codex
réveille la session, relecture, fusion) ; relecture de sécurité du serveur par Codex (4 défauts moyens trouvés et corrigés) ; six audits de
dépôts en lecture seule par Codex (≈ 1 min chacun) enregistrés comme résultats de tâches.

## Limites connues
- Dans le sandbox `unelevated`, Codex ne peut pas toujours lancer `npm` lui-même (lanceur npm introuvable) : il se rabat sur
  `node --test`. Ce n'est pas bloquant car le hub relance les tests de son côté après le run, et c'est son verdict qui compte.
- Un seul agent exécutant (Codex) : Claude Code est le chef, il n'est pas dispatchable par `ah` (piste v2 : adaptateur `claude -p`).
- Les dépendances autres que `node_modules` (venv Python, `target/`…) ne sont pas partagées : utilise `setup`.
- Les fichiers non suivis ignorés par git (`.env`, builds) ne sont pas présents dans le worktree, c'est voulu.
- Sandbox Windows : `ah` force `unelevated` (réglage `windowsSandbox: "auto"` = `unelevated`). Le mode `elevated` ne
  s'active que si on écrit `"windowsSandbox": "elevated"` : il déclenche la fenêtre UAC « codex-windows-sandbox-setup.exe »
  presque à chaque commande (constaté le 2026-10-27 avec le compte `a` sur un projet à nombreux runs).

## Développement
```powershell
npm test       # 80 tests : pipeline complet avec un faux codex (test/fake-codex.mjs), aucun quota consommé
```
Structure :
- Délégation : `bin/ah.mjs` (CLI) · `lib/run.mjs` (run, correction automatique, questions) · `lib/review.mjs` · `lib/runs.mjs` (status/show/merge/clean) ·
  `lib/codex.mjs` (lancement Codex, OAuth) · `lib/accounts.mjs` (comptes, quotas) · `lib/detect.mjs` · `lib/git.mjs` · `lib/progress.mjs` (progression en direct).
- Coordination : `lib/bus.mjs` (tâches, messages, file d'attente, verrous : fichiers sous `~/.agent-hub/bus`) · `lib/coord.mjs` (identité, état du dashboard,
  lancement, file) · `lib/sessions.mjs` (lecture des sessions Claude) · `lib/server.mjs` (dashboard sécurisé) · `lib/coord-cli.mjs`, `lib/coord-cmds.mjs` (commandes).
- Interface : `ui/` (`app.js`, `lib.js` pur et testé, `style.css`, `icons.js`, aucune dépendance).
- `skills/delegate/SKILL.md` (mode d'emploi pour Claude Code) · `docs/` (coordination, fonctions avancées).
