# Le Dernier Dîner — Jeu 01

Jeu de mystère, d'enquête et de bluff en multijoueur en ligne (6 à 12 joueurs),
basé sur le cahier des charges fourni. Prototype fonctionnel : serveur
autoritaire (Node.js + Express + Socket.IO) + client web (HTML/CSS/JS).

## 1. Installation

```bash
npm install
```

## 2. Lancement local

```bash
npm start
```

Le serveur écoute sur `http://0.0.0.0:3000` (port configurable via la
variable d'environnement `PORT`). En local, ouvrir `http://localhost:3000`.

Pour tester en réseau local (autres appareils sur le même Wi-Fi) :
trouver l'adresse IP locale de la machine (`ipconfig` / `ifconfig`) et
ouvrir `http://<IP-locale>:3000` depuis les autres appareils.

## 3. Accès à distance (joueurs hors de votre réseau)

Le serveur est déjà écrit pour être accessible à distance (écoute sur
`0.0.0.0`, CORS ouvert). Un fichier `render.yaml` est inclus pour un
déploiement simplifié sur Render.com.

### Déploiement sur Render.com (gratuit) — étapes détaillées

**1. Mettre le code sur GitHub**
```bash
cd mystery-case-game01
git init
git add .
git commit -m "Premier prototype - Le Dernier Dîner"
```
Créer un nouveau dépôt (vide) sur https://github.com/new, puis :
```bash
git remote add origin https://github.com/<ton-pseudo>/mystery-case-game01.git
git branch -M main
git push -u origin main
```

**2. Créer le service sur Render**
- Aller sur https://render.com et se connecter avec le compte GitHub
- Cliquer "New +" → "Web Service"
- Choisir le dépôt `mystery-case-game01`
- Render détecte automatiquement `render.yaml` (sinon renseigner
  manuellement : Build Command `npm install`, Start Command `npm start`)
- Plan : Free
- Cliquer "Create Web Service"

**3. Récupérer l'URL publique**
Après quelques minutes de build, Render donne une URL du type
`https://mystery-case-game01.onrender.com`. C'est cette URL qu'il faut
partager avec les joueurs — ils l'ouvrent dans leur navigateur, où
qu'ils soient, et créent/rejoignent une salle normalement.

⚠️ Sur le plan gratuit, le service peut se mettre en veille après un
moment d'inactivité et mettre ~30 secondes à se réveiller au premier
accès : normal, il suffit d'attendre le premier chargement.

### Alternatives
- Railway.app, Fly.io : principe similaire (dépôt GitHub → build →
  URL publique)
- Tunnel temporaire pour un test rapide sans déploiement :
```bash
npm start
ngrok http 3000
```

## 4. Structure du projet

```
mystery-case-game01/
├── package.json
├── README.md
├── data/            # Contenu du scénario (séparé du moteur de jeu)
│   ├── rules.json
│   ├── story.json
│   ├── characters.json
│   ├── clues.json
│   ├── timeline.json
│   ├── locations.json
│   ├── questions.json
│   └── solution.json
├── server/
│   └── server.js    # Serveur autoritaire (Express + Socket.IO)
└── public/
    ├── index.html
    ├── style.css
    └── app.js
```

## 5. Ce qui est implémenté

- Création / rejoindre une salle avec code à 5 caractères
- Lobby (6 à 12 joueurs, minimum imposé pour lancer)
- Distribution serveur des personnages avec sélection des coupables
  (1 coupable pour 6–8 joueurs parmi Sarah/Nicolas ; 2 coupables — Sarah
  ET Nicolas — pour 9–12 joueurs) + vérification finale avant démarrage
- Dossier privé par joueur (identité, motif, secret, alibi, opportunité,
  informations, objectif, statut coupable/innocent strictement privé)
- Phases automatiques avec chronomètre serveur : distribution → dossier
  → investigation → discussion → vote → élimination → (nouvelle manche
  ou révélation)
- Révélation progressive des 12 indices pendant l'investigation
  (le navigateur ne peut jamais afficher un indice non révélé)
- Chat public en temps réel + accusation formelle structurée
  (suspect / motif / opportunité / indice)
- Vote (un joueur vivant = une voix, pas d'auto-vote, gestion de
  l'égalité), élimination, conditions de victoire
- Révélation finale complète (coupables, motifs, fausses pistes,
  qui incarnait qui)
- Reconnexion : un joueur qui perd sa connexion retrouve son
  personnage, son dossier et son statut via un jeton stocké côté
  navigateur (`sessionStorage`)

## 6. Fonctionnalités ajoutées ensuite

- **Chat privé des coupables** : les joueurs marqués coupables (Sarah
  et/ou Nicolas selon la partie) rejoignent automatiquement un canal
  invisible pour les autres dès la phase "dossier".
- **Mode Game Master** : à la création d'une salle, cocher
  "Je suis Game Master" pour ne pas jouer et à la place contrôler la
  partie : lancer la partie, avancer les phases, révéler un indice à
  la demande, mettre en pause / reprendre le chronomètre, voir la
  solution complète à tout moment, redémarrer la partie. Ces actions
  sont refusées côté serveur à tout joueur normal.
- **Exclusion d'un joueur** : dans le lobby, l'hôte (ou le Game
  Master) peut exclure n'importe quel joueur (sauf lui-même) via un
  bouton "Exclure" à côté de son nom. Le joueur exclu est notifié et
  ramené à l'écran d'accueil.
- **Anti-doublon** : impossible de rejoindre une salle avec un nom
  déjà utilisé par un autre joueur (ou le Game Master) de cette même
  salle ; impossible aussi de créer ou rejoindre une deuxième salle
  depuis le même onglet de navigateur sans le quitter au préalable.

## 8. Ajustements suite aux retours de test

- **Présence fiable** : un joueur qui bascule sur une autre
  application (changement d'appli, verrouillage d'écran) est
  maintenant immédiatement marqué "déconnecté" pour les autres, puis
  redevient "connecté" dès qu'il revient sur l'onglet du jeu — sans
  perdre sa progression.
- **Une seule phase d'enquête, plus longue** : les anciennes phases
  "Investigation" et "Discussion" sont fusionnées en une seule phase
  "Enquête" de 18 minutes par défaut (réglable entre 15 et 20 minutes
  dans `data/rules.json`, clé `phaseDurations.enquete`). Le vote a
  lieu juste après.
- **Temps de lecture du dossier augmenté** : la phase "Dossier secret"
  passe de 30 secondes à 4 minutes par défaut
  (`phaseDurations.dossier`), et le dossier reste consultable à tout
  moment pendant l'enquête et le vote via le bouton "Mon dossier" en
  haut de l'écran.
- **Personnage affiché à côté du pseudo** : dès qu'une partie a
  démarré, le nom du personnage de chaque joueur apparaît à côté de
  son pseudo — dans la liste des suspects ET dans la liste de vote —
  pour faciliter les accusations. Le statut coupable/innocent réel,
  lui, reste strictement privé (c'est le cœur du jeu : le révéler à
  tous supprimerait l'enquête).
- **Histoire adaptée au nombre de joueurs connectés** : les indices
  et informations qui mentionnent un personnage absent de la partie
  (parce qu'il n'a pas été distribué à un joueur cette fois-ci) ne
  sont plus affichés — seuls les indices et informations pertinents
  pour les personnages réellement en jeu apparaissent.

## 8bis. Manche unique + accusation finale libre (remplace le vote/élimination en boucle)

- **Une seule manche d'enquête**, longue : 20 minutes par défaut, réglable
  dans `data/rules.json` (`phaseDurations.enquete`). Il n'y a plus de
  vote intermédiaire ni d'élimination qui relançait une nouvelle enquête.
- À la fin de l'enquête s'ouvre la phase **Accusation finale** (2 minutes
  par défaut, `phaseDurations.accusation`) : chaque joueur coche, une
  seule fois et **sans retour en arrière possible**, le ou les suspects
  qu'il pense coupables (0, 1 ou plusieurs — utile quand la partie compte
  2 coupables). Personne n'est éliminé.
- Score selon la précision : +40 par coupable correctement identifié,
  -15 par innocent accusé à tort, +20 de bonus en cas d'accusation
  parfaite (exactement les bons coupables, aucun innocent). La révélation
  finale affiche le verdict de chaque joueur et son résultat.
- L'accusation formelle "de jeu de rôle" pendant l'enquête (bouton
  "Faire une accusation formelle" dans le chat) reste disponible pour le
  bluff et les points bonus, mais n'a plus d'effet sur la partie — c'est
  l'accusation finale scellée qui compte pour le résultat.

## 8ter. Nouvelle identité visuelle

Le graphisme a été entièrement refait dans un thème "dossier d'enquête
chic" : palette encre nocturne / laiton vieilli / parchemin et rouge cire
à cacheter, typographies Playfair Display + Cormorant Garamond (chargées
via Google Fonts) et étiquettes façon machine à écrire (Special Elite),
grain de papier subtil, tampons et ornements dessinés en CSS/SVG — sans
dépendance à des images externes, donc rien à casser au déploiement.

## 9. Deuxième scénario : "RIDEAU FINAL" (difficile)

Un second scénario est disponible, choisi dans le lobby par l'hôte
(ou le Game Master) avant de lancer la partie :

- **Histoire** : après la première d'une pièce de théâtre, le
  metteur en scène Vincent Delacroix est retrouvé mort dans sa loge.
- **Pourquoi c'est plus difficile** : les deux coupables (Camille et
  Hugo) ont un alibi mutuel donné par un témoin — Nadia — qui ment,
  mais pas pour couvrir un meurtre : elle protège leur liaison
  secrète, sans se douter qu'elle innocente peut-être un meurtrier.
  Les vrais indices qui les trahissent (badge de porte de service,
  montre arrêtée, journal de la console lumière, SMS envoyé après
  coup) n'arrivent que tard dans l'enquête, pendant que six autres
  personnages affichent des motifs bien plus visibles mais sont
  innocents.
- Structure technique identique au Jeu 01 : `data/scenarios/jeu02/`
  contient `manifest.json`, `story.json`, `characters.json`,
  `clues.json`, `timeline.json`, `locations.json`, `questions.json`,
  `solution.json`.

Pour ajouter un futur Jeu 03, dupliquer un dossier de
`data/scenarios/` avec un nouvel identifiant et remplir les mêmes
fichiers — le serveur le détecte automatiquement au démarrage et le
propose dans le sélecteur de scénario du lobby.

## 7. Pas encore implémenté (nécessite une décision d'infrastructure)

- **Base de données persistante** (PostgreSQL/MySQL/MongoDB) : pour
  l'instant tout est en mémoire serveur (les parties sont perdues si
  le serveur redémarre). C'est volontaire pour le prototype — le
  cahier des charges le prévoit ainsi ("pour le prototype, les données
  peuvent être stockées dans des fichiers JSON"). Ajouter une vraie
  base de données suppose de choisir un hébergeur qui la fournit
  (Render/Railway proposent un Postgres géré, par exemple) : dites-moi
  laquelle et je branche le code dessus.
- **Détection automatique des mensonges** : volontairement absente,
  conformément au cahier des charges — les joueurs doivent raisonner
  eux-mêmes.
- **Jeu 02 et scénarios suivants** : le moteur est prêt à être
  réutilisé, il suffit d'ajouter de nouveaux fichiers dans `data/`.
- **Déploiement effectif en ligne** : je ne peux pas le faire depuis
  cet environnement (pas d'accès réseau sortant, `npm install` y est
  bloqué). Le code est prêt ; suivez la section 3 ci-dessus pour le
  mettre en ligne vous-même (Render/Railway/Fly.io ou `ngrok` pour un
  test rapide).
