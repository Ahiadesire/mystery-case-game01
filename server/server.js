/**
 * SERVEUR AUTORITAIRE — JEU 01 : LE DERNIER DÎNER
 * ------------------------------------------------
 * Le client ne décide jamais : qui est coupable, qui est éliminé,
 * combien de coupables existent, quelles infos sont privées,
 * quelles preuves sont débloquées, ni le chronomètre.
 * Tout est calculé et validé ici.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const { customAlphabet } = require('nanoid');

// ---------- Chargement des scénarios (contenu séparé du moteur) ----------
const dataDir = path.join(__dirname, '..', 'data');
const scenariosDir = path.join(dataDir, 'scenarios');
const loadJSON = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf-8'));

const RULES = loadJSON(path.join(dataDir, 'rules.json')); // règles globales (durées de phase, min/max joueurs)

// Charge chaque scénario présent dans data/scenarios/<id>/ et pré-calcule ses index.
function loadScenario(scenarioId) {
  const dir = path.join(scenariosDir, scenarioId);
  const manifest = loadJSON(path.join(dir, 'manifest.json'));
  const story = loadJSON(path.join(dir, 'story.json'));
  const characters = loadJSON(path.join(dir, 'characters.json'));
  const clues = loadJSON(path.join(dir, 'clues.json')).sort((a, b) => a.order - b.order);
  const timeline = loadJSON(path.join(dir, 'timeline.json'));
  const locations = loadJSON(path.join(dir, 'locations.json'));
  const questions = loadJSON(path.join(dir, 'questions.json'));
  const solution = loadJSON(path.join(dir, 'solution.json'));
  return {
    id: manifest.id,
    title: manifest.title,
    difficulty: manifest.difficulty,
    guiltyPool: manifest.guiltyPool,
    guiltyRules: manifest.guiltyRules,
    story, characters, clues, timeline, locations, questions, solution,
    charById: Object.fromEntries(characters.map((c) => [c.id, c])),
    allCharNames: characters.map((c) => c.name)
  };
}

const SCENARIOS = Object.fromEntries(
  fs.readdirSync(scenariosDir)
    .filter((name) => fs.statSync(path.join(scenariosDir, name)).isDirectory())
    .map((id) => [id, loadScenario(id)])
);
const DEFAULT_SCENARIO_ID = Object.keys(SCENARIOS).sort()[0];
const SCENARIO_LIST = Object.values(SCENARIOS).map((s) => ({
  id: s.id, title: s.title, difficulty: s.difficulty
}));

function scenarioOf(room) {
  return SCENARIOS[room.scenarioId] || SCENARIOS[DEFAULT_SCENARIO_ID];
}

// ---------- Config serveur ----------
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // écoute sur toutes les interfaces réseau -> accessible à distance une fois déployé/exposé

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // en production, restreindre au domaine du front-end
});

// ---------- Générateur de code de salle ----------
const genRoomCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 5);

// ---------- État en mémoire (pour le prototype ; DB réelle plus tard) ----------
/**
 * rooms: Map<code, Room>
 * Room = {
 *   code, hostPlayerId, phase, phaseEndsAt,
 *   players: Map<playerId, Player>,
 *   characterAssignments: Map<playerId, characterId>,
 *   guiltyCharacterIds: string[],
 *   revealedClueCount: number,
 *   clueTimer, phaseTimer,
 *   votes: Map<voterPlayerId, targetPlayerId>,
 *   eliminatedPlayerIds: Set<playerId>,
 *   round: number,
 *   chatLog: [{playerId, name, text, ts}],
 *   guiltyChatLog: [{playerId, name, text, ts}],
 *   gameMaster: { id, socketId, name } | null,
 *   paused: boolean,
 *   pauseRemainingMs: number | null
 * }
 * Player = { id, token, name, socketId, connected, isHost, alive }
 */
const rooms = new Map();

// Un GM (s'il existe) ou l'hôte joueur contrôle la partie
function controllerId(room) {
  return room.gameMaster ? room.gameMaster.id : room.hostPlayerId;
}
function isController(room, socket) {
  if (room.gameMaster) return socket.data.isGameMaster === true;
  return socket.data.playerId === room.hostPlayerId;
}

const PHASES = [
  'lobby', 'distribution', 'dossier', 'enquete',
  'vote', 'elimination', 'reveal'
];

