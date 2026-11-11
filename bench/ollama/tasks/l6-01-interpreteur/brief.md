Complète `evaluate(source, variables = {})` dans `expression.js` sans utiliser eval ni Function ; les variables fournies sont des nombres finis.
Accepte espaces, nombres décimaux (`2`, `.5`, `1.`, `1e-2`), noms `[A-Za-z_][A-Za-z_0-9]*` et parenthèses.
Priorités décroissantes : puissance `^` associative à droite, unaires `+ - !`, `* / %`, `+ -`, comparaisons `< <= > >=`, égalités `== !=`, `&&`, `||`, ternaire `?:` associatif à droite. Les autres opérateurs binaires sont associatifs à gauche.
La puissance accepte un exposant unaire : `-2^2` vaut -4 et `2^-2` vaut .25. Comparaisons, égalités, !, && et || produisent 0 ou 1 ; seul 0 est faux.
&&, || et ?: n'évaluent que les branches nécessaires, mais toute la source doit être analysée avant l'évaluation.
Une erreur lexicale ou syntaxique lève SyntaxError(`syntax at N`) à l'offset UTF-16 du premier jeton inattendu (ou source.length en fin de texte).
Une variable absente des propriétés propres lève ReferenceError(`unknown NAME at N`) ; diviser ou prendre le reste par zéro lève RangeError(`division by zero at N`), N étant la position de l'opérateur ou du nom.
N'impose pas d'autres erreurs arithmétiques : les autres résultats suivent les nombres JavaScript ; les entrées variables ne doivent pas être modifiées.
