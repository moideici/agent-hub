Implémente `runPool(tasks, { concurrency = 2, retries = 0, signal } = {})` dans `pool.js` ; renvoie une promesse de résultats dans l'ordre d'entrée.
tasks est un tableau de fonctions recevant `{ attempt, signal }` (attempt commence à 1), renvoyant une valeur ou promesse, ou levant une exception ; signal est un AbortSignal optionnel.
Au plus concurrency tentatives peuvent être actives ; remplis les places disponibles sans attendre la fin des autres tâches, en suivant une file FIFO initialement dans l'ordre d'entrée.
Après échec, s'il reste des reprises, replace la tâche en fin de file ; retries est le nombre de tentatives supplémentaires, indépendamment pour chaque tâche. Une tâche n'a jamais deux tentatives simultanées.
Une réussite donne `{ status: 'fulfilled', value, attempts }`, un échec définitif `{ status: 'rejected', reason, attempts }` ; conserve l'identité des valeurs et erreurs.
À l'annulation, ne lance plus de tentative et transforme toute tâche en attente (y compris une reprise en file) en `{ status: 'cancelled', attempts }` ; un signal déjà annulé annule tout, sans appeler les tâches.
Les tentatives déjà actives vont à leur terme : conserve leur réussite ou leur échec, sans reprise après annulation ; la promesse globale attend leur règlement. Transmets le signal reçu aux tâches.
concurrency doit être un entier strictement positif et retries un entier positif ou nul ; sinon la promesse globale rejette avec RangeError avant tout lancement, même pour tasks vide.
Sans erreur d'options, la promesse globale réussit toujours (tableau vide si aucune tâche) ; isole les appels concurrents et retire tes écouteurs à la fin.
Ne modifie ni tasks ni les options ; n'utilise aucune temporisation, aucun réseau, aucune dépendance. Les tests pilotent explicitement les promesses.