// ---------- Utilitaires ----------
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeToken() {
  return customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24)();
}

function makePlayerId() {
  return customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12)();
}

function getRoomOrThrow(code) {
  const room = rooms.get(code);
  if (!room) throw new Error('Salle introuvable.');
  return room;
}

function publicPlayerList(room) {
  const scenario = scenarioOf(room);
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    isHost: p.isHost,
    connected: p.connected,
    alive: p.alive,
    characterName: room.phase === 'lobby' || room.phase === 'distribution'
      ? null
      : (room.characterAssignments.get(p.id)
          ? scenario.charById[room.characterAssignments.get(p.id)].name
          : null)
  }));
}

function roomSummary(room) {
  return {
    code: room.code,
    phase: room.phase,
    phaseEndsAt: room.phaseEndsAt,
    players: publicPlayerList(room),
    minPlayers: RULES.minPlayers,
    maxPlayers: RULES.maxPlayers,
    round: room.round,
    scenarioId: room.scenarioId,
    scenarioTitle: scenarioOf(room).title,
    scenarioDifficulty: scenarioOf(room).difficulty,
    availableScenarios: SCENARIO_LIST
  };
}

function broadcastRoomState(room) {
  io.to(room.code).emit('room:state', roomSummary(room));
}

function pushChat(room, entry) {
  room.chatLog.push(entry);
  io.to(room.code).emit('chat:message', entry);
}

// ---------- RÈGLE : détermination du nombre de coupables (dépend du scénario) ----------
function guiltyRuleFor(scenario, playerCount) {
  const rule = scenario.guiltyRules.find(
    (r) => playerCount >= r.minPlayers && playerCount <= r.maxPlayers
  );
  if (!rule) throw new Error('Nombre de joueurs hors des règles autorisées.');
  return rule;
}

// ---------- DISTRIBUTION DES PERSONNAGES (serveur uniquement) ----------
function distributeCharacters(room) {
  const scenario = scenarioOf(room);
  const players = [...room.players.values()];
  const n = players.length;
  const rule = guiltyRuleFor(scenario, n);
  const pool = scenario.guiltyPool;

  let requiredGuiltyIds = [];
  if (rule.mode === 'random-one') {
    requiredGuiltyIds = [pool[Math.floor(Math.random() * pool.length)]];
  } else if (rule.mode === 'both') {
    requiredGuiltyIds = [...pool];
  } else {
    throw new Error('Mode de sélection des coupables inconnu.');
  }

  // Les coupables requis DOIVENT faire partie des personnages distribués
  const remainingCharIds = scenario.characters
    .map((c) => c.id)
    .filter((id) => !requiredGuiltyIds.includes(id));

  const shuffledRemaining = shuffle(remainingCharIds);
  const chosenCharIds = shuffle([
    ...requiredGuiltyIds,
    ...shuffledRemaining.slice(0, n - requiredGuiltyIds.length)
  ]);

  if (chosenCharIds.length !== n) {
    throw new Error('Erreur de distribution : nombre de personnages incorrect.');
  }

  const shuffledPlayers = shuffle(players);
  const assignments = new Map();
  shuffledPlayers.forEach((p, idx) => {
    assignments.set(p.id, chosenCharIds[idx]);
  });

  // VÉRIFICATION FINALE OBLIGATOIRE avant de démarrer
  const actualGuiltyCount = [...assignments.values()]
    .filter((cid) => requiredGuiltyIds.includes(cid)).length;

  if (actualGuiltyCount !== rule.guiltyCount) {
    throw new Error(
      `Vérification échouée : ${actualGuiltyCount} coupable(s) au lieu de ${rule.guiltyCount}. La partie ne démarre pas.`
    );
  }

  // Pas deux joueurs avec le même personnage, pas de joueur sans personnage
  const distinctChars = new Set(assignments.values());
  if (distinctChars.size !== n) {
    throw new Error('Erreur de distribution : personnages en double détectés.');
  }

  room.characterAssignments = assignments;
  room.guiltyCharacterIds = requiredGuiltyIds;
  return { requiredGuiltyIds, guiltyCount: rule.guiltyCount };
}

// ---------- GESTION DES PHASES ----------
function clearTimers(room) {
  if (room.phaseTimer) clearTimeout(room.phaseTimer);
  if (room.clueTimer) clearInterval(room.clueTimer);
  room.phaseTimer = null;
  room.clueTimer = null;
}

