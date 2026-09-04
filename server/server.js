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
 *   finalAccusations: Map<accuserPlayerId, accusedCharacterId[]>,
 *   accusationResults: [{playerId, playerName, accusedCharacterNames, correctCount, wrongCount, missedCount, perfect, pointsEarned}],
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
  'accusation', 'reveal'
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
    score: p.score || 0,
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
    scenarioId: room.scenarioId,
    scenarioTitle: scenarioOf(room).title,
    scenarioDifficulty: scenarioOf(room).difficulty,
    availableScenarios: SCENARIO_LIST,
    connectedPlayerCount: [...room.players.values()].filter((p) => p.connected && p.socketId).length,
    activeCharacterCount: room.characterAssignments.size,
    guiltyCount: room.guiltyCharacterIds.length || null,
    revealedClueCount: room.revealedClueCount || 0,
    activeClueCount: (room.activeClues || []).length,
    paused: !!room.paused,
    readyPlayerCount: room.readyPlayers ? room.readyPlayers.size : 0,
    connectedReadyCount: room.readyPlayers ? [...room.readyPlayers].filter((id) => room.players.get(id)?.connected && room.players.get(id)?.socketId).length : 0
  };
}

function broadcastRoomState(room) {
  io.to(room.code).emit('room:state', roomSummary(room));
}

function pushChat(room, entry) {
  room.chatLog.push(entry);
  io.to(room.code).emit('chat:message', entry);
}

function addScore(room, playerId, points, reason) {
  const p = room.players.get(playerId);
  if (!p) return;
  p.score = (p.score || 0) + points;
  p.scoreEvents = p.scoreEvents || [];
  p.scoreEvents.push({ points, reason, ts: Date.now() });
}

