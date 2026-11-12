# Changelog

Toutes les évolutions notables de ce projet. Les versions suivent [SemVer](https://semver.org/lang/fr/).

## [0.1.0] : première version publique

Instantané du dépôt au moment de son ouverture au public. Détail de l'historique ci-dessous, par mois.

### 2026-11
- Mise à jour du nom d'utilisateur GitHub : moidefr -> moideici
- ah gpu : n'attribue plus le runner d'Ollama aux autres applications ; bench --set pour tester des réglages
- Dashboard : modèles locaux (cartes, lancement, assignation), escalade à valider ; tests local/UI ; --no-escalate
- Agent local : read_file/write_file indiquent le saut de ligne final ; trace AH_OLLAMA_TRACE
- Modèles locaux (Ollama) : routage, verrou GPU, escalade semi-automatique, commandes gpu/ollama/bench/escalate, routes dashboard
- agent(b): Benchmark Ollama : tâches des niveaux 5 et 6
- agent(b): Benchmark Ollama : tâches des niveaux 5 et 6
- agent(b): Benchmark Ollama : tâches des niveaux 3 et 4
- Runs: identifiant unique (suffixe aleatoire) et tache en echec si le processus meurt avant son verdict
- Benchmark: niveaux 0 a 2 (14 taches ecrites par Codex, relues) ; octets exacts preserves (.gitattributes)
- Tests imbriques: ne pas heriter de NODE_TEST_CONTEXT (validateur du benchmark, lanceurs de tests du hub)
- Agent local Ollama: boucle d'outils bornee au projet, backend dans ah run, faux serveur et 11 tests; date de reprise du quota comprise (Dec 4th, 2026)
- agent(b): Benchmark Ollama : tâches des niveaux 0 à 2
- Benchmark local: validateur des taches (echec au depart, reussite avec la solution)
- README: doc a jour (coordination, dashboard, file d'attente, questions, audits, securite, structure)
- Interface refaite (accueil 'a decider', taches par projet puis etat, vocabulaire clair), docs des fonctions avancees, 80 tests
- File d'attente, ah wait, correction automatique, question/reprise Codex, resultats, progression, reservations, resume de demarrage, archivage; audits lecture seule sans branche
- Taches d'audit: mode lecture seule + modifications en cours, depuis la CLI et le dashboard
- Dashboard: refonte (vue d'ensemble, taches par projet puis etat, sessions par projet, messages non lus), 65 tests
- Relecture Codex: reservation atomique des lancements, dependances, echec au demarrage, boite de reception sans perte
- Dashboard: interface web (Codex), runs perimes apres 4 h, test
- agent(a): Interface web du dashboard
- Coordination: tests CLI/hook, section skill et README
- Coordination: bus de taches/messages, lecteur de sessions Claude, serveur dashboard localhost et CLI

### 2026-10
- Reapply "Sandbox Windows: toujours unelevated par defaut (evite les fenetres UAC repetees)"
- Revert "Sandbox Windows: toujours unelevated par defaut (evite les fenetres UAC repetees)"
- Sandbox Windows: toujours unelevated par defaut (evite les fenetres UAC repetees)
- Fix: never delete the target of a linked node_modules when removing a worktree
- Document real-world validation and sandbox limitation
- agent(b): Add unit tests for detectProject and parseResetTime
- Detect duplicate ChatGPT accounts across CODEX_HOMEs
- Initial agent-hub: ah CLI to delegate tasks to Codex (ChatGPT OAuth)
