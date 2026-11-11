Implémente parseDuration(text) dans index.js pour renvoyer un nombre de secondes.
Le format est une suite non vide de couples entier non signé + unité parmi h, m, s, dans cet ordre, chacun au plus une fois.
Des unités peuvent être omises ; 90m et 0s sont valides, les zéros initiaux aussi.
Aucun espace, signe, décimale ou autre caractère n'est accepté.
Une entrée non chaîne lève TypeError ; un format invalide ou un total hors des entiers sûrs lève RangeError.
