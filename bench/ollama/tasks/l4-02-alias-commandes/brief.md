Les définitions de commandes peuvent maintenant inclure aliases, un tableau optionnel de noms.
Étends registry.js et loader.js pour que chaque alias exécute le même handler que le nom principal.
register(name, handler, aliases = []) doit aussi fonctionner directement ; names() inclut tous les noms triés.
Tous les noms partagent le même espace : doublons internes ou collisions existantes sont des erreurs.
Un enregistrement refusé ne doit ajouter aucun nom, même si la collision est sur le dernier alias.
Conserve les erreurs de handler invalide et commande inconnue ; dispatch.js garde son API.
Les noms fournis sont des chaînes non vides et aliases est toujours un tableau de chaînes lorsqu’il est présent.
