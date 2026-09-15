# Catalogue des scénarios

Tous les scénarios du jeu sont stockés ici, un dossier par affaire. Le moteur les détecte automatiquement au démarrage.

**Capacité maximale : 20 scénarios.** Le projet contient actuellement 11 affaires :

- jeu01 — LE DERNIER DÎNER
- jeu02 — RIDEAU FINAL
- jeu03 — NUIT EN HAUTE MER
- jeu04 — LE MARIAGE EMPOISONNÉ
- jeu05 — LE MUSÉE DES OMBRES
- jeu06 — L'HÔTEL SANS LUMIÈRE
- jeu07 — LA DERNIÈRE PARTIE
- jeu08 — LE VOL DE MINUIT
- jeu09 — LE TRAIN DE NUIT
- jeu10 — LE CHALET ISOLÉ
- jeu11 — RIDEAU ROUGE

Pour ajouter une affaire, créer `jeu12/`, `jeu13/`, etc. avec la même structure JSON (`manifest.json`, `story.json`, `characters.json`, `clues.json`, `timeline.json`, `locations.json`, `questions.json`, `solution.json`). Aucun changement du moteur serveur n'est nécessaire.

Le serveur choisit aléatoirement une affaire compatible avec le nombre de joueurs et mémorise les affaires déjà jouées dans chaque salle afin d'éviter les répétitions jusqu'à épuisement du catalogue.
