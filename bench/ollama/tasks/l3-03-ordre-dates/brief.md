La chronologie de events.js se trompe avec les dates ISO portant des décalages horaires.
Corrige le classement pour qu’il suive les instants réels, du plus ancien au plus récent.
À instant égal, départage par id croissant (comparaison des chaînes).
La fenêtre reste inclusive au début et exclusive à la fin ; conserve filtres et statistiques.
Ne modifie pas les événements fournis ni la validation existante.
