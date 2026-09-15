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

// Tous les scénarios vivent dans data/scenarios/<id>/.
// Le moteur accepte jusqu'à 20 affaires dans ce dossier. Au-delà, seules
// les 20 premières (ordre stable) sont chargées pour éviter une salle énorme.
const SCENARIO_IDS = fs.readdirSync(scenariosDir)
  .filter((name) => fs.statSync(path.join(scenariosDir, name)).isDirectory())
  .sort()
  .slice(0, 20);

const SCENARIOS = Object.fromEntries(
  SCENARIO_IDS.map((id) => [id, loadScenario(id)])
);
if (!Object.keys(SCENARIOS).length) throw new Error('Aucun scénario trouvé dans data/scenarios/.');

const DEFAULT_SCENARIO_ID = Object.keys(SCENARIOS).sort()[0];
const SCENARIO_LIST = Object.values(SCENARIOS).map((s) => {
  const { min, max } = playerRangeFor(s);
  return { id: s.id, title: s.title, difficulty: s.difficulty, minPlayers: min, maxPlayers: max };
});

function eligibleScenarioIds(playerCount) {
  return Object.values(SCENARIOS)
    .filter((scenario) => {
      const { min, max } = playerRangeFor(scenario);
      return playerCount >= min && playerCount <= max;
    })
    .map((scenario) => scenario.id);
}

function pickScenarioId({ playerCount = 0, used = [], exclude = null } = {}) {
  const compatible = eligibleScenarioIds(playerCount);
  const pool = compatible.length ? compatible : Object.keys(SCENARIOS);
  const unused = pool.filter((id) => !used.includes(id) && id !== exclude);
  const candidates = unused.length ? unused : pool.filter((id) => id !== exclude);
  const finalPool = candidates.length ? candidates : pool;
  return finalPool[Math.floor(Math.random() * finalPool.length)];
}

