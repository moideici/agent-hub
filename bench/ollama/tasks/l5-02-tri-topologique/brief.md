Complète `plan(nodes)` dans `plan.js` pour ordonner des travaux `{ id, deps }`, avec identifiants chaînes uniques et deps tableau de chaînes (doublons autorisés).
Chaque dépendance doit précéder son travail ; parmi les travaux actuellement disponibles, choisis toujours celui apparaissant le plus tôt dans l'entrée.
Renvoie `{ order, blocked }` : order contient les identifiants exécutables, blocked tous les autres dans l'ordre d'entrée, y compris les descendants d'un cycle.
Une dépendance inconnue ou un identifiant dupliqué doit lever Error avec respectivement le message `unknown dependency: X` ou `duplicate id: X`.
Valide les doublons avant les dépendances inconnues ; pour ces dernières, signale la première dans l'ordre des travaux puis des deps.
L'entrée est bien formée hors ces deux erreurs ; ne la modifie pas. Gère aussi les graphes vides, disjoints et les auto-dépendances.
Évite les parcours répétés de tous les travaux pour trouver ceux qui deviennent disponibles.
