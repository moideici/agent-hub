Implémente parseCsvRow(text) dans index.js : renvoie les champs d'un unique enregistrement CSV séparés par des virgules.
Un champ peut être entouré de guillemets doubles ; une paire de guillemets à l'intérieur représente un guillemet littéral.
Une virgule entre guillemets appartient au champ ; les espaces sont conservés et la chaîne vide représente un champ vide.
Un guillemet ne peut commencer qu'au début d'un champ ; après sa fermeture, seule une virgule ou la fin est permise.
Refuse les guillemets non fermés et tout retour CR ou LF, même entre guillemets, avec SyntaxError.
Une entrée non chaîne lève TypeError.