function normalizeLobbyScenario(room) {
  if (room.phase !== 'lobby') return;
  const connected = [...room.players.values()].filter(p => p.connected && p.socketId).length;
  if (connected < RULES.minPlayers) return;
  const compatible = eligibleScenarioIds(connected);
  if (!compatible.includes(room.scenarioId)) {
    room.scenarioId = pickScenarioId({
      playerCount: connected,
      used: room.scenarioHistory || [],
      exclude: room.scenarioId
    });
    room.lastScenarioId = room.scenarioId;
  }
}

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
  'lobby', 'distribution', 'dossier', 'enquete', 'reveal'
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
  const scenario = scenarioOf(room);
  return {
    code: room.code,
    phase: room.phase,
    phaseEndsAt: room.phaseEndsAt,
    phaseStartedAt: room.lastPhaseTransitionAt || null,
    players: publicPlayerList(room),
    minPlayers: RULES.minPlayers,
    maxPlayers: RULES.maxPlayers,
    scenarioId: room.scenarioId,
    scenarioTitle: scenario.title,
    scenarioDifficulty: scenario.difficulty,
    scenarioPoolSize: Object.keys(SCENARIOS).length,
    scenarioPlayedCount: (room.scenarioHistory || []).length,
    scenarioCanReroll: room.phase === 'lobby' && Object.keys(SCENARIOS).length > 1,
    connectedPlayerCount: [...room.players.values()].filter((p) => p.connected && p.socketId).length,
    activeCharacterCount: room.characterAssignments.size,
    guiltyCount: room.guiltyCharacterIds.length || null,
    revealedClueCount: room.revealedClueCount || 0,
    activeClueCount: (room.activeClues || []).length,
    bonusClueUsed: !!room.bonusClueUsed,
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

// Les métadonnées internes des indices (notamment linkedCharacterId) restent
// sur le serveur afin de conserver une vraie difficulté de déduction.
function publicClue(clue) {
  return {
    order: clue.order,
    title: clue.title,
    description: clue.description
  };
}

// ---------- RÈGLE : détermination du nombre de coupables (dépend du scénario) ----------
function guiltyRuleFor(scenario, playerCount) {
  const rule = scenario.guiltyRules.find(
    (r) => playerCount >= r.minPlayers && playerCount <= r.maxPlayers
  );
  if (!rule) throw new Error('Nombre de joueurs hors des règles autorisées.');
  return rule;
}

// Bornes de joueurs propres au scénario choisi (déduites de guiltyRules),
// avec repli sur les bornes globales si le scénario ne précise rien.
function playerRangeFor(scenario) {
  if (!scenario.guiltyRules || !scenario.guiltyRules.length) {
    return { min: RULES.minPlayers, max: RULES.maxPlayers };
  }
  const mins = scenario.guiltyRules.map((r) => Number(r.minPlayers)).filter(Number.isFinite);
  const maxs = scenario.guiltyRules.map((r) => Number(r.maxPlayers)).filter(Number.isFinite);
  if (!mins.length || !maxs.length) return { min: RULES.minPlayers, max: RULES.maxPlayers };
  return { min: Math.min(...mins), max: Math.max(...maxs) };
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
  return ({ distribution: 'Distribution des rôles', dossier: 'Dossier secret', enquete: 'Enquête', reveal: 'Révélation' }[phase] || phase);
}

function setPhase(room, phase, durationSeconds) {
  clearTimers(room);
  room.lastPhaseTransitionAt = Date.now();
  room.lastActivityAt = Date.now();
  room.phase = phase;
  room.phaseEndsAt = durationSeconds ? Date.now() + durationSeconds * 1000 : null;

  if (durationSeconds) {
    room.phaseTimer = setTimeout(() => advancePhase(room), durationSeconds * 1000);
  }

  if (phase === 'enquete') {
    // L'enquête est volontairement plus difficile : les indices qui pointent
    // directement vers un coupable arrivent plus tard. Les indices de contexte
    // et les fausses pistes arrivent d'abord. Le client ne reçoit jamais le
    // lien interne "linkedCharacterId".
    const distributedIds = new Set(room.characterAssignments.values());
    const presentNames = new Set(
      [...distributedIds].map((id) => scenarioOf(room).charById[id]?.name).filter(Boolean)
    );
    const guiltyIds = new Set(room.guiltyCharacterIds);
    const rawClues = scenarioOf(room).clues.filter((c) => {
      if (c.linkedCharacterId !== null && !distributedIds.has(c.linkedCharacterId)) return false;
      return !textMentionsAbsentCharacter(c.description || '', scenarioOf(room), presentNames);
    });
    room.activeClues = rawClues
      .map((clue, index) => ({
        clue,
        priority: clue.linkedCharacterId == null ? 0 : (guiltyIds.has(clue.linkedCharacterId) ? 2 : 1),
        index
      }))
      .sort((a, b) => a.priority - b.priority || a.index - b.index)
      .map(({ clue }) => clue);
    room.revealedClueCount = 0;
    room.bonusClueUsed = false;
    startClueTimer(room, durationSeconds);
  }

  if (phase === 'dossier') {
    room.readyPlayers = new Set();
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
    io.to(room.code).emit('clue:revealed', publicClue(clue));
  }, interval);
}

function advancePhase(room) {
  if (!room || room.phase === 'reveal') return false;
  const idx = PHASES.indexOf(room.phase);
  if (idx < 0) return false;
  const next = PHASES[idx + 1] || 'reveal';

  const durations = RULES.phaseDurations;
  setPhase(room, next, durations[next] || null);
  return true;
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

function activeParticipantIds(room) {
  return new Set(room.activePlayerIds ? [...room.activePlayerIds] : [...room.players.keys()]);
}

function connectedActiveParticipantCount(room) {
  return [...activeParticipantIds(room)].filter(id => { const p=room.players.get(id); return p?.connected && p?.socketId; }).length;
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
    timeline: filterTimelineToPresentCharacters(scenario, scenario.timeline, presentNames),
    closingLine: scenario.solution.closingLine,
    assignments: [...room.characterAssignments.entries()].map(([playerId, charId]) => ({
      playerId,
      playerName: room.players.get(playerId)?.name,
      characterName: scenario.charById[charId].name,
      wasGuilty: room.guiltyCharacterIds.includes(charId)
    })),
    scenarioTitle: scenario.title,
    scenarioDifficulty: scenario.difficulty,
    scenarioHistory: room.scenarioHistory || []
  };
}

