# Le Dernier Dîner — Jeu d'enquête multijoueur

Jeu de mystère, de déduction et de bluff en ligne avec **4 à 12 joueurs**.  
Stack : Node.js + Express + Socket.IO + HTML/CSS/JavaScript.

## Installation

```bash
npm install
npm start
```

Le serveur écoute sur `http://0.0.0.0:3000` et utilise `PORT` si cette variable est définie.

## Déploiement

Le projet contient `render.yaml` pour un déploiement Render. Le dépôt GitHub peut être relié à Render avec :

- Build : `npm install`
- Start : `npm start`

Pour un test local : `http://localhost:3000`.

> Les salles sont actuellement conservées en mémoire. Une coupure/reprise réseau d'un joueur est gérée, mais un redémarrage complet du serveur détruit les salles en cours.

## Fonctionnement actuel

### 1. Une affaire tirée au sort

Tous les scénarios sont regroupés dans `data/scenarios/`. Le moteur détecte automatiquement les dossiers et peut charger **jusqu'à 20 scénarios**.

Le projet contient actuellement **11 affaires** :

- `jeu01` — LE DERNIER DÎNER
- `jeu02` — RIDEAU FINAL
- `jeu03` — NUIT EN HAUTE MER
- `jeu04` — LE MARIAGE EMPOISONNÉ
- `jeu05` — LE MUSÉE DES OMBRES
- `jeu06` — L'HÔTEL SANS LUMIÈRE
- `jeu07` — LA DERNIÈRE PARTIE
- `jeu08` — LE VOL DE MINUIT
- `jeu09` — LE TRAIN DE NUIT
- `jeu10` — LE CHALET ISOLÉ
- `jeu11` — RIDEAU ROUGE

À la création de la salle, le serveur tire une affaire aléatoire. L'hôte/Game Master ne voit plus une longue liste : il dispose simplement de **Changer d'affaire**.

Une salle mémorise les affaires déjà jouées. Lorsqu'une nouvelle partie est lancée, une affaire non encore jouée est choisie automatiquement et le scénario actuel est évité. Une fois tout le catalogue épuisé, un nouveau cycle commence.

Le serveur vérifie aussi la compatibilité avec le nombre de joueurs : une affaire limitée à 4–6 joueurs ne sera pas lancée dans une salle de 7–12 joueurs.

### 2. Déroulement simplifié

```text
LOBBY
  ↓
DISTRIBUTION DES RÔLES
  ↓
DOSSIER SECRET
  ↓
ENQUÊTE
  ↓
VOTE FINAL (secret, un suspect par joueur)
  ↓
RÉVÉLATION
```

L'écran d'enquête reste volontairement épuré (pas de tableau de déduction ni d'aide automatique), mais un vote final secret précède la révélation : chaque joueur désigne le suspect qu'il pense coupable avant que la vérité, les votes et le classement ne soient dévoilés.

### 3. Enquête plus difficile

L'écran d'enquête est volontairement réduit à quatre éléments :

- indices révélés ;
- chronologie ;
- suspects présents ;
- discussion en direct.

Les cartes, tableaux de déduction, aides automatiques, votes de confiance et autres panneaux secondaires ont été retirés de l'interface principale.

Les métadonnées internes des indices ne sont plus envoyées au navigateur. De plus, les indices directement liés aux coupables sont placés plus tard dans la séquence de révélation afin de laisser davantage de temps aux joueurs pour comparer les alibis, motifs et contradictions.

### 4. Chat façon WhatsApp

Le chat dispose maintenant de :

- bulles distinctes selon l'auteur ;
- heure du message ;
- messages système ;
- aperçu du message cité ;
- bouton **Répondre** sur chaque message ;
- conservation de l'historique récent lors d'une reconnexion.

Un message peut donc répondre directement à un autre sans perdre le fil de la discussion.

### 5. Reconnexion

La session est sauvegardée dans `localStorage` avec :

- code de salle ;
- identifiant joueur ;
- jeton de reconnexion.

Après une coupure réseau, Socket.IO se reconnecte et le serveur restaure :

- le même joueur ;
- son personnage ;
- son dossier ;
- la phase actuelle ;
- les indices déjà révélés ;
- le chat récent ;
- le canal privé des coupables, si nécessaire.

Si le navigateur a perdu le jeton, le joueur peut également retaper exactement son ancien nom pour reprendre sa place tant que celle-ci est déconnectée.

### 6. Game Master

Le Game Master peut :

- lancer/terminer l'enquête ;
- révéler un indice immédiatement ;
- utiliser l'indice bonus contre 60 secondes ;
- mettre en pause/reprendre ;
- consulter la solution ;
- redémarrer la salle.

### 7. Confort de jeu

- **Règles en un clin d'œil** : un bouton « 📖 Règles du jeu » sur l'accueil ouvre un rappel des 5 étapes, utile pour accueillir de nouveaux joueurs sans réexpliquer à l'oral.
- **Code de salle copiable** en un tap dans le lobby.
- **Sons discrets** (activables/désactivables, générés sans fichier audio externe) pour un nouvel indice, un message reçu et la révélation finale.
- **Suivi de lecture du dossier** : pendant la phase secrète, chacun voit combien de joueurs ont terminé leur lecture (« 3 / 6 joueurs ont fini de lire »), pour savoir quand l'enquête peut vraiment démarrer.
- **Alerte progressive du minuteur** : orange à moins d'une minute (30 s en phase dossier), rouge clignotant dans la dernière ligne droite.
- **Zones sûres sur mobile** : l'interface respecte les encoches et barres système (iOS/Android) via `env(safe-area-inset-*)`.

## Ajouter un scénario

Créer un nouveau dossier, par exemple :

```text
data/scenarios/jeu12/
```

avec :

```text
manifest.json
story.json
characters.json
clues.json
timeline.json
locations.json
questions.json
solution.json
```

Aucune modification du moteur n'est nécessaire. Le serveur le détecte automatiquement au prochain démarrage, dans la limite de 20 scénarios chargés.

## Structure

```text
mystery-case-game01/
├── package.json
├── render.yaml
├── README.md
├── data/
│   ├── rules.json
│   └── scenarios/
│       ├── README.md
│       ├── jeu01/
│       ├── jeu02/
│       └── ...
├── server/
│   └── server.js
└── public/
    ├── index.html
    ├── app.js
    └── style.css
```
