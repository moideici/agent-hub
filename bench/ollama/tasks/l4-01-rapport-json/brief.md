Ajoute l’option --json au mini rapport, en suivant options.js et render.js.
run(args, rows) doit alors renvoyer le JSON compact du tableau rows, sans saut de ligne final.
Sans option ou avec --text, garde exactement la sortie texte actuelle.
Si plusieurs options de format sont données, la dernière gagne ; les options inconnues restent des erreurs.
Le renderer doit accepter directement le format json et toujours rejeter les formats inconnus.
Ne modifie pas les données reçues ni l’API de report.js.