// ---------- ÉPISODE PRÉCÉDENT / RÉCAPITULATIF PUBLIC ----------
function buildEpisodeRecap(room) {
  const scenario = scenarioOf(room);
  const presentNames = new Set(
    [...room.characterAssignments.values()]
      .map((id) => scenario.charById[id]?.name)
      .filter(Boolean)
  );
  const revealed = (room.activeClues || []).slice(0, room.revealedClueCount || 0)
    .map((c) => ({ title: c.title, description: c.description }));
  return {
    title: 'Épisode précédent',
    scenarioTitle: scenario.title,
    phase: phaseLabelServer(room.phase),
    story: scenario.story.publicIntroTemplate.replace(
      '{{playerCount}}',
      String(room.characterAssignments.size || room.players.size)
    ),
    victim: scenario.story.victim,
    revealedClues: revealed,
    clueCount: revealed.length,
    activeClueCount: (room.activeClues || []).length,
    message: room.phase === 'enquete'
      ? 'La soirée est déjà bien entamée. Voici ce qui a été découvert avant ton arrivée.'
      : 'Voici le contexte de la partie avant de reprendre.'
  };
}

function buildStoryIntro(room) {
  const scenario = scenarioOf(room);
  const activeCharacterIds = [...room.characterAssignments.values()];
  const activeNames = new Set(
    activeCharacterIds.map((id) => scenario.charById[id]?.name).filter(Boolean)
  );
  return {
    text: scenario.story.publicIntroTemplate.replace('{{playerCount}}', String(activeCharacterIds.length || room.players.size)),
    victim: scenario.story.victim,
    locations: scenario.locations,
    questions: filterQuestionsToPresentCharacters(scenario, scenario.questions, activeNames),
    timeline: filterTimelineToPresentCharacters(scenario, scenario.timeline, activeNames),
    activeCharacters: activeCharacterIds.map((id) => publicCharacter(scenario, id)).filter(Boolean),
    playerCount: activeCharacterIds.length || room.players.size,
    connectedPlayers: [...room.players.values()].filter((p) => p.connected && p.socketId).map((p) => ({ id: p.id, name: p.name })),
    guiltyCount: room.guiltyCharacterIds.length,
    scenarioId: scenario.id,
    scenarioTitle: scenario.title,
    scenarioDifficulty: scenario.difficulty,
    activeClueCount: (room.activeClues || []).length
  };
}