function publicCharacter(scenario, id) {
  const c = scenario.charById[id];
  if (!c) return null;
  return { id: c.id, name: c.name, age: c.age, role: c.role, public: c.public };
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
  const players = [...room.players.values()].filter((p) => p.connected && p.socketId);
  const n = players.length;
  // Seuls les joueurs réellement connectés au lancement participent.
  room.activePlayerIds = new Set(players.map((p) => p.id));
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

function phaseLabelServer(phase) {
  return ({ distribution: 'Distribution des rôles', dossier: 'Dossier secret', enquete: 'Enquête', accusation: 'Accusation finale', reveal: 'Révélation' }[phase] || phase);
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
    const presentNames = new Set(
      [...distributedIds].map((id) => scenarioOf(room).charById[id]?.name).filter(Boolean)
    );
    room.activeClues = scenarioOf(room).clues.filter((c) => {
      if (c.linkedCharacterId !== null && !distributedIds.has(c.linkedCharacterId)) return false;
      return !textMentionsAbsentCharacter(c.description || '', scenarioOf(room), presentNames);
    });
    room.revealedClueCount = 0;
    startClueTimer(room, durationSeconds);
  }

  if (phase === 'dossier') {
    room.readyPlayers = new Set();
  }

  if (phase === 'accusation') {
    room.finalAccusations = new Map();
  }

  broadcastRoomState(room);
  io.to(room.code).emit('phase:changed', { phase, phaseEndsAt: room.phaseEndsAt, revealedClueCount: room.revealedClueCount || 0, activeClueCount: (room.activeClues || []).length });
  if (phase !== 'lobby') pushChat(room, { system: true, text: `⏱ Phase : ${phaseLabelServer(phase)}.`, ts: Date.now() });

  if (phase === 'dossier') {
    io.to(room.code).emit('dossier:opened', { phaseEndsAt: room.phaseEndsAt });
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
  const next = PHASES[idx + 1] || 'reveal';

  // Une seule manche : à la fin de l'accusation finale (temps écoulé ou tous
  // les joueurs ont répondu), on calcule les résultats puis on révèle.
  if (room.phase === 'accusation') {
    resolveAccusations(room);
    setPhase(room, 'reveal', null);
    return;
  }

  const durations = RULES.phaseDurations;
  setPhase(room, next, durations[next] || null);
}

// ---------- DOSSIER PRIVÉ ----------
// Retire les lignes d'information qui font référence à un personnage absent
// de la partie en cours, pour que l'histoire s'adapte au nombre de joueurs.
function textMentionsAbsentCharacter(text, scenario, presentNames) {
  return scenario.allCharNames.some(
    (name) => !presentNames.has(name) && String(text).includes(name)
  );
}

function filterInfoToPresentCharacters(scenario, informations, presentNames) {
  const lines = Array.isArray(informations) ? informations : [informations].filter(Boolean);
  return lines.filter((line) => !textMentionsAbsentCharacter(line, scenario, presentNames));
}

function filterTimelineToPresentCharacters(scenario, timeline, presentNames) {
  return timeline.filter((event) =>
    !textMentionsAbsentCharacter(`${event.time || ''} ${event.event || ''}`, scenario, presentNames)
  );
}

function filterQuestionsToPresentCharacters(scenario, questions, presentNames) {
  return questions.filter((question) =>
    !textMentionsAbsentCharacter(question, scenario, presentNames)
  );
}

function filterFalseLeadsToPresentCharacters(scenario, falseLeads, presentNames) {
  return (Array.isArray(falseLeads) ? falseLeads : [])
    .filter((line) => !textMentionsAbsentCharacter(line, scenario, presentNames));
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

// ---------- ACCUSATION FINALE (libre, sans élimination) ----------
// Chaque joueur désigne, une seule fois et sans retour en arrière possible,
// le ou les personnages qu'il pense coupables (0, 1 ou plusieurs). Le score
// dépend de la précision : pas d'élimination, pas de nouvelle manche.
function submitFinalAccusation(room, accuserPlayerId, accusedPlayerIds) {
  const accuser = room.players.get(accuserPlayerId);
  if (!accuser) throw new Error('Joueur introuvable.');
  if (room.finalAccusations.has(accuserPlayerId)) throw new Error('Ton accusation a déjà été envoyée.');

  const uniqueTargetIds = [...new Set(Array.isArray(accusedPlayerIds) ? accusedPlayerIds : [])]
    .filter((pid) => pid !== accuserPlayerId && room.characterAssignments.has(pid));
  const accusedCharIds = uniqueTargetIds.map((pid) => room.characterAssignments.get(pid));

  room.finalAccusations.set(accuserPlayerId, accusedCharIds);

  io.to(room.code).emit('accusation:progress', {
    submitted: room.finalAccusations.size,
    total: room.players.size
  });

  if (room.finalAccusations.size >= room.players.size) {
    resolveAccusations(room);
    setPhase(room, 'reveal', null);
  }
}

function resolveAccusations(room) {
  clearTimers(room);
  const scenario = scenarioOf(room);
  const guiltySet = new Set(room.guiltyCharacterIds);
  const results = [];

  for (const player of room.players.values()) {
    const accusedIds = room.finalAccusations.get(player.id) || [];
    const accusedSet = new Set(accusedIds);
    const correctCount = accusedIds.filter((id) => guiltySet.has(id)).length;
    const wrongCount = accusedIds.filter((id) => !guiltySet.has(id)).length;
    const missedCount = [...guiltySet].filter((id) => !accusedSet.has(id)).length;
    const perfect = wrongCount === 0 && missedCount === 0 && accusedIds.length === guiltySet.size;

    let points = correctCount * 40 - wrongCount * 15;
    if (perfect) points += 20;

    const reason = accusedIds.length === 0
      ? 'Aucune accusation envoyée'
      : perfect
        ? 'Accusation parfaite : tous les coupables identifiés'
        : `${correctCount} coupable(s) trouvé(s), ${wrongCount} innocent(s) accusé(s) à tort`;

    addScore(room, player.id, points, reason);

    results.push({
      playerId: player.id,
      playerName: player.name,
      accusedCharacterNames: accusedIds.map((id) => scenario.charById[id]?.name).filter(Boolean),
      correctCount,
      wrongCount,
      missedCount,
      perfect,
      pointsEarned: points
    });
  }

  room.accusationResults = results;
}

// ---------- RÉVÉLATION FINALE ----------
function buildReveal(room) {
  const scenario = scenarioOf(room);
  const guiltyDetails = room.guiltyCharacterIds.map((id) => ({
    character: scenario.charById[id].name,
    explanation: scenario.solution.guiltyExplanations[id] || ''
  }));
  const presentNames = new Set(
    [...room.characterAssignments.values()].map((id) => scenario.charById[id]?.name).filter(Boolean)
  );
  return {
    victim: scenario.story.victim,
    guilty: guiltyDetails,
    falseLeadsSummary: filterFalseLeadsToPresentCharacters(scenario, scenario.solution.falseLeadsSummary, presentNames),
    scores: [...room.players.values()].map((p) => ({ playerId: p.id, playerName: p.name, score: p.score || 0 })).sort((a,b) => b.score-a.score),
    accusationResults: room.accusationResults || [],
    timeline: filterTimelineToPresentCharacters(scenario, scenario.timeline, presentNames),
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
        finalAccusations: new Map(),
        accusationResults: [],
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
        connected: true, isHost: true, alive: true, score: 0, scoreEvents: []
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
      if (!name || !name.trim()) throw new Error('Nom requis.');
      const normalizedName = name.trim().toLowerCase();

      // ---- Reprise de place par le nom ----
      // Si un joueur déconnecté portait déjà ce nom (session/appli perdue,
      // sans le token de reconnexion), on le fait rejoindre à sa place —
      // personnage, dossier, score et progression conservés — au lieu de
      // refuser le nom. Fonctionne en lobby comme en pleine partie.
      const existing = [...room.players.values()].find((p) => p.name.toLowerCase() === normalizedName);
      if (existing) {
        if (existing.connected && existing.socketId) {
          throw new Error('Ce nom est déjà utilisé et actif dans cette salle. Choisis-en un autre.');
        }
        const token = makeToken();
        existing.token = token;
        existing.socketId = socket.id;
        existing.connected = true;
        socket.join(room.code);
        socket.data.roomCode = room.code;
        socket.data.playerId = existing.id;

        cb({ ok: true, code: room.code, playerId: existing.id, token, room: roomSummary(room), rejoined: true });
        broadcastRoomState(room);
        pushChat(room, { system: true, text: `${existing.name} a repris sa place.`, ts: Date.now() });

        if (room.phase !== 'lobby' && room.phase !== 'distribution') {
          socket.emit('dossier:yours', buildDossier(room, existing.id));
          if (room.guiltyCharacterIds.includes(room.characterAssignments.get(existing.id))) {
            socket.join(`${room.code}:guilty`);
            socket.emit('chat:guilty:enabled', room.guiltyChatLog);
          }
        }
        return;
      }

      if (room.phase !== 'lobby') throw new Error('La partie a déjà commencé. Si tu faisais partie de cette salle, retape exactement ton nom pour reprendre ta place.');
      if (room.players.size >= RULES.maxPlayers) throw new Error('Salle complète (12 joueurs maximum).');
      if (room.gameMaster && room.gameMaster.name.toLowerCase() === normalizedName) {
        throw new Error('Ce nom est déjà utilisé dans cette salle. Choisis-en un autre.');
      }

      const playerId = makePlayerId();
      const token = makeToken();
      room.players.set(playerId, {
        id: playerId, token, name: name.trim(), socketId: socket.id,
        connected: true, isHost: false, alive: true, score: 0, scoreEvents: []
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
      const n = [...room.players.values()].filter((p) => p.connected && p.socketId).length;
      if (n < RULES.minPlayers || n > RULES.maxPlayers) {
        throw new Error(`Il faut entre ${RULES.minPlayers} et ${RULES.maxPlayers} joueurs.`);
      }
      const scenario = scenarioOf(room);

      setPhase(room, 'distribution', RULES.phaseDurations.distribution);
      const { guiltyCount } = distributeCharacters(room);

      const activeCharacterIds = [...room.characterAssignments.values()];
      const activeNames = new Set(
        activeCharacterIds.map((id) => scenario.charById[id]?.name).filter(Boolean)
      );

      io.to(room.code).emit('story:intro', {
        text: scenario.story.publicIntroTemplate.replace('{{playerCount}}', String(n)),
        victim: scenario.story.victim,
        locations: scenario.locations,
        questions: filterQuestionsToPresentCharacters(scenario, scenario.questions, activeNames),
        timeline: filterTimelineToPresentCharacters(scenario, scenario.timeline, activeNames),
        activeCharacters: activeCharacterIds.map((id) => publicCharacter(scenario, id)).filter(Boolean),
        playerCount: n,
        connectedPlayers: [...room.players.values()].filter((p) => p.connected && p.socketId).map((p) => ({ id: p.id, name: p.name })),
        guiltyCount
      });

      cb({ ok: true });
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
        p.score = 0;
        p.scoreEvents = [];
      }
      room.characterAssignments = new Map();
      room.guiltyCharacterIds = [];
      room.revealedClueCount = 0;
      room.activeClues = [];
      room.finalAccusations = new Map();
      room.accusationResults = [];
      room.paused = false;
      room.pauseRemainingMs = null;
      room.readyPlayers = new Set();
      room.formalAccusationsSent = new Set();
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

  socket.on('game:replay', (_payload, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.roomCode);
      if (!isController(room, socket)) throw new Error("Seul l'hôte ou le Game Master peut relancer la partie.");
      if (room.phase !== 'reveal') throw new Error('La partie doit être terminée pour être rejouée.');
      clearTimers(room);
      for (const p of room.players.values()) { p.alive = true; p.score = 0; p.scoreEvents = []; }
      room.characterAssignments = new Map();
      room.guiltyCharacterIds = []; room.activeClues = []; room.revealedClueCount = 0;
      room.finalAccusations = new Map(); room.accusationResults = []; room.formalAccusationsSent = new Set();
      room.chatLog = []; room.guiltyChatLog = [];
      room.phase = 'lobby'; room.phaseEndsAt = null; room.paused = false; room.pauseRemainingMs = null;
      io.to(room.code).emit('game:restarted');
      broadcastRoomState(room); cb({ ok: true });
    } catch (err) { cb({ ok: false, error: err.message }); }
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

  // Accusation finale (une seule manche) : chaque joueur choisit librement,
  // une fois pour toutes, qui il pense être coupable — pas d'élimination.
  socket.on('accusation:submit', ({ accusedPlayerIds }, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.roomCode);
      if (room.phase !== 'accusation') throw new Error('L\'accusation finale n\'est pas ouverte.');
      submitFinalAccusation(room, socket.data.playerId, accusedPlayerIds);
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  // Accusation formelle "de jeu de rôle" pendant l'enquête (indicative, bonus
  // de points, sans conséquence directe sur la partie ni sur l'accusation finale).
  socket.on('accusation:final', ({ suspectName, motif, opportunite, indice }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'enquete') return;
    const player = room.players.get(socket.data.playerId);
    if (!player) return;
    const suspect = [...room.players.values()].find((p) => p.name.toLowerCase() === String(suspectName || '').trim().toLowerCase());
    if (!suspect || suspect.id === player.id) return;
    if (![motif, opportunite, indice].every((v) => String(v || '').trim())) return;
    room.formalAccusationsSent = room.formalAccusationsSent || new Set();
    if (room.formalAccusationsSent.has(player.id)) return;
    room.formalAccusationsSent.add(player.id);
    const targetCharId = room.characterAssignments.get(suspect.id);
    const correct = room.guiltyCharacterIds.includes(targetCharId);
    const text = `J'accuse ${suspect.name}. Motif : ${String(motif).trim().slice(0,250)}. Opportunité : ${String(opportunite).trim().slice(0,250)}. Indice : ${String(indice).trim().slice(0,250)}.`;
    addScore(room, player.id, correct ? 20 : 3, correct ? 'Accusation formelle sur un coupable' : 'Accusation formelle');
    pushChat(room, { playerId: player.id, name: player.name, text, ts: Date.now(), accusation: true });
    io.to(player.socketId).emit('accusation:accepted', { correct, message: correct ? 'Ton accusation cible un coupable. Continue à construire la preuve.' : 'Ton accusation est enregistrée. Attention à ne pas t\'enfermer sur une mauvaise piste.' });
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
    if (room.readyPlayers) room.readyPlayers.delete(player.id);
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
