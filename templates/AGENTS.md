# AGENTS.md

Règles communes à tous les agents IA qui travaillent sur ce dépôt (Claude Code, Codex…).
Source unique : `CLAUDE.md` peut simplement renvoyer ici.

## Projet
<!-- 2-3 lignes : à quoi sert ce dépôt, stack principale. -->

## Commandes
- Tests : `{{TEST}}`
- Build / lint : <!-- à renseigner -->

## Conventions
<!-- style de code, nommage, structure des dossiers, ce qu'il ne faut jamais toucher -->

## Règles pour les agents
- Reste dans le périmètre de la tâche ; si c'est ambigu, explique au lieu de deviner.
- Ne touche pas aux secrets (`.env`, clés, tokens) ni aux fichiers générés.
- Mets à jour la documentation concernée quand le comportement change.
- Ajoute ou adapte des tests pour tout changement de logique.
