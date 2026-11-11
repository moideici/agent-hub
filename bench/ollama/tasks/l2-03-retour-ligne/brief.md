Dans index.js, implémente wrapText(text, width) qui renvoie un tableau de lignes.
Normalise les espaces (au sens de /\s/) entre les mots et aux extrémités ; un texte blanc donne [].
Place chaque mot entier sur la ligne courante s'il tient avec l'espace séparateur, sinon commence une nouvelle ligne.
Un mot plus long que width reste entier sur sa propre ligne, sans découpage.
text doit être une chaîne (sinon TypeError) ; width doit être un entier sûr strictement positif (sinon RangeError).
La longueur se mesure comme String.length, sans traitement Unicode spécial.
