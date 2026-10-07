# Catalogue des scénarios

Tous les scénarios du jeu sont stockés ici, un dossier par affaire. Le moteur les détecte automatiquement au démarrage.

**Capacité maximale : 20 scénarios.** Le projet contient désormais le catalogue complet de 20 affaires :

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
- jeu12 — LE VIGNOBLE MAUDIT
- jeu13 — L'AQUARIUM APRÈS MINUIT
- jeu14 — LE SPA DU SILENCE
- jeu15 — LA FOIRE AUX ANTIQUITÉS
- jeu16 — LE SOMMET DES STARTUPS
- jeu17 — LA MAISON DE VENTE AUX ENCHÈRES
- jeu18 — LE BAL MASQUÉ
- jeu19 — LE FESTIVAL DU FILM
- jeu20 — LA BIBLIOTHÈQUE SECRÈTE

Le catalogue est désormais plein (20/20). Pour ajouter une affaire au-delà de cette limite, il faudrait d'abord augmenter le plafond dans `server/server.js` (`SCENARIO_IDS = ... .slice(0, 20)`), puis créer un nouveau dossier `jeu21/` avec la même structure JSON (`manifest.json`, `story.json`, `characters.json`, `clues.json`, `timeline.json`, `locations.json`, `questions.json`, `solution.json`).

Le serveur choisit aléatoirement une affaire compatible avec le nombre de joueurs et mémorise les affaires déjà jouées dans chaque salle afin d'éviter les répétitions jusqu'à épuisement du catalogue.