function setPhase(room, phase, durationSeconds) {
  clearTimers(room);
  room.phase = phase;
  room.phaseEndsAt = durationSeconds ? Date.now() + durationSeconds * 1000 : null;

  if (durationSeconds) {
    room.phaseTimer = setTimeout(() => advancePhase(room), durationSeconds * 1000);
  }

  if (phase === 'enquete') {
    // Ne garder que les indices pertinents pour les personnages réellement
    // distribués cette partie (+ les indices génériques sans personnage lié),
    // pour que l'histoire s'adapte au nombre de joueurs connectés.
    const distributedIds = new Set(room.characterAssignments.values());
    room.activeClues = scenarioOf(room).clues.filter(
      (c) => c.linkedCharacterId === null || distributedIds.has(c.linkedCharacterId)
    );
    room.revealedClueCount = 0;
    startClueTimer(room, durationSeconds);
  }

  if (phase === 'vote') {
    room.votes = new Map();
  }

  broadcastRoomState(room);
  io.to(room.code).emit('phase:changed', { phase, phaseEndsAt: room.phaseEndsAt, round: room.round });

  if (phase === 'dossier') {
    // envoyer à CHAQUE joueur (privé) son propre dossier
    for (const p of room.players.values()) {
      if (!p.socketId) continue;
      io.to(p.socketId).emit('dossier:yours', buildDossier(room, p.id));
      const charId = room.characterAssignments.get(p.id);
      if (room.guiltyCharacterIds.includes(charId)) {
        io.sockets.sockets.get(p.socketId)?.join(`${room.code}:guilty`);
        io.to(p.socketId).emit('chat:guilty:enabled', room.guiltyChatLog);
      }
    }
  }

  if (phase === 'reveal') {
    io.to(room.code).emit('game:reveal', buildReveal(room));
  }
}

function startClueTimer(room, phaseDurationSeconds) {
  const clues = room.activeClues || [];
  if (clues.length === 0) return;
  // Étale la révélation des indices sur toute la durée de la phase d'enquête,
  // avec un minimum entre deux indices pour ne pas les envoyer trop vite.
  const spread = Math.floor((phaseDurationSeconds * 1000) / (clues.length + 1));
  const interval = Math.max(RULES.clueRevealMinIntervalSeconds * 1000, spread);
  room.clueTimer = setInterval(() => {
    if (room.revealedClueCount >= clues.length) {
      clearInterval(room.clueTimer);
      room.clueTimer = null;
      return;
    }
    const clue = clues[room.revealedClueCount];
    room.revealedClueCount += 1;
    io.to(room.code).emit('clue:revealed', clue);
  }, interval);
}

function advancePhase(room) {
  const idx = PHASES.indexOf(room.phase);
  let next = PHASES[idx + 1] || 'reveal';

  // Boucle : après élimination, si la partie continue, on repart en enquête
  if (room.phase === 'elimination') {
    const outcome = checkWinCondition(room);
    if (outcome) {
      setPhase(room, 'reveal', null);
      io.to(room.code).emit('game:over', outcome);
      return;
    }
    room.round += 1;
    setPhase(room, 'enquete', RULES.phaseDurations.enquete);
    return;
  }

  const durations = RULES.phaseDurations;
  setPhase(room, next, durations[next] || null);
}

// ---------- DOSSIER PRIVÉ ----------
// Retire les lignes d'information qui font référence à un personnage absent
// de la partie en cours, pour que l'histoire s'adapte au nombre de joueurs.
function filterInfoToPresentCharacters(scenario, informations, presentNames) {
  return informations.filter((line) => {
    const mentionsAbsentCharacter = scenario.allCharNames.some(
      (n) => !presentNames.has(n) && line.includes(n)
    );
    return !mentionsAbsentCharacter;
  });
}

function buildDossier(room, playerId) {
  const scenario = scenarioOf(room);
  const charId = room.characterAssignments.get(playerId);
  const char = scenario.charById[charId];
  const isGuilty = room.guiltyCharacterIds.includes(charId);
  const presentNames = new Set(
    [...room.characterAssignments.values()].map((id) => scenario.charById[id].name)
  );
  return {
    identite: { nom: char.name, age: char.age, role: char.role },
    relation: char.public.relation,
    motif: char.private.motif,
    secret: char.private.secret,
    alibi: char.private.alibi,
    opportunite: char.private.opportunite,
    informations: filterInfoToPresentCharacters(scenario, char.private.informations, presentNames),
    objectif: char.private.objectif,
    statut: isGuilty ? 'COUPABLE' : 'INNOCENT',
    partenaires: isGuilty && room.guiltyCharacterIds.length > 1
      ? room.guiltyCharacterIds
          .filter((id) => id !== charId)
          .map((id) => scenario.charById[id].name)
      : []
  };
}

