Implémente `applyPatch(document, operations)` dans `patch.js` : renvoie une copie JSON transformée sans jamais modifier le document ni les opérations, même en cas d'échec.
Les valeurs sont JSON (pas de cycles) ; les opérations bien formées ont op/path et, selon op, value ou from. Supporte add, remove, replace, copy, move, test ; une op inconnue est une erreur.
Les chemins sont des JSON Pointer : chaîne vide pour la racine, sinon `/` puis segments ; décode `~1` en `/`, `~0` en `~`, et rejette tout autre échappement. Les propriétés héritées n'existent pas.
Dans un objet, add crée/remplace une propriété propre (même __proto__) ; remove/replace exigent sa présence. Les parents doivent exister, sans création automatique.
Dans un tableau, les indices sont des entiers décimaux sans zéro initial (sauf 0) ; add insère entre 0 et length inclus, ou à `-` pour ajouter à la fin ; les autres accès exigent un indice existant.
À la racine, add/replace remplacent tout le document, remove donne null ; test compare profondément, sans tenir compte de l'ordre des clés d'objets mais en respectant celui des tableaux.
copy insère une copie profonde de from via la règle add ; move retire from puis applique add sur le document résultant (indices de tableaux compris).
Interdis move vers un descendant strict de from ; déplacer vers soi est permis si la source existe. Compare les segments décodés, pas les préfixes textuels.
Tout chemin invalide, accès impossible, op inconnue, déplacement interdit ou test faux lève une Error nommée PatchError avec une propriété index égale à la position de l'opération fautive.
Le résultat doit être indépendant du document et des valeurs des opérations, y compris lorsqu'aucune opération n'est fournie ; ne modifie pas les tests.
