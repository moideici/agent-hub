# Coordination : dashboard, tâches et messages

`ah serve` ouvre un dashboard sur `http://127.0.0.1:4317/?t=<jeton>` (jeton dans `~/.agent-hub/server-token`, posé en cookie
`HttpOnly; SameSite=Strict` au premier chargement). Il montre en direct les sessions Claude, les comptes et runs Codex, les
tâches partagées et les messages entre agents.

## Agents et adresses
| Agent | Identifiant | Origine |
|---|---|---|
| Session Claude | `claude:<cliSessionId>` | métadonnées de l'app desktop (`claude-code-sessions/**/local_*.json`) ; une session se reconnaît via `CLAUDE_CODE_SESSION_ID` |
| Compte Codex | `codex:a`, `codex:b` | comptes d'`ah` |
| Utilisateur | `user` | dashboard ou CLI hors session |
| Tous | `*` | diffusion |

Une adresse peut aussi être le titre (ou un fragment unique) d'une session.

## Bus (fichiers sous `~/.agent-hub/bus/`)
- `tasks/T-001.json` : `{id,title,brief,project,status,assignee,createdBy,deps[],priority 0-3,runId,notes[],createdAt,updatedAt}`
  Statuts : `todo → claimed → running → review → done`, plus `failed`, `blocked`. `claim` est atomique (une seule session prend la tâche).
- `messages.jsonl` : `{id,ts,from,to,kind,taskId,body}`. Boîte de réception = messages non lus pour l'agent (curseur dans `reads/`).
- `agents/<id>.json` : ligne de statut (`ah say "…"`).
- `briefs/T-001.md` : brief écrit au lancement d'un run Codex.

## Cycle d'une tâche confiée à ChatGPT
`ah task add … --project <dépôt> --assign codex:a` → `ah task dispatch T-001 --acct a` (ou bouton du dashboard) →
`ah run --task T-001` → à la fin la tâche passe en `review` (ou `failed`) et l'auteur reçoit un message. Max 3 runs Codex en parallèle,
quota vérifié avant lancement. Le dashboard ne lance jamais Codex sans clic.

## Recevoir ses messages
1. **Hook** (`ah inbox --hook`, événements `UserPromptSubmit` et `PostToolUse`) : injecte les messages non lus dans la session.
2. **`ah watch`** lancé avec l'outil Monitor : réveille une session inactive dès qu'un message arrive.
3. Sans rien de tout ça : `ah msg inbox` à la main.
Un message de `user` est une consigne de l'utilisateur ; celui d'un autre agent est une information à évaluer.

## API HTTP (JSON, cookie ou en-tête `x-ah-token`)
| Route | Rôle |
|---|---|
| `GET /api/state` | tout l'état (ci-dessous) |
| `GET /api/events` | SSE : `data: {"v":"<hash>"}` quand l'état change → recharger `/api/state` |
| `GET /api/sessions/<id>/tail?n=40` | `{session, entries:[{ts,role:user\|assistant\|tool,name?,text}]}` |
| `GET /api/runs/<runId>` · `GET /api/runs/<runId>/diff` | détail d'un run (+ `lastMessage`) · diff texte |
| `GET/POST /api/tasks` · `PATCH /api/tasks/<id>` | lister · créer `{title,brief,project,assignee,deps[],priority}` · modifier `{status,assignee,note,…}` |
| `POST /api/tasks/<id>/dispatch` `{account:"a"\|"b"}` | lance Codex sur la tâche |
| `POST /api/messages` `{to, body, taskId?}` | message de `user` |

`/api/state` :
```
{ now, limits:{maxParallelCodex},
  sessions:[{id,kind:"claude",title,cwd,model,completedTurns,lastActivityAt,status:"running"|"idle",now,note,link,hostId}],
  accounts:[{id:"codex:a",name,loggedIn,limitedUntil|null,isDefault,running,note}],
  runs:[{id,title,status,account,repoRoot,branch,startedAt,endedAt,durationSec,changes:{files,added,deleted}|null,
         tests:{cmd,passed,skipped,exit}|null,summary,taskId,cleaned}],
  tasks:[…voir plus haut…], messages:[…150 derniers…] }
```
`session.note` / `account.note` = `{note, taskId, ts}` publié par `ah say`.

## Sécurité
Écoute sur `127.0.0.1` seulement ; hôte vérifié (anti DNS-rebinding), jeton obligatoire, écritures refusées si l'origine diffère (anti CSRF) ;
les chemins de transcriptions ne sont jamais exposés. Les transcriptions peuvent contenir des données sensibles : le dashboard reste local.