// ---------- VOTE ----------
function castVote(room, voterPlayerId, targetPlayerId) {
  const voter = room.players.get(voterPlayerId);
  const target = room.players.get(targetPlayerId);
  if (!voter || !voter.alive) throw new Error('Joueur éliminé : vote impossible.');
  if (!target || !target.alive) throw new Error('Cible invalide.');
  if (voterPlayerId === targetPlayerId) throw new Error('Un joueur ne peut pas voter pour lui-même.');
  room.votes.set(voterPlayerId, targetPlayerId);

  const alivePlayers = [...room.players.values()].filter((p) => p.alive);
  io.to(room.code).emit('vote:progress', {
    votesCast: room.votes.size,
    totalAlive: alivePlayers.length
  });

  if (room.votes.size >= alivePlayers.length) {
    resolveVote(room);
  }
}

function resolveVote(room) {
  clearTimers(room);
  const scenario = scenarioOf(room);
  const tally = new Map();
  for (const targetId of room.votes.values()) {
    tally.set(targetId, (tally.get(targetId) || 0) + 1);
  }
  let max = 0;
  let winners = [];
  for (const [targetId, count] of tally.entries()) {
    if (count > max) { max = count; winners = [targetId]; }
    else if (count === max) { winners.push(targetId); }
  }

  let eliminatedId = null;
  if (winners.length === 1 && max > 0) {
    eliminatedId = winners[0];
    const player = room.players.get(eliminatedId);
    player.alive = false;
    const charId = room.characterAssignments.get(eliminatedId);
    io.to(room.code).emit('vote:result', {
      tie: false,
      eliminatedPlayerId: eliminatedId,
      eliminatedName: player.name,
      eliminatedCharacterName: scenario.charById[charId].name,
      wasGuilty: room.guiltyCharacterIds.includes(charId),
      tally: Object.fromEntries(tally)
    });
  } else {
    io.to(room.code).emit('vote:result', {
      tie: true,
      tally: Object.fromEntries(tally)
    });
  }

  setPhase(room, 'elimination', RULES.phaseDurations.elimination);
}

// ---------- CONDITIONS DE VICTOIRE ----------
function checkWinCondition(room) {
  const alive = [...room.players.values()].filter((p) => p.alive);
  const aliveGuilty = alive.filter((p) =>
    room.guiltyCharacterIds.includes(room.characterAssignments.get(p.id))
  );
  const aliveInnocent = alive.filter((p) =>
    !room.guiltyCharacterIds.includes(room.characterAssignments.get(p.id))
  );

  if (aliveGuilty.length === 0) {
    return { winner: 'innocents', reason: 'Tous les coupables ont été éliminés.' };
  }
  if (aliveGuilty.length >= aliveInnocent.length) {
    return { winner: 'coupables', reason: 'Les coupables sont majoritaires ou à égalité parmi les survivants.' };
  }
  return null; // la partie continue
}

// ---------- RÉVÉLATION FINALE ----------
function buildReveal(room) {
  const scenario = scenarioOf(room);
  const guiltyDetails = room.guiltyCharacterIds.map((id) => ({
    character: scenario.charById[id].name,
    explanation: scenario.solution.guiltyExplanations[id] || ''
  }));
  return {
    victim: scenario.story.victim,
    guilty: guiltyDetails,
    falseLeadsSummary: scenario.solution.falseLeadsSummary,
    timeline: scenario.timeline,
    closingLine: scenario.solution.closingLine,
    assignments: [...room.characterAssignments.entries()].map(([playerId, charId]) => ({
      playerName: room.players.get(playerId)?.name,
      characterName: scenario.charById[charId].name,
      wasGuilty: room.guiltyCharacterIds.includes(charId)
    }))
  };
}

