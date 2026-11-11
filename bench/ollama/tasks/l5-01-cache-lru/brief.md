Implémente `LRUCache` dans `cache.js`, sans modifier les tests.
Le constructeur prend une capacité entière positive ou nulle (sinon RangeError) ; `size` expose le nombre d'entrées.
`set(clé, valeur)` renvoie le cache, insère ou remplace et rend la clé la plus récente ; `get` renvoie la valeur (undefined si absente) et rafraîchit la récence.
`has` vérifie la présence sans rafraîchir ; `delete` renvoie un booléen ; `entries()` renvoie un nouveau tableau de paires de la plus ancienne à la plus récente.
`resize(n)` valide comme le constructeur, évince les plus anciennes si nécessaire et renvoie le cache ; à capacité zéro rien n'est conservé.
Accepte toutes les clés et valeurs de Map, y compris undefined et les objets ; ne modifie jamais les objets stockés.
Les opérations get/set/has/delete doivent être en O(1) amorti, sans parcours du cache ; resize peut parcourir les entrées évincées.
