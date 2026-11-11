# Modèles locaux (Ollama) dans agent-hub

Les modèles qui tournent sur ton PC (via Ollama) peuvent coder comme Codex : même circuit (worktree git isolé, tests,
correction automatique, tâche, dashboard). La différence : c'est gratuit, privé, plus lent et moins fort — donc cadré.

## Principe

- Un agent `ollama:<nom>` s'utilise partout où l'on met `codex:a` : `ah run --acct 9b`, `ah task dispatch T-1 --acct 27b`,
  l'assignation et le lancement depuis le dashboard.
- Boucle d'agent écrite pour le hub (`lib/ollama.mjs`) au-dessus de l'API `/api/chat` d'Ollama, avec des outils bornés :
  `list_files`, `read_file`, `search`, `write_file`, `replace_in_file`, `run_tests`, `ask_question`, `finish`.
  - confiné au worktree ; jamais d'écriture dans `.git`, `node_modules`, `.env` ;
  - les fichiers de test existants sont **en lecture seule** (un modèle faible « réussit » sinon en modifiant les tests) ;
  - audit (`--sandbox read-only`) : outils d'écriture et de test retirés ;
  - garde-fous : relance si le modèle bavarde au lieu d'agir, détection de boucle, plafond d'étapes, compactage du contexte,
    appels d'outils écrits « en texte » rattrapés.
- **Un seul travail local à la fois** : la carte graphique est partagée. Les runs ChatGPT continuent en parallèle.
  Le planificateur attend aussi que la VRAM libre suffise (`vramMiB`).
- Rôles proposés : le petit modèle est l'**ouvrier rapide** ; le grand est **relecteur / planificateur** ; Claude
  (la session qui orchestre) répartit le travail et vérifie.

## Escalade vers ChatGPT : semi-automatique, toujours validée

Quand un modèle local échoue (tests en échec après les corrections, boucle, délai dépassé), le hub **prépare** un brief
pour ChatGPT (`bus/briefs/<tâche>.escalation.md` : la tâche d'origine, la raison de l'échec, le résumé du modèle local,
la fin de la sortie des tests, les modifications tentées) et te prévient. **Rien n'est envoyé** tant que tu n'as pas validé :

```bash
ah task show T-012                         # voir l'escalade proposée
ah task escalate T-012 --acct b            # affiche le chemin du brief préparé : relis-le
ah task escalate T-012 --acct b --yes      # envoie à ChatGPT (consomme du quota)
ah task escalate T-012 --dismiss           # écarte
```

Dans le dashboard : encadré « Le modèle local a échoué : l'envoyer à ChatGPT ? » avec le brief, bouton « J'ai relu : envoyer ».
Pour ne rien préparer : `ah task add … --no-escalate`.

## Configuration

Dans `~/.agent-hub/config.json` :

```json
{
  "local": [
    { "name": "9b",  "label": "Bonsai 9B (ouvrier rapide)", "model": "bonsai-code:9b",  "base": "bonsai-2:9b",
      "role": "coder",    "ctx": 32768, "think": false,  "noVision": true, "vramMiB": 3600 },
    { "name": "27b", "label": "Bonsai 27B (relecteur / planificateur)", "model": "bonsai-plan:27b", "base": "bonsai-2:27b",
      "role": "reviewer", "ctx": 16384, "think": "low", "noVision": true, "vramMiB": 6500 }
  ],
  "localMaxParallel": 1
}
```

Champs par modèle (défauts) : `host` (`http://127.0.0.1:11434`), `ctx` (32768), `think` (celui du modèle), `temperature` (0.3),
`topP` (0.9), `topK` (20), `presencePenalty` (0), `numPredict` (4096), `maxSteps` (40), `stepTimeoutSec` (600),
`timeoutMin` (45), `keepAlive` (`30m`), `fixAttempts` (2), `protectTests` (true), `noVision`, `vramMiB`.

`ah ollama setup` crée les modèles dérivés (`model`) à partir de `base`. Avec `noVision`, le dérivé est construit à partir
du seul fichier de poids : le module vision (~0,6 Go) n'est pas chargé, ce qui libère de la VRAM (le code n'en a pas besoin).

Réglages du service Ollama appliqués sur cette machine (variables d'environnement utilisateur) :
`OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`, `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1`, `OLLAMA_KEEP_ALIVE=30m`.

## Commandes

```bash
ah gpu                           # mémoire de la carte et qui l'occupe (hors Ollama)
ah ollama status                 # version, modèles, ce qui est en mémoire
ah ollama setup [nom]            # crée les modèles dérivés
ah ollama smoke [nom]            # essai rapide : vitesse, VRAM, appel d'outil valide
ah run brief.md --acct 9b        # un travail sur le modèle local
ah bench run --models 9b,27b --levels 0-6 [--tasks id,id] [--timeout MIN] [--keep]
```

Trace détaillée d'un run (réflexion, appels, résultats) : `AH_OLLAMA_TRACE=fichier.jsonl ah run …`.

## Benchmark

`bench/ollama/tasks/` : 27 tâches de difficulté croissante (niveau 0 « nulles » : renommer, corriger une constante…
jusqu'au niveau 6 : interpréteur d'expressions, ordonnanceur concurrent). Chaque tâche a un dépôt de départ dont les
tests échouent, un `brief.md` et une solution de référence ; `test/bench-fixtures.test.mjs` vérifie qu'elles échouent
avant et réussissent après. `ah bench run` copie chaque tâche dans un dépôt jetable, lance le modèle, rejoue les tests
et compte comme **échec** toute modification d'un test existant.

## Optimiser la carte graphique

Windows et ses applications utilisent de la VRAM (le bureau — `dwm` — ne se libère pas ; le reste, si). `ah gpu` liste les
consommateurs. Fermer ou désactiver ce qui n'est pas utile (fenêtre ProtonVPN, accélération matérielle du navigateur,
NVIDIA Overlay, effets de transparence de Windows) libère de la place pour un contexte plus grand ou un plus gros modèle.
Le hub ne ferme rien lui-même : c'est ton choix.