// ---------- SOCKET.IO : ÉVÉNEMENTS TEMPS RÉEL ----------
io.on('connection', (socket) => {

  socket.on('room:create', ({ name, asGameMaster }, cb) => {
    try {
      if (socket.data.roomCode) throw new Error('Tu es déjà connecté à une salle depuis cet onglet. Ferme-le ou quitte la salle en cours avant d\'en créer une nouvelle.');
      if (!name || !name.trim()) throw new Error('Nom requis.');
      let code;
      do { code = genRoomCode(); } while (rooms.has(code));

      const playerId = makePlayerId();
      const token = makeToken();

      const room = {
        code,
        hostPlayerId: playerId,
        scenarioId: DEFAULT_SCENARIO_ID,
        phase: 'lobby',
        phaseEndsAt: null,
        players: new Map(),
        characterAssignments: new Map(),
        guiltyCharacterIds: [],
        revealedClueCount: 0,
        activeClues: [],
        clueTimer: null,
        phaseTimer: null,
        votes: new Map(),
        round: 1,
        chatLog: [],
        guiltyChatLog: [],
        gameMaster: null,
        paused: false,
        pauseRemainingMs: null
      };

      if (asGameMaster) {
        // Le Game Master ne joue pas : pas de personnage, pas de dossier,
        // mais contrôle la partie (spec section 53).
        room.gameMaster = { id: playerId, token, socketId: socket.id, name: name.trim() };
        rooms.set(code, room);
        socket.join(code);
        socket.data.roomCode = code;
        socket.data.playerId = playerId;
        socket.data.isGameMaster = true;
        cb({ ok: true, code, playerId, token, room: roomSummary(room), isGameMaster: true });
        broadcastRoomState(room);
        return;
      }

      room.players.set(playerId, {
        id: playerId, token, name: name.trim(), socketId: socket.id,
        connected: true, isHost: true, alive: true
      });
      rooms.set(code, room);

      socket.join(code);
      socket.data.roomCode = code;
      socket.data.playerId = playerId;

      cb({ ok: true, code, playerId, token, room: roomSummary(room), isGameMaster: false });
      broadcastRoomState(room);
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  socket.on('room:join', ({ name, code }, cb) => {
    try {
      if (socket.data.roomCode) throw new Error('Tu es déjà connecté à une salle depuis cet onglet. Ferme-le ou quitte la salle en cours avant d\'en rejoindre une nouvelle.');
      const room = getRoomOrThrow((code || '').toUpperCase());
      if (room.phase !== 'lobby') throw new Error('La partie a déjà commencé.');
      if (room.players.size >= RULES.maxPlayers) throw new Error('Salle complète (12 joueurs maximum).');
      if (!name || !name.trim()) throw new Error('Nom requis.');

      const normalizedName = name.trim().toLowerCase();
      const nameTaken = [...room.players.values()].some((p) => p.name.toLowerCase() === normalizedName)
        || (room.gameMaster && room.gameMaster.name.toLowerCase() === normalizedName);
      if (nameTaken) throw new Error('Ce nom est déjà utilisé dans cette salle. Choisis-en un autre.');

      const playerId = makePlayerId();
      const token = makeToken();
      room.players.set(playerId, {
        id: playerId, token, name: name.trim(), socketId: socket.id,
        connected: true, isHost: false, alive: true
      });

      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.playerId = playerId;

      cb({ ok: true, code: room.code, playerId, token, room: roomSummary(room) });
      broadcastRoomState(room);
      pushChat(room, { system: true, text: `${name.trim()} a rejoint la salle.`, ts: Date.now() });
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  // Reconnexion : le personnage/dossier/statut/progression restent associés au joueur
  socket.on('room:reconnect', ({ code, playerId, token }, cb) => {
    try {
      const room = getRoomOrThrow((code || '').toUpperCase());

      if (room.gameMaster && room.gameMaster.id === playerId) {
        if (room.gameMaster.token !== token) throw new Error('Reconnexion invalide.');
        room.gameMaster.socketId = socket.id;
        socket.join(room.code);
        socket.data.roomCode = room.code;
        socket.data.playerId = playerId;
        socket.data.isGameMaster = true;
        cb({ ok: true, room: roomSummary(room), phase: room.phase, isGameMaster: true });
        return;
      }

      const player = room.players.get(playerId);
      if (!player || player.token !== token) throw new Error('Reconnexion invalide.');

      player.socketId = socket.id;
      player.connected = true;
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.playerId = playerId;

      cb({ ok: true, room: roomSummary(room), phase: room.phase, isGameMaster: false });
      if (room.phase !== 'lobby' && room.phase !== 'distribution') {
        socket.emit('dossier:yours', buildDossier(room, playerId));
        if (room.guiltyCharacterIds.includes(room.characterAssignments.get(playerId))) {
          socket.join(`${room.code}:guilty`);
          socket.emit('chat:guilty:enabled', room.guiltyChatLog);
        }
      }
      broadcastRoomState(room);
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  // Exclure un joueur de la salle (hôte ou Game Master, en lobby uniquement)
  socket.on('room:kick', ({ targetPlayerId }, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.roomCode);
      if (!isController(room, socket)) throw new Error('Réservé à l\'hôte ou au Game Master.');
      if (room.phase !== 'lobby') throw new Error('Impossible d\'exclure un joueur après le lancement de la partie.');
      const target = room.players.get(targetPlayerId);
      if (!target) throw new Error('Joueur introuvable.');
      if (targetPlayerId === room.hostPlayerId) throw new Error('Impossible d\'exclure l\'hôte.');

      room.players.delete(targetPlayerId);
      if (target.socketId) {
        io.to(target.socketId).emit('room:kicked', {});
        const targetSocket = io.sockets.sockets.get(target.socketId);
        if (targetSocket) {
          targetSocket.leave(room.code);
          targetSocket.data.roomCode = null;
          targetSocket.data.playerId = null;
        }
      }
      pushChat(room, { system: true, text: `${target.name} a été exclu(e) de la salle.`, ts: Date.now() });
      broadcastRoomState(room);
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  socket.on('room:start', (_payload, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.roomCode);
      if (!isController(room, socket)) throw new Error('Seul l\'hôte (ou le Game Master) peut lancer la partie.');
      const n = room.players.size;
      if (n < RULES.minPlayers || n > RULES.maxPlayers) {
        throw new Error(`Il faut entre ${RULES.minPlayers} et ${RULES.maxPlayers} joueurs.`);
      }
      const scenario = scenarioOf(room);

      setPhase(room, 'distribution', RULES.phaseDurations.distribution);
      const { guiltyCount } = distributeCharacters(room);

      io.to(room.code).emit('story:intro', {
        text: scenario.story.publicIntroTemplate.replace('{{playerCount}}', String(n)),
        victim: scenario.story.victim,
        locations: scenario.locations,
        questions: scenario.questions,
        timeline: scenario.timeline,
        guiltyCount
      });

      cb({ ok: true });
      setTimeout(() => setPhase(room, 'dossier', RULES.phaseDurations.dossier), RULES.phaseDurations.distribution * 1000);
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  // Choisir le scénario à jouer (hôte ou Game Master, en lobby uniquement)
  socket.on('room:set_scenario', ({ scenarioId }, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.roomCode);
      if (!isController(room, socket)) throw new Error('Seul l\'hôte (ou le Game Master) peut choisir le scénario.');
      if (room.phase !== 'lobby') throw new Error('Impossible de changer de scénario après le lancement.');
      if (!SCENARIOS[scenarioId]) throw new Error('Scénario inconnu.');
      room.scenarioId = scenarioId;
      broadcastRoomState(room);
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  socket.on('phase:advance', (_payload, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.roomCode);
      if (!isController(room, socket)) throw new Error('Seul l\'hôte (ou le Game Master) peut avancer la phase.');
      advancePhase(room);
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  // ---------- ÉVÉNEMENTS RÉSERVÉS AU GAME MASTER ----------
  socket.on('gm:reveal_clue_now', (_payload, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.roomCode);
      if (!isController(room, socket)) throw new Error('Réservé au Game Master.');
      const clues = room.activeClues || [];
      if (room.revealedClueCount >= clues.length) throw new Error('Tous les indices ont déjà été révélés.');
      const clue = clues[room.revealedClueCount];
      room.revealedClueCount += 1;
      io.to(room.code).emit('clue:revealed', clue);
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  socket.on('gm:pause', (_payload, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.roomCode);
      if (!isController(room, socket)) throw new Error('Réservé au Game Master.');
      if (room.paused) throw new Error('La partie est déjà en pause.');
      room.paused = true;
      room.pauseRemainingMs = room.phaseEndsAt ? Math.max(0, room.phaseEndsAt - Date.now()) : null;
      clearTimers(room);
      io.to(room.code).emit('phase:paused', {});
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  socket.on('gm:resume', (_payload, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.roomCode);
      if (!isController(room, socket)) throw new Error('Réservé au Game Master.');
      if (!room.paused) throw new Error('La partie n\'est pas en pause.');
      room.paused = false;
      if (room.pauseRemainingMs != null) {
        room.phaseEndsAt = Date.now() + room.pauseRemainingMs;
        room.phaseTimer = setTimeout(() => advancePhase(room), room.pauseRemainingMs);
      }
      if (room.phase === 'enquete' && room.revealedClueCount < (room.activeClues || []).length) {
        startClueTimer(room, Math.max(1, Math.round((room.phaseEndsAt - Date.now()) / 1000)));
      }
      io.to(room.code).emit('phase:resumed', { phaseEndsAt: room.phaseEndsAt });
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  socket.on('gm:view_solution', (_payload, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.roomCode);
      if (!isController(room, socket)) throw new Error('Réservé au Game Master.');
      cb({ ok: true, solution: buildReveal(room) });
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  socket.on('gm:restart', (_payload, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.roomCode);
      if (!isController(room, socket)) throw new Error('Réservé au Game Master.');
      clearTimers(room);
      for (const p of room.players.values()) {
        p.alive = true;
      }
      room.characterAssignments = new Map();
      room.guiltyCharacterIds = [];
      room.revealedClueCount = 0;
      room.activeClues = [];
      room.votes = new Map();
      room.round = 1;
      room.paused = false;
      room.pauseRemainingMs = null;
      room.chatLog = [];
      room.guiltyChatLog = [];
      room.phase = 'lobby';
      room.phaseEndsAt = null;
      io.to(room.code).emit('game:restarted');
      broadcastRoomState(room);
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  // ---------- CHAT PRIVÉ DES COUPABLES ----------
  socket.on('chat:guilty:send', ({ text }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players.get(socket.data.playerId);
    if (!player || !text || !text.trim()) return;
    const charId = room.characterAssignments.get(player.id);
    if (!room.guiltyCharacterIds.includes(charId)) return; // seuls les coupables peuvent écrire ici
    const entry = { playerId: player.id, name: player.name, text: text.trim().slice(0, 500), ts: Date.now() };
    room.guiltyChatLog.push(entry);
    io.to(`${room.code}:guilty`).emit('chat:guilty:message', entry);
  });

  socket.on('chat:send', ({ text }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players.get(socket.data.playerId);
    if (!player || !text || !text.trim()) return;
    pushChat(room, {
      playerId: player.id,
      name: player.name,
      text: text.trim().slice(0, 500),
      ts: Date.now()
    });
  });

  socket.on('vote:cast', ({ targetPlayerId }, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.roomCode);
      if (room.phase !== 'vote') throw new Error('Le vote n\'est pas ouvert.');
      castVote(room, socket.data.playerId, targetPlayerId);
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  socket.on('accusation:final', ({ suspectName, motif, opportunite, indice }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players.get(socket.data.playerId);
    if (!player) return;
    const text = `J'accuse ${suspectName}. Motif : ${motif}. Opportunité : ${opportunite}. Indice : ${indice}.`;
    pushChat(room, { playerId: player.id, name: player.name, text, ts: Date.now(), accusation: true });
  });

  // Présence fiable : le client signale explicitement quand l'onglet passe
  // en arrière-plan (changement d'appli, verrouillage d'écran, etc.) plutôt
  // que d'attendre une vraie coupure réseau.
  socket.on('presence:away', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.isGameMaster) return;
    const player = room.players.get(socket.data.playerId);
    if (!player) return;
    player.connected = false;
    broadcastRoomState(room);
  });

  socket.on('presence:back', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.isGameMaster) return;
    const player = room.players.get(socket.data.playerId);
    if (!player) return;
    player.connected = true;
    broadcastRoomState(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.isGameMaster && room.gameMaster) {
      room.gameMaster.socketId = null;
      return;
    }
    const player = room.players.get(socket.data.playerId);
    if (!player) return;
    player.connected = false;
    player.socketId = null;
    broadcastRoomState(room);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Serveur "Le Dernier Dîner" démarré sur http://${HOST}:${PORT}`);
  console.log('Pour un accès à distance : déployer ce serveur (Render/Railway/Fly.io/VPS) ou exposer le port via un tunnel (ex. ngrok) pendant les tests.');
});
