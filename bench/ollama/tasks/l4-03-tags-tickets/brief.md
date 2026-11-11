Ajoute le champ tags à toute la chaîne de création et lecture des tickets.
Dans normalize.js, tags absent vaut [] ; sinon il faut un tableau de chaînes (TypeError dans les autres cas).
Retire les espaces aux extrémités, passe en minuscules, ignore les chaînes vides et déduplique en gardant le premier ordre.
Le stockage de store.js et les réponses de service.js doivent conserver ces tags normalisés.
Les tableaux reçus ou renvoyés peuvent être modifiés par l’appelant sans altérer les tickets enregistrés.
Conserve les champs existants, leurs validations et le résultat null d’une recherche absente.
Le store reçoit des tickets normalisés ; il ne doit pas refaire la normalisation.
