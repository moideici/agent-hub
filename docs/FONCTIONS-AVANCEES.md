# Fonctions avancées de la coordination

Complète [COORDINATION.md](COORDINATION.md). Tout ce qui suit marche depuis la ligne de commande (`ah`) et, quand c'est dit, depuis le dashboard.

## États d'une tâche
`todo` (à faire) · `queued` (en file d'attente) · `claimed` (prise) · `running` (en cours) · `waiting` (ChatGPT attend ta réponse) ·
`review` (à valider) · `done` · `failed` · `blocked`. Le dashboard les affiche dans cet ordre d'urgence, projet par projet.

## File d'attente et attente
- `ah task queue T-001 [T-002 …] [--acct a|b|any]` : la tâche part **toute seule** sur ChatGPT dès qu'une place se libère
  (3 travaux en parallèle au maximum, compte disponible le moins chargé, plus prioritaire d'abord, dépendances terminées).
  La file avance à la mise en file, à la fin de chaque run, et toutes les 5 s tant que le dashboard (`ah serve`) tourne.
- `ah queue` : état de la file (et lancement de ce qui peut partir). `ah task unqueue T-001` la retire.
- `ah wait T-001 [T-002 …] [--any] [--timeout MIN]` : attend que les tâches soient posées (à valider, terminées, en échec, bloquées ou en
  attente d'une réponse). Sortie 0 si tout va bien, 1 en cas d'échec ou de blocage, 3 au délai, 4 si ChatGPT attend une réponse.
  À lancer avec `run_in_background` : une seule notification à la fin.

## Correction automatique
Quand les tests du hub échouent après le travail de ChatGPT, il est relancé **une fois** avec le journal d'échec (interdiction de toucher
aux tests) avant de te déranger. `--fix N` change le nombre d'essais (`0` désactive), `fixAttempts` dans `~/.agent-hub/config.json` le défaut.
Le run garde `fixes` (nombre d'essais) et chaque essai est tracé (`prompt-N.md`, `events-N.jsonl`).

## Question de ChatGPT et reprise
Si une information indispensable manque, ChatGPT termine par une ligne `QUESTION: …` : le run passe en `needs-input`, la tâche en `waiting`,
le worktree est conservé et l'auteur reçoit un message (`kind: "ask"`). Réponse : `ah task answer T-001 "…"` (ou le champ de réponse du
dashboard) : le même run repart avec ta réponse (`ah run --continue <runId> --answer "…"`). Code de sortie du run : 4.

## Résultats structurés
`task.result = { text, data, at, by, runId }`. Un run lié à une tâche y met son rapport (et le dernier bloc ```json qu'il contient dans `data`).
`ah task result T-001 [--text …] [--data fichier.json]` lit ou écrit ; `ah task results [--json]` liste tous les résultats ;
`GET /api/tasks/<id>` donne le texte complet (l'état du dashboard n'en garde qu'un extrait).

## Progression en direct
Chaque run écrit `progress.json` (phase, commande en cours, fichiers touchés, dernier message). Le dashboard l'affiche sur les tâches
et travaux en cours (« Exécute : … »).

## Audit en lecture seule
`ah task add … --sandbox read-only --include-dirty` (ou la case du formulaire) : ChatGPT lit le projet, modifications non commitées comprises,
sans rien changer. Aucun commit, aucune branche, aucun worktree ne reste ; le rapport est dans le résultat de la tâche.

## Réservations de projet (consultatives)
`ah lock [dossier] [--note "…"]`, `ah lock list`, `ah unlock [dossier]` : « je travaille sur ce projet ». Expire après 6 h. Rien n'est bloqué :
le dashboard signale seulement quand **plusieurs agents** (conversations actives, travaux ChatGPT, réservations) sont sur le même projet,
et `ah task dispatch` ajoute une note d'avertissement si le projet est réservé par quelqu'un d'autre.

## Résumé de démarrage
`ah brief` résume pour l'agent courant : réponses attendues, travaux à valider, tâches en cours, travaux lancés, messages non lus, projets réservés.
`ah brief --hook` produit le JSON d'un hook `SessionStart` de Claude Code (silencieux s'il n'y a rien à dire) :

```json
"SessionStart": [
  { "hooks": [ { "type": "command", "command": "node \"C:/Users/gabor/code/agent-hub/bin/ah.mjs\" brief --hook" } ] }
]
```
À ajouter dans `~/.claude/settings.json` sous `hooks` (à côté de `UserPromptSubmit` et `PostToolUse`). Il se déclenche aussi après une compaction.

## Archivage
`ah task archive T-001 …`, `ah task archive --done [--project DIR]`, `ah task unarchive`, `ah task list --archived` : les tâches archivées
quittent l'état du dashboard. `ah task delete T-001 --yes` supprime définitivement une tâche terminée, en échec ou archivée.

## Routes HTTP ajoutées
`POST /api/tasks/<id>/queue` `{account}` · `POST /api/tasks/<id>/unqueue` · `POST /api/tasks/<id>/answer` `{answer}` ·
`DELETE /api/tasks/<id>` · `POST /api/tasks/archive-done` `{project?}` · `GET /api/tasks/<id>`.
L'état contient en plus : `locks`, `presence` (`conflict: true` quand ≥ 2 agents sur un projet), `archivedCount`, `runs[].progress`.
