Le total de TVA diffère parfois de la somme des TVA affichées sur les lignes.
Corrige invoice.js pour respecter la règle métier : arrondir la TVA au centime par ligne,
puis additionner ces montants arrondis pour la facture.
Tous les prix sont des entiers en centimes et les taux des pourcentages entiers.
Conserve les validations, le formatage et le calcul du montant hors taxe.