function sendGameSync(socket, room, playerId) {
  socket.emit('game:sync', {
    room: roomSummary(room),
    story: room.characterAssignments.size ? buildStoryIntro(room) : null,
    revealedClues: (room.activeClues || []).slice(0, room.revealedClueCount || 0).map(publicClue),
    chatLog: (room.chatLog || []).slice(-150),
    dossier: room.characterAssignments.has(playerId) ? buildDossier(room, playerId) : null
  });
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
        scenarioId: pickScenarioId({ playerCount: 0 }),
        lastScenarioId: null,
        scenarioHistory: [],
        phase: 'lobby',
        phaseEndsAt: null,
        players: new Map(),
        characterAssignments: new Map(),
        guiltyCharacterIds: [],
        revealedClueCount: 0,
        activeClues: [],
        clueTimer: null,
        phaseTimer: null,
        chatLog: [],
        guiltyChatLog: [],
        gameMaster: null,
        paused: false,
        pauseRemainingMs: null,
        bonusClueUsed: false,
        interrogationCounts: new Map(),
        lastPhaseTransitionAt: 0,
        lastActivityAt: Date.now(),
        chatRate: new Map()
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
          socket.emit('story:recap', buildEpisodeRecap(room));
          sendGameSync(socket, room, existing.id);
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
      normalizeLobbyScenario(room);

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
        if (room.phase !== 'lobby' && room.phase !== 'distribution') socket.emit('story:recap', buildEpisodeRecap(room));
        return;
      }

      const player = room.players.get(playerId);
      if (!player || player.token !== token) throw new Error('Reconnexion invalide.');

      if (player.socketId && player.socketId !== socket.id) {
        const oldSocket = io.sockets.sockets.get(player.socketId);
        if (oldSocket) { oldSocket.data.roomCode = null; oldSocket.data.playerId = null; oldSocket.disconnect(true); }
      }
      player.socketId = socket.id;
      player.connected = true;
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.playerId = playerId;

      cb({ ok: true, room: roomSummary(room), phase: room.phase, isGameMaster: false });
      if (room.phase !== 'lobby' && room.phase !== 'distribution') {
        socket.emit('story:recap', buildEpisodeRecap(room));
        sendGameSync(socket, room, playerId);
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
      const compatible = eligibleScenarioIds(n);
      if (!compatible.length) throw new Error('Aucun scénario ne peut accueillir ce nombre de joueurs.');
      const alreadyPlayed = room.scenarioHistory || [];
      let scenarioId = room.scenarioId;
      if (!compatible.includes(scenarioId) || alreadyPlayed.includes(scenarioId)) {
        scenarioId = pickScenarioId({ playerCount: n, used: alreadyPlayed, exclude: room.scenarioId });
        room.scenarioId = scenarioId;
      }
      const scenario = scenarioOf(room);
      const { min, max } = playerRangeFor(scenario);
      if (n < min || n > max) {
        throw new Error(`Il faut entre ${min} et ${max} joueurs pour cette affaire.`);
      }

      room.scenarioHistory = [...new Set([...(room.scenarioHistory || []), scenario.id])];
      room.lastScenarioId = scenario.id;

      setPhase(room, 'distribution', RULES.phaseDurations.distribution);
      const { guiltyCount } = distributeCharacters(room);

      io.to(room.code).emit('story:intro', {
        ...buildStoryIntro(room),
        playerCount: n,
        guiltyCount
      });

      cb({ ok: true, scenarioId: scenario.id });
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  // Le contrôleur ne parcourt plus une longue liste : il peut simplement
  // demander une nouvelle affaire aléatoire. Les affaires déjà jouées sont
  // évitées jusqu'à épuisement du catalogue.
  socket.on('room:reroll_scenario', (_payload, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.roomCode);
      if (!isController(room, socket)) throw new Error('Seul l’hôte ou le Game Master peut changer d’affaire.');
      if (room.phase !== 'lobby') throw new Error('Impossible de changer d’affaire après le lancement.');
      const connected = [...room.players.values()].filter(p => p.connected && p.socketId).length;
      const next = pickScenarioId({
        playerCount: connected,
        used: room.scenarioHistory || [],
        exclude: room.scenarioId
      });
      room.scenarioId = next;
      room.lastScenarioId = next;
      broadcastRoomState(room);
      cb({ ok: true, scenario: SCENARIO_LIST.find(s => s.id === next) || { id: next } });
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
      io.to(room.code).emit('clue:revealed', publicClue(clue));
      cb({ ok: true });
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });


  // ---------- INDICE BONUS : révélation immédiate contre du temps ----------
  socket.on('gm:bonus_clue', (_payload, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.roomCode);
      if (!isController(room, socket)) throw new Error('Réservé à l’hôte ou au Game Master.');
      if (room.phase !== 'enquete') throw new Error('L’indice bonus est disponible uniquement pendant l’enquête.');
      if (room.bonusClueUsed) throw new Error('L’indice bonus a déjà été utilisé.');
      const clues = room.activeClues || [];
      if (room.revealedClueCount >= clues.length) throw new Error('Tous les indices sont déjà révélés.');
      const costSeconds = Math.max(30, Number(RULES.bonusClueCostSeconds || 60));
      const remaining = room.phaseEndsAt ? Math.max(0, room.phaseEndsAt - Date.now()) : 0;
      if (remaining <= costSeconds * 1000) throw new Error('Il ne reste pas assez de temps pour payer cet indice bonus.');
      room.bonusClueUsed = true;
      room.phaseEndsAt -= costSeconds * 1000;
      if (room.phaseTimer) clearTimeout(room.phaseTimer);
      room.phaseTimer = setTimeout(() => advancePhase(room), Math.max(1, room.phaseEndsAt - Date.now()));
      if (room.clueTimer) { clearInterval(room.clueTimer); room.clueTimer = null; }
      const clue = clues[room.revealedClueCount++];
      io.to(room.code).emit('clue:revealed', publicClue(clue));
      io.to(room.code).emit('bonus:used', { costSeconds, phaseEndsAt: room.phaseEndsAt, clue });
      startClueTimer(room, Math.max(1, Math.round((room.phaseEndsAt - Date.now()) / 1000)));
      broadcastRoomState(room);
      cb({ ok: true });
    } catch (err) { cb({ ok: false, error: err.message }); }
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
      room.paused = false;
      room.pauseRemainingMs = null;
      room.readyPlayers = new Set();
      room.interrogationCounts = new Map();
      room.chatRate = new Map();
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

  socket.on('game:replay', (_payload = {}, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.roomCode);
      if (!isController(room, socket)) throw new Error("Seul l'hôte ou le Game Master peut relancer la partie.");
      if (room.phase !== 'reveal') throw new Error('La partie doit être terminée pour être rejouée.');
      clearTimers(room);

      const connected = [...room.players.values()].filter(p => p.connected && p.socketId).length;
      room.scenarioId = pickScenarioId({
        playerCount: connected,
        used: room.scenarioHistory || [],
        exclude: room.scenarioId
      });
      room.lastScenarioId = room.scenarioId;
      // Si tout le catalogue a été joué, on démarre un nouveau cycle.
      if ((room.scenarioHistory || []).length >= Object.keys(SCENARIOS).length) {
        room.scenarioHistory = [room.scenarioId];
      }

      for (const p of room.players.values()) { p.alive = true; p.score = 0; p.scoreEvents = []; }
      room.characterAssignments = new Map();
      room.guiltyCharacterIds = []; room.activeClues = []; room.revealedClueCount = 0;
      room.interrogationCounts = new Map(); room.chatRate = new Map();
      room.bonusClueUsed = false;
      room.chatLog = []; room.guiltyChatLog = [];
      room.phase = 'lobby'; room.phaseEndsAt = null; room.paused = false; room.pauseRemainingMs = null;
      io.to(room.code).emit('game:restarted', { newCase: true, scenarioId: room.scenarioId });
      broadcastRoomState(room); cb({ ok: true, scenarioId: room.scenarioId, newCase: true });
    } catch (err) { cb({ ok: false, error: err.message }); }
  });

  // ---------- CHAT PRIVÉ DES COUPABLES ----------
  socket.on('chat:guilty:send', ({ text }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players.get(socket.data.playerId);
    if (!player || player.socketId !== socket.id || !text || !text.trim()) return;
    const charId = room.characterAssignments.get(player.id);
    if (!room.guiltyCharacterIds.includes(charId)) return; // seuls les coupables peuvent écrire ici
    const entry = { playerId: player.id, name: player.name, text: text.trim().slice(0, 500), ts: Date.now() };
    room.guiltyChatLog.push(entry);
    io.to(`${room.code}:guilty`).emit('chat:guilty:message', entry);
  });

  socket.on('chat:send', ({ text, replyTo = null }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = room.players.get(socket.data.playerId);
    if (!player || !player.connected || player.socketId !== socket.id || !text || !text.trim()) return;
    room.chatRate = room.chatRate || new Map();
    const now = Date.now(); const r = room.chatRate.get(player.id) || {start: now, count: 0};
    if (now - r.start > 2000) { r.start = now; r.count = 0; }
    if (r.count >= 4) return socket.emit('chat:rate_limited', {message:'Ralentis un peu : maximum 4 messages toutes les 2 secondes.'});
    r.count++; room.chatRate.set(player.id, r);

    let safeReply = null;
    if (replyTo && replyTo.ts) {
      const original = (room.chatLog || []).find(m => m.ts === Number(replyTo.ts));
      if (original && !original.system) {
        safeReply = {
          playerId: original.playerId,
          name: original.name,
          text: String(original.text).slice(0, 180),
          ts: original.ts
        };
      }
    }
    pushChat(room, {
      playerId: player.id,
      name: player.name,
      text: text.trim().slice(0, 500),
      replyTo: safeReply,
      ts: Date.now()
    });
  });

  // ---------- DOSSIER : confirmation de lecture ----------
  socket.on('dossier:ready', (_payload, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.roomCode);
      if (room.phase !== 'dossier') throw new Error('La phase des dossiers est terminée.');
      const player = room.players.get(socket.data.playerId);
      if (!player || !room.activePlayerIds?.has(player.id)) throw new Error('Joueur non participant.');
      room.readyPlayers = room.readyPlayers || new Set();
      room.readyPlayers.add(player.id);
      room.lastActivityAt = Date.now();
      const active = [...room.activePlayerIds].filter(id => { const p=room.players.get(id); return p?.connected && p?.socketId; });
      io.to(room.code).emit('dossier:ready:progress', { ready: [...room.readyPlayers].filter(id => room.activePlayerIds.has(id)).length, total: active.length });
      broadcastRoomState(room);
      cb({ ok: true, ready: room.readyPlayers.size, total: active.length });
    } catch (err) { cb({ ok: false, error: err.message }); }
  });

  // ---------- INTERROGATOIRE DYNAMIQUE ----------
  socket.on('investigation:interrogate', ({ targetPlayerId, questionIndex }, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.roomCode);
      if (room.phase !== 'enquete') throw new Error('Les interrogatoires sont disponibles pendant l’enquête.');
      const asker = room.players.get(socket.data.playerId);
      const target = room.players.get(targetPlayerId);
      if (!asker || !target || !room.activePlayerIds?.has(asker.id) || !room.activePlayerIds?.has(target.id) || !room.characterAssignments.has(target.id)) throw new Error('Suspect introuvable.');
      if (target.id === asker.id) throw new Error('Tu ne peux pas t’interroger toi-même.');
      if (!asker.connected || !asker.socketId) throw new Error('Ta connexion n’est plus active.');
      room.interrogationCounts = room.interrogationCounts || new Map();
      const now = Date.now();
      const stat = room.interrogationCounts.get(asker.id) || { count: 0, lastAt: 0 };
      if (now - stat.lastAt < 8000) throw new Error('Attends quelques secondes avant un nouvel interrogatoire.');
      if (stat.count >= 10) throw new Error('Tu as atteint la limite de 10 interrogatoires pour cette enquête.');
      stat.count += 1; stat.lastAt = now; room.interrogationCounts.set(asker.id, stat);
      const scenario = scenarioOf(room);
      const char = scenario.charById[room.characterAssignments.get(target.id)];
      if (!char) throw new Error('Dossier du suspect indisponible.');
      const questions = Array.isArray(scenario.questions) ? scenario.questions : [];
      const q = questions[Math.max(0, Math.min(Number(questionIndex) || 0, questions.length - 1))] || 'Où étais-tu au moment des faits ?';
      const lower = q.toLowerCase();
      let answer = '';
      if (lower.includes('où') || lower.includes('alibi') || lower.includes('confirm')) answer = `${target.name} répond : « ${char.private.alibi} »`;
      else if (lower.includes('relation')) answer = `${target.name} répond : « ${char.public.relation}. »`;
      else if (lower.includes('raison') || lower.includes('en vouloir') || lower.includes('motif')) {
        answer = `${target.name} répond : « Je n'avais aucune raison de lui vouloir du mal. »`;
        if (room.guiltyCharacterIds.includes(char.id) && Math.random() < 0.45) answer = `${target.name} évite la question : « Ce n'est pas le moment de parler de ça. »`;
      } else if (lower.includes('bureau') || lower.includes('lieu') || lower.includes('accès')) answer = `${target.name} répond : « ${char.private.opportunite} »`;
      else if (lower.includes('secret') || lower.includes('cach')) answer = `${target.name} hésite : « Tout le monde a ses secrets. »`;
      else answer = `${target.name} hésite, puis répond : « Je préfère ne pas en parler pour l'instant. »`;
      if (Math.random() < 0.18) answer += ' ⚠️ Une hésitation inhabituelle est signalée.';
      addScore(room, asker.id, 2, 'Interrogatoire');
      cb({ ok: true, target: target.name, question: q, answer });
    } catch (e) { cb({ ok: false, error: e.message }); }
  });

  // Présence fiable : le client signale explicitement quand l'onglet passe
  // en arrière-plan (changement d'appli, verrouillage d'écran, etc.) plutôt
  // que d'attendre une vraie coupure réseau.
  socket.on('presence:away', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.isGameMaster) return;
    const player = room.players.get(socket.data.playerId);
    if (!player || (player.socketId && player.socketId !== socket.id)) return;
    player.connected = false;
    if (room.readyPlayers) room.readyPlayers.delete(player.id);
    broadcastRoomState(room);
  });

  socket.on('presence:back', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.isGameMaster) return;
    const player = room.players.get(socket.data.playerId);
    if (!player || (player.socketId && player.socketId !== socket.id)) return;
    player.connected = true;
    player.socketId = socket.id;
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
    // Un ancien socket ne doit jamais pouvoir déconnecter une session plus récente.
    if (player.socketId && player.socketId !== socket.id) return;
    player.connected = false;
    player.socketId = null;
    broadcastRoomState(room);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Serveur "Le Dernier Dîner" démarré sur http://${HOST}:${PORT}`);
  console.log('Pour un accès à distance : déployer ce serveur (Render/Railway/Fly.io/VPS) ou exposer le port via un tunnel (ex. ngrok) pendant les tests.');
});
