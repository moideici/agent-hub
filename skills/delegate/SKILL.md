---
name: delegate
description: Délègue une tâche de code à Codex (GPT, via les comptes ChatGPT OAuth) dans un git worktree isolé avec `ah`, ou fait relire un diff par Codex. À utiliser quand une tâche est bien délimitée, indépendante et vérifiable par des tests (implémentation spécifiée, correction de bug reproductible, tests à écrire, refactor mécanique), quand plusieurs tâches indépendantes peuvent tourner en parallèle, ou pour obtenir une relecture croisée par un autre modèle avant de fusionner. Fonctionne dans n'importe quel dépôt git.
---

# Déléguer à Codex avec `ah`

`ah` (agent-hub, installé globalement) lance `codex exec` avec le compte ChatGPT choisi, dans un worktree
`agent/<id>` créé hors du dépôt. Le dépôt principal n'est jamais modifié avant `ah merge`.
Tu es le chef de chantier : tu spécifies, tu relis, tu fusionnes. Codex exécute.

## Quand déléguer — et quand ne pas le faire
Délègue si la tâche est **délimitée** (fichiers/zone connus), **indépendante** du reste de ton travail en cours
et **vérifiable** (tests, build, ou critère observable). Ça paie surtout en parallèle : lance 2–3 tâches
indépendantes pendant que tu continues.

Garde pour toi : conception/architecture, tâches floues ou très couplées au contexte de la conversation,
tout ce qui touche aux secrets ou à la prod, les petites modifs (écrire le brief coûte plus que faire).

## Procédure
1. **Vérifie** : `ah doctor` (une fois par session) — comptes connectés, commande de tests détectée.
   Si le dépôt n'a pas de `AGENTS.md`/`.agent-hub.json`, propose `ah init`.
2. **Écris le brief** dans un fichier (hors du dépôt, ex. dossier temporaire) avec ce gabarit :
   ```markdown
   # <titre court et précis>
   ## Objectif
   <le résultat attendu, en 2-3 phrases>
   ## Contexte
   <fichiers/fonctions concernés, décisions déjà prises, pièges connus>
   ## Contraintes
   <ce qu'il ne faut pas toucher, style, compatibilité>
   ## Critères d'acceptation
   <liste vérifiable ; commande de test à passer>
   ```
   Un bon brief est autonome : Codex n'a pas ta conversation. Jamais de secret dedans.
3. **Lance** (en arrière-plan avec `run_in_background` si tu as autre chose à faire ; plusieurs `ah run` en parallèle sont OK) :
   ```bash
   ah run <brief.md> --json
   ```
   Options utiles : `--acct a|b` (compte ; sans option = compte par défaut), `--test "<cmd>"`, `--include-dirty`
   (le worktree part de `HEAD` ; ajoute-le si la tâche dépend de modifs non commitées), `--effort high` pour les tâches dures,
   `--timeout <min>`.
4. **Lis le résultat** (JSON) : `status`, `tests`, `changes`, `summary`. Codes de sortie : 0 ok · 1 échec ·
   2 quota atteint · 3 timeout · 10 terminé mais tests en échec.
   - **2 (quota)** : relance avec l'autre compte (`--acct b`) ou fais la tâche toi-même. N'utilise `--acct auto`
     que si l'utilisateur l'a activé (`autoRotate`). Le message donne l'heure de reprise.
   - **10 / 1** : lis `ah show <id>` et les logs (`dir` dans le JSON), corrige le brief ou reprends la main.
5. **Relis TOUJOURS le diff avant de fusionner** : `ah show <id> --patch`. Vérifie que ça respecte le brief,
   qu'il n'y a pas de dépassement de périmètre, de secret, de test affaibli ou désactivé. Les tests du hub sont
   lancés indépendamment de l'agent, mais ils ne remplacent pas la relecture.
6. **Fusionne ou jette** : `ah merge <id>` (ajoute `--squash` pour un seul commit propre) ou `ah clean <id>`.

## Relecture croisée (Codex relit ton travail)
Avant un commit important ou une PR :
```bash
ah review --json                 # modifications non commitées (sinon dernier commit)
ah review --base main --json     # tout ce qui diverge de main
ah review <runId> --json         # le travail d'un run
```
La réponse est un JSON `{verdict, summary, findings[{severity,file,line,title,detail}]}`. Les findings sont des
**hypothèses à vérifier**, pas des ordres : confirme chacun dans le code avant de corriger, ignore les faux positifs.
`--focus "<point précis>"` oriente la relecture (ex. concurrence, sécurité).

## Règles
- Ne fusionne jamais sans avoir lu le diff. Ne pousse (`git push`) rien sans demande de l'utilisateur.
- Les branches `agent/*` et les worktrees vivent dans `~/.agent-hub/` ; `ah clean` pour ranger.
- `ah status` liste les runs, `ah accounts` montre les comptes et leurs quotas.
- Quota Codex limité (fenêtre de 5 h + hebdomadaire) : réserve-le aux tâches qui en valent la peine.
