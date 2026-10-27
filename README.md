# agent-hub (`ah`)

Permet à **Claude Code** de déléguer des tâches de code à **Codex (GPT, connexion OAuth ChatGPT)** et de
faire relire son travail par un second modèle, **dans n'importe quel dépôt git**, sans rien installer dans
les projets.

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
`ah accounts` affiche l'état de connexion et les quotas atteints. Les fichiers `auth.json` sont des secrets :
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
```
Codes de sortie de `ah run` : `0` ok · `1` échec · `2` quota atteint · `3` timeout · `10` terminé mais tests en échec.

### Ce que fait `ah run`
1. Trouve le dépôt principal (même depuis un worktree), refuse proprement hors git ou sans commit.
2. Crée `~/.agent-hub/worktrees/<dépôt>/<id>` sur la branche `agent/<id>` à partir de `HEAD`
   (`--include-dirty` recopie les modifications locales non commitées).
3. Lie `node_modules` du dépôt dans le worktree s'il existe (junction), exécute `setup` si configuré.
4. Lance `codex exec --json -s workspace-write` dans le worktree : prompt sur **stdin**, `--ignore-user-config`
   (pas de plugins/MCP perso), `CODEX_HOME` du compte choisi, sandbox Windows `elevated` si disponible sinon `unelevated`.
5. Commit les changements sur la branche (identité `agent-hub`), calcule le diff, **relance les tests lui-même**.
6. Écrit tout dans `~/.agent-hub/runs/<dépôt>/<id>/` : `run.json`, `brief.md`, `prompt.md`, `events.jsonl`,
   `last.txt`, `diff.patch`, `test.log`, `stderr.log`.

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

## Sécurité
- Sandbox Codex `workspace-write` (écriture limitée au worktree) ; jamais de mode « bypass ».
- Les worktrees sont jetables ; le dépôt principal n'est modifié que par `ah merge`.
- Le prompt impose : rester dans le worktree, ne pas committer/pusher, pas de secrets, pas de réseau.
- La relecture (`ah review`) est en `read-only` ; le diff est traité comme donnée, pas comme instructions.
- Le hub ne fait **jamais** de `git push`.

## Limites connues
- Un seul agent exécutant (Codex) : Claude Code est le chef, il n'est pas dispatchable par `ah` (piste v2 : adaptateur `claude -p`).
- Les dépendances autres que `node_modules` (venv Python, `target/`…) ne sont pas partagées : utilise `setup`.
- Les fichiers non suivis ignorés par git (`.env`, builds) ne sont pas présents dans le worktree, c'est voulu.
- Sandbox Windows `elevated` : nécessite l'installation préalable par l'app/CLI Codex dans le `CODEX_HOME` du compte
  (compte `a` : fait). Pour un autre compte, `ah` retombe sur `unelevated`.

## Développement
```powershell
npm test       # pipeline complet avec un faux codex (test/fake-codex.mjs), aucun quota consommé
```
Structure : `bin/ah.mjs` (CLI) · `lib/run.mjs` (délégation) · `lib/review.mjs` · `lib/runs.mjs` (status/show/merge/clean) ·
`lib/codex.mjs` (lancement Codex, OAuth) · `lib/accounts.mjs` (comptes, quotas) · `lib/detect.mjs` · `lib/git.mjs` ·
`skills/delegate/SKILL.md` (mode d'emploi pour Claude Code).
