Implémente expandRanges(text) dans index.js pour développer des numéros et plages séparés par des virgules : « 3,1-2,2 » donne [1,2,3].
Les numéros sont des entiers décimaux entre 0 et 1000 inclus, zéros initiaux autorisés ; les bornes des plages sont incluses et croissantes.
Le résultat doit être trié par ordre numérique et sans doublons.
Les espaces ASCII sont permis autour de chaque élément, mais pas dans un nombre ni autour du tiret.
Une chaîne vide ou composée uniquement d'espaces donne []. Tout autre format invalide lève RangeError.
Une entrée non chaîne lève TypeError.
