Implémente `shortestPath(edges, start, end)` dans `route.js` pour un graphe orienté donné par des triplets `[source, destination, coût]`.
Les sommets sont des chaînes ; les coûts doivent tous être des nombres finis positifs ou nuls, sinon lève RangeError, même pour une arête inaccessible.
Renvoie `{ distance, path }` pour le meilleur chemin ou null si aucune route n'existe ; un sommet sans arête peut servir de départ ou d'arrivée.
À distance égale, préfère le chemin avec le moins d'arêtes, puis le plus petit chemin lexicographique (compare les identifiants avec `<`, élément par élément).
Un trajet vers soi donne `{ distance: 0, path: [start] }` après validation ; accepte boucles, cycles de coût nul et arêtes parallèles.
Ne modifie pas edges ; ne résous pas le problème en énumérant tous les chemins possibles.
