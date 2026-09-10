/* Client — se connecte au serveur autoritaire via Socket.IO.
   Le serveur peut être sur un autre domaine (accès à distance) :
   Socket.IO se connecte par défaut à l'origine qui sert cette page. */

const socket = io();

// ---------- État local (jamais de source de vérité côté client) ----------
let state = {
  code: null,
  playerId: null,
  token: null,
  isHost: false,
  isGameMaster: false,
  players: [],
  phase: 'lobby',
  alivePlayers: [],
  clues: [],
  suspects: [],
  bonusClueUsed: false,
  confidenceSubmitted: false,
  tensionStartedAt: null
};

// ---------- Helpers UI ----------
function show(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  t.style.animation = 'none';
  void t.offsetWidth; // relance l'animation d'entrée même si un toast précédent est encore visible
  t.style.animation = '';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.style.display = 'none'), 3500);
}

// ---------- Ambiance sonore (générée, aucun fichier audio requis) ----------
const SFX = (() => {
  let ctx = null;
  let muted = localStorage.getItem('mystery_muted') === '1';
  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(freq, { duration = 0.18, type = 'sine', gain = 0.06, delay = 0, glideTo = null } = {}) {
    if (muted) return;
    const c = ensureCtx();
    if (!c) return;
    const osc = c.createOscillator();
    const amp = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, c.currentTime + delay);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, c.currentTime + delay + duration);
    amp.gain.setValueAtTime(0, c.currentTime + delay);
    amp.gain.linearRampToValueAtTime(gain, c.currentTime + delay + 0.015);
    amp.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + delay + duration);
    osc.connect(amp).connect(c.destination);
    osc.start(c.currentTime + delay);
    osc.stop(c.currentTime + delay + duration + 0.05);
  }
  return {
    isMuted: () => muted,
    setMuted(v) { muted = v; localStorage.setItem('mystery_muted', v ? '1' : '0'); },
    clue() { tone(660, { type: 'triangle', duration: .22, gain: .05 }); tone(990, { type: 'triangle', duration: .25, gain: .045, delay: .07 }); },
    phase() { tone(220, { type: 'sine', duration: .3, gain: .05 }); tone(440, { type: 'sine', duration: .35, gain: .04, delay: .1 }); },
    tick() { tone(880, { type: 'square', duration: .06, gain: .035 }); },
    send() { tone(520, { type: 'sine', duration: .08, gain: .03 }); },
    victory() { [523, 659, 784, 1046].forEach((f, i) => tone(f, { type: 'triangle', duration: .35, gain: .05, delay: i * .12 })); },
    defeat() { tone(300, { type: 'sawtooth', duration: .6, gain: .05, glideTo: 120 }); }
  };
})();

// ---------- Bandeau d'annonce plein écran (indice, phase, alerte) ----------
function announceBanner({ icon = '🔎', kicker = '', title = '', type = 'clue', duration = 3200 } = {}) {
  const el = document.getElementById('clue-announce');
  if (!el) return;
  clearTimeout(announceBanner._hide);
  el.className = `clue-announce show type-${type}`;
  el.setAttribute('aria-hidden', 'false');
  document.getElementById('clue-announce-kicker').textContent = kicker;
  document.getElementById('clue-announce-title').textContent = title;
  el.querySelector('.clue-announce-icon').textContent = icon;
  announceBanner._hide = setTimeout(() => {
    el.classList.remove('show');
    el.setAttribute('aria-hidden', 'true');
  }, duration);
}

function initSoundToggle() {
  const btn = document.getElementById('btn-sound-toggle');
  if (!btn) return;
  const paint = () => {
    const muted = SFX.isMuted();
    btn.textContent = muted ? '🔇' : '🔈';
    btn.classList.toggle('muted', muted);
  };
  paint();
  btn.onclick = () => { SFX.setMuted(!SFX.isMuted()); paint(); if (!SFX.isMuted()) SFX.send(); };
}

// ---------- Particules d'ambiance sur l'écran d'accueil ----------
function initAmbientParticles() {
  const wrap = document.getElementById('ambient-particles');
  if (!wrap || wrap.childElementCount) return;
  const count = window.matchMedia('(max-width: 650px)').matches ? 10 : 18;
  for (let i = 0; i < count; i++) {
    const mote = document.createElement('span');
    mote.className = 'mote' + (i % 3 === 0 ? ' cyan' : '');
    mote.style.setProperty('--x', `${Math.random() * 100}%`);
    mote.style.setProperty('--size', `${2 + Math.random() * 3}px`);
    mote.style.setProperty('--dur', `${11 + Math.random() * 10}s`);
    mote.style.setProperty('--delay', `${-Math.random() * 20}s`);
    wrap.appendChild(mote);
  }
}

// ---------- Confettis de victoire (canvas, sans librairie) ----------
function launchConfetti() {
  const canvas = document.getElementById('confetti-canvas');
  if (!canvas) return;
  const ctx2d = canvas.getContext('2d');
  canvas.width = window.innerWidth; canvas.height = window.innerHeight;
  canvas.style.display = 'block';
  const colors = ['#d6a63f', '#f6cd6b', '#29c2d6', '#7be9f4', '#8c1f1f', '#34c99a'];
  const pieces = Array.from({ length: 140 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.4,
    w: 5 + Math.random() * 5,
    h: 8 + Math.random() * 8,
    vy: 2 + Math.random() * 3,
    vx: -1.5 + Math.random() * 3,
    rot: Math.random() * Math.PI,
    vrot: -0.2 + Math.random() * 0.4,
    color: colors[Math.floor(Math.random() * colors.length)]
  }));
  const start = Date.now();
  function frame() {
    ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    let anyVisible = false;
    for (const p of pieces) {
      p.x += p.vx; p.y += p.vy; p.rot += p.vrot;
      if (p.y < canvas.height + 20) anyVisible = true;
      ctx2d.save();
      ctx2d.translate(p.x, p.y);
      ctx2d.rotate(p.rot);
      ctx2d.fillStyle = p.color;
      ctx2d.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx2d.restore();
    }
    if (anyVisible && Date.now() - start < 4200) {
      requestAnimationFrame(frame);
    } else {
      canvas.style.display = 'none';
    }
  }
  requestAnimationFrame(frame);
}
window.addEventListener('resize', () => {
  const canvas = document.getElementById('confetti-canvas');
  if (canvas && canvas.style.display === 'block') { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
});

// ---------- Thème dynamique par phase ----------
function setPhaseTheme(phase) {
  document.body.classList.remove('phase-dossier', 'phase-distribution', 'phase-enquete', 'phase-accusation', 'phase-reveal');
  const cls = { dossier: 'phase-dossier', distribution: 'phase-distribution', enquete: 'phase-enquete', accusation: 'phase-accusation', reveal: 'phase-reveal' }[phase];
  if (cls) document.body.classList.add(cls);
}

// ---------- Urgence visuelle + sonore du minuteur ----------
function applyTimerUrgency(el, remaining) {
  if (!el) return;
  const critical = remaining > 0 && remaining <= 10;
  el.classList.toggle('timer-critical', critical);
  if (critical && remaining <= 5 && Number.isInteger(remaining) && applyTimerUrgency._last !== remaining) {
    applyTimerUrgency._last = remaining;
    SFX.tick();
  }
  if (!critical) applyTimerUrgency._last = null;
}

document.addEventListener('DOMContentLoaded', () => {
  initSoundToggle();
  initAmbientParticles();
});

function saveSession() {
  // localStorage (et non sessionStorage) : la session doit survivre même si
  // le joueur ferme complètement l'application/l'onglet, pas seulement s'il
  // change d'appli un instant.
  localStorage.setItem('mystery_session', JSON.stringify({
    code: state.code, playerId: state.playerId, token: state.token
  }));
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem('mystery_session') || 'null');
  } catch { return null; }
}

function clearSession() {
  localStorage.removeItem('mystery_session');
}

// ---------- ACCUEIL : créer / rejoindre ----------
document.getElementById('btn-create').onclick = () => {
  const name = document.getElementById('create-name').value.trim();
  const asGameMaster = document.getElementById('create-gm').checked;
  if (!name) return toast('Entre ton nom.');
  socket.emit('room:create', { name, asGameMaster }, (res) => {
    if (!res.ok) return (document.getElementById('home-error').textContent = res.error);
    applyJoinResult(res);
  });
};

document.getElementById('btn-join').onclick = () => {
  const name = document.getElementById('join-name').value.trim();
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!name || !code) return toast('Nom et code requis.');
  socket.emit('room:join', { name, code }, (res) => {
    if (!res.ok) return (document.getElementById('home-error').textContent = res.error);
    applyJoinResult(res);
  });
};

function applyJoinResult(res) {
  state.code = res.code;
  state.playerId = res.playerId;
  state.token = res.token;
  state.isGameMaster = !!res.isGameMaster;
  saveSession();
  renderRoomState(res.room);
  if (res.rejoined && res.room.phase !== 'lobby') {
    // Reprise de place en pleine partie : direction l'écran de la phase en
    // cours, pas le lobby.
    routeToPhaseScreen(res.room.phase);
    toast('Tu as repris ta place dans la partie.');
  } else {
    show('screen-lobby');
  }
}

// ---------- Reconnexion automatique (perte de connexion) ----------
let reconnectInFlight = false;
function tryReconnectSession() {
  if (reconnectInFlight) return;
  const saved = loadSession();
  if (!saved?.code || !saved?.playerId || !saved?.token) return;
  reconnectInFlight = true;
  socket.emit('room:reconnect', saved, (res) => {
    reconnectInFlight = false;
    if (!res.ok) { clearSession(); return; }
    state.code = saved.code;
    state.playerId = saved.playerId;
    state.token = saved.token;
    state.isGameMaster = !!res.isGameMaster;
    renderRoomState(res.room);
    routeToPhaseScreen(res.phase);
    toast('Reconnecté à la partie.');
  });
}

socket.on('connect', () => {
  // Après une vraie coupure réseau, Socket.IO crée un nouveau socket :
  // on réassocie immédiatement la session au joueur côté serveur.
  if (!state.code) {
    const saved = loadSession();
    if (saved) { state.code=saved.code; state.playerId=saved.playerId; state.token=saved.token; }
  }
  if (state.code && state.playerId && state.token) tryReconnectSession();
});

window.addEventListener('load', () => {
  if (!state.code) {
    const saved = loadSession();
    if (saved) { state.code=saved.code; state.playerId=saved.playerId; state.token=saved.token; }
  }
  if (socket.connected) tryReconnectSession();
});

// ---------- ÉTAT DE SALLE (poussé par le serveur) ----------
socket.on('room:state', (room) => renderRoomState(room));

function renderRoomState(room) {
  state.players = room.players;
  state.phase = room.phase;
  state.isHost = room.players.find((p) => p.id === state.playerId)?.isHost || false;
  state.alivePlayers = room.players.filter((p) => p.alive);
  state.bonusClueUsed = !!room.bonusClueUsed;
  const readiness = document.getElementById('lobby-readiness');
  if (readiness) readiness.innerHTML = room.phase === 'dossier' ? `<strong>📋 Dossiers lus :</strong> ${room.connectedReadyCount || 0} / ${room.connectedPlayerCount || 0}` : ''; 

  // Lobby
  document.getElementById('lobby-code').textContent = room.code;
  document.getElementById('lobby-count').textContent =
    `${room.players.filter(p => p.connected).length} / ${room.maxPlayers} joueurs connectés (minimum ${room.minPlayers})`;
  const adaptive = document.getElementById('adaptive-info');
  if (room.phase === 'lobby') adaptive.textContent = `🎭 La partie utilisera exactement ${room.players.filter(p => p.connected).length} personnage(s) connecté(s). À 6–8 joueurs : 1 coupable. À 9–12 : 2 coupables.`;
  else adaptive.textContent = `🎭 Partie adaptative : ${room.activeCharacterCount} personnage(s), ${room.guiltyCount || '—'} coupable(s).`;

  const list = document.getElementById('lobby-players');
  list.innerHTML = '';
  const isController = state.isHost || state.isGameMaster;
  renderScenarioPicker(room, isController);
  room.players.forEach((p) => {
    const li = document.createElement('li');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = p.name;
    if (p.isHost) nameSpan.innerHTML += ' <span class="tag-host">HÔTE</span>';
    if (!p.connected) nameSpan.innerHTML += ' <span class="tag-offline">(déconnecté)</span>';
    li.appendChild(nameSpan);

    if (isController && !p.isHost && room.phase === 'lobby') {
      const kickBtn = document.createElement('button');
      kickBtn.textContent = 'Exclure';
      kickBtn.className = 'kick-btn';
      kickBtn.onclick = () => {
        if (!confirm(`Exclure ${p.name} de la salle ?`)) return;
        socket.emit('room:kick', { targetPlayerId: p.id }, (res) => {
          if (!res.ok) toast(res.error);
        });
      };
      li.appendChild(kickBtn);
    }
    list.appendChild(li);
  });

  const btnStart = document.getElementById('btn-start');
  if (isController && room.phase === 'lobby') {
    btnStart.style.display = 'block';
    btnStart.disabled = room.players.filter(p => p.connected).length < room.minPlayers;
    document.getElementById('lobby-hint').textContent =
      room.players.filter(p => p.connected).length < room.minPlayers
        ? `Il faut au moins ${room.minPlayers} joueurs pour lancer la partie.`
        : 'Prêt à lancer la partie.';
  } else {
    btnStart.style.display = 'none';
  }

  // Liste des suspects (écran enquête)
  renderSuspectsAndVoteList(room.players);
}

document.getElementById('btn-start').onclick = () => {
  socket.emit('room:start', {}, (res) => {
    if (!res.ok) toast(res.error);
  });
};

// ---------- CHOIX DU SCÉNARIO (lobby uniquement) ----------
function renderScenarioPicker(room, isController) {
  const picker = document.getElementById('scenario-picker');
  const readonly = document.getElementById('scenario-readonly');
  const options = room.availableScenarios || [];

  if (room.phase !== 'lobby' || !isController || options.length <= 1) {
    picker.style.display = 'none';
    readonly.style.display = room.phase === 'lobby' ? 'block' : 'none';
    readonly.textContent = room.scenarioTitle
      ? `Scénario : ${room.scenarioTitle} (${room.scenarioDifficulty}) — ${room.minPlayers} à ${room.maxPlayers} joueurs`
      : '';
    return;
  }

  readonly.style.display = 'none';
  picker.style.display = 'block';
  const container = document.getElementById('scenario-options');
  container.innerHTML = '';
  options.forEach((s) => {
    const div = document.createElement('div');
    div.className = 'scenario-option' + (s.id === room.scenarioId ? ' selected' : '');
    div.innerHTML = `<div class="scenario-title">${s.title}</div><div class="scenario-diff">Difficulté : ${s.difficulty} · ${s.minPlayers} à ${s.maxPlayers} joueurs</div>`;
    div.onclick = () => {
      socket.emit('room:set_scenario', { scenarioId: s.id }, (res) => {
        if (!res.ok) toast(res.error);
      });
    };
    container.appendChild(div);
  });
}

// ---------- EXCLUSION DE LA SALLE ----------
socket.on('room:kicked', () => {
  clearSession();
  toast('Tu as été exclu(e) de la salle par l\'hôte.');
  setTimeout(() => window.location.reload(), 1500);
});

// ---------- INTRO PUBLIQUE ----------
let storyData = null;
socket.on('story:intro', (data) => {
  storyData = data;
  document.getElementById('story-text').textContent = data.text;

  const timelineEl = document.getElementById('timeline-list');
  timelineEl.innerHTML = '';
  // La chronologie sera peuplée à l'entrée en phase investigation via /data côté client fixe
  const locEl = document.getElementById('locations-list');
  locEl.innerHTML = '';
  data.locations.forEach((l) => {
    const li = document.createElement('li');
    li.textContent = `${l.name} — ${l.description}`;
    locEl.appendChild(li);
  });

  const qEl = document.getElementById('questions-list');
  qEl.innerHTML = '';
  data.questions.forEach((q) => {
    const li = document.createElement('li');
    li.textContent = q;
    qEl.appendChild(li);
  });
  showEpisodeRecap({
    title: 'Épisode précédent',
    scenarioTitle: data.scenarioTitle || 'Nouvelle affaire',
    phase: 'Ouverture du dossier',
    story: data.text,
    message: 'Le dossier vient de s’ouvrir. Voici le contexte à connaître avant de mener l’enquête.',
    victim: data.victim,
    clueCount: 0,
    activeClueCount: data.activeCharacters?.length ? '—' : 0,
    revealedClues: []
  });
});


// ---------- ÉPISODE PRÉCÉDENT / RETARDATAIRES ----------
function showEpisodeRecap(data) {
  const modal = document.getElementById('episode-modal');
  if (!modal) return;
  document.getElementById('episode-title').textContent = data.title || 'Épisode précédent';
  document.getElementById('episode-message').textContent = data.message || '';
  document.getElementById('episode-case').textContent = data.scenarioTitle || '—';
  document.getElementById('episode-phase').textContent = data.phase || '—';
  document.getElementById('episode-victim').textContent = data.victim?.name || '—';
  document.getElementById('episode-clues').textContent = `${data.clueCount || 0} / ${data.activeClueCount || 0}`;
  const list = document.getElementById('episode-clues-list');
  list.innerHTML = '';
  if ((data.revealedClues || []).length) {
    data.revealedClues.forEach((c, i) => {
      const el = document.createElement('div');
      el.className = 'episode-clue';
      el.innerHTML = `<strong>Indice ${i+1} · ${c.title}</strong><small>${c.description}</small>`;
      list.appendChild(el);
    });
  } else {
    list.innerHTML = '<div class="episode-clue"><strong>Aucun indice public encore révélé.</strong><small>Tu n’as rien manqué : l’enquête commence à peine.</small></div>';
  }
  modal.style.display = 'grid';
}
socket.on('story:recap', showEpisodeRecap);
function closeEpisodeRecap() { const m=document.getElementById('episode-modal'); if(m) m.style.display='none'; }
document.getElementById('episode-close').onclick = closeEpisodeRecap;
document.getElementById('episode-close-main').onclick = closeEpisodeRecap;
document.getElementById('episode-modal').addEventListener('click', (e) => {
  if (e.target.id === 'episode-modal') closeEpisodeRecap();
});

// ---------- DOSSIER PRIVÉ ----------
let myDossierHTML = '';
function renderDossierHTML(dossier) {
  const statusClass = dossier.statut === 'COUPABLE' ? 'status-guilty' : 'status-innocent';
  return `
    <div class="player-row-with-avatar dossier-avatar"><div>${avatarSVG(dossier.identite.nom)}</div><div><h3>DOSSIER CONFIDENTIEL</h3><span class="hint">Avatar de personnage</span></div></div>
    <div class="dossier-field"><div class="label">Identité</div>${dossier.identite.nom}, ${dossier.identite.age} ans — ${dossier.identite.role}</div>
    <div class="dossier-field"><div class="label">Relation avec Antoine</div>${dossier.relation}</div>
    <div class="dossier-field"><div class="label">Motif</div>${dossier.motif}</div>
    <div class="dossier-field"><div class="label">Secret</div>${dossier.secret}</div>
    <div class="dossier-field"><div class="label">Alibi</div>${dossier.alibi}</div>
    <div class="dossier-field"><div class="label">Opportunité</div>${dossier.opportunite}</div>
    <div class="dossier-field"><div class="label">Informations connues</div><ul>${dossier.informations.map((i) => `<li>${i}</li>`).join('')}</ul></div>
    <div class="dossier-field"><div class="label">Objectif personnel</div>${dossier.objectif}</div>
    <div class="dossier-field"><div class="label">Statut (strictement privé)</div><span class="${statusClass}">${dossier.statut}</span></div>
    ${dossier.partenaires.length ? `<div class="dossier-field"><div class="label">Complice(s)</div>${dossier.partenaires.join(', ')}</div>` : ''}
  `;
}

socket.on('dossier:yours', (dossier) => {
  myDossierHTML = renderDossierHTML(dossier);
  document.getElementById('dossier-content').innerHTML = myDossierHTML;
  document.getElementById('my-dossier-panel').innerHTML = myDossierHTML;
  show('screen-dossier');
});

document.getElementById('btn-dossier-ready').onclick = () => {
  socket.emit('dossier:ready', {}, (res) => {
    if (!res.ok) return toast(res.error);
    document.getElementById('btn-dossier-ready').textContent = '✓ Dossier lu';
    document.getElementById('btn-dossier-ready').disabled = true;
    toast('Dossier validé. L’hôte peut lancer l’enquête.');
  });
};
socket.on('dossier:ready:progress', ({ ready, total }) => {
  const bar = document.getElementById('lobby-readiness');
  if (bar) bar.innerHTML = `<strong>📋 Dossiers lus :</strong> ${ready} / ${total}`;
});

// Le dossier reste consultable à tout moment pendant l'enquête / le vote
document.getElementById('btn-toggle-dossier').onclick = () => {
  const panel = document.getElementById('my-dossier-panel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
};

// ---------- CHANGEMENT DE PHASE ----------
socket.on('phase:changed', ({ phase, phaseEndsAt, revealedClueCount = 0, activeClueCount = 0 }) => {
  state.phase = phase;
  setPhaseTheme(phase);
  SFX.phase();
  announceBanner({ icon: '🎬', kicker: 'Nouvelle phase', title: phaseLabel(phase), type: 'phase', duration: 2600 });
  routeToPhaseScreen(phase);
  document.getElementById('phase-label').textContent = phaseLabel(phase);
  startCountdown(phaseEndsAt);
  startPhaseProgress(phaseEndsAt);
  updateLiveStrip();
  if (phase === 'enquete') {
    renderInvestigationGuide(Number(localStorage.getItem('mystery_guide_step') || 0));
    state.tensionStartedAt = Date.now();
    state.confidenceSubmitted = false;
    renderConfidenceList(state.players);
    const confidenceBox = document.querySelector('.confidence-box');
    if (confidenceBox) confidenceBox.style.display = 'none';
    updateTension(phaseEndsAt);
  } else {
    const tf = document.getElementById('tension-fill');
    if (tf) tf.style.width = '0%';
    const tl = document.getElementById('tension-label');
    if (tl) tl.textContent = phase === 'reveal' ? 'DOSSIER CLASSÉ' : 'EN ATTENTE';
  }

  const btnAdv = document.getElementById('btn-advance-phase');
  const controller = state.isHost || state.isGameMaster;
  btnAdv.style.display = controller && !['reveal'].includes(phase) ? 'block' : 'none';
  if (phase === 'dossier') btnAdv.textContent = '⚡ Tout le monde est prêt → Lancer l’enquête';
  else if (phase === 'enquete') btnAdv.textContent = '⚡ Terminer l’enquête → Ouvrir l’accusation finale';
  else if (phase === 'accusation') btnAdv.textContent = '⚡ Clore l’accusation finale';
  else btnAdv.textContent = '⚡ Passer à la phase suivante';
  document.getElementById('gm-panel').style.display = state.isGameMaster ? 'block' : 'none';
  const bonusBtn = document.getElementById('gm-btn-bonus-clue');
  if (bonusBtn) {
    bonusBtn.style.display = controller && phase === 'enquete' ? 'inline-block' : 'none';
    bonusBtn.disabled = !!state.bonusClueUsed;
    bonusBtn.textContent = state.bonusClueUsed ? '✓ Bonus utilisé' : '⚡ Indice bonus · −60 s';
  }
  if (phase === 'dossier') {
    startDossierCountdown(phaseEndsAt);
    const ready = document.getElementById('btn-dossier-ready');
    ready.disabled = false;
    ready.textContent = '✓ J’ai fini de lire';
  }
  else clearInterval(dossierCountdownTimer);
  if (phase === 'accusation') {
    startVoteCountdown(phaseEndsAt);
    renderAccusationChecklist(state.players);
    document.getElementById('vote-result').textContent = '';
    const submitBtn = document.getElementById('btn-submit-accusation');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '🔏 Sceller mon accusation'; }
  } else { const v = document.getElementById('vote-timer-label'); if (v) v.textContent = '—'; }
});

function updateLiveStrip() {
  const map = { enquete:'Enquête sous pression', accusation:'Accusation finale', dossier:'Lecture des dossiers', distribution:'Distribution secrète', reveal:'Révélation finale' };
  const status = document.getElementById('live-phase-status');
  if (status) status.textContent = map[state.phase] || 'En direct';
  const pc = document.getElementById('player-counter');
  if (pc) pc.textContent = state.players.filter(p => p.connected).length;
}

function startDossierCountdown(endsAt) {
  clearInterval(dossierCountdownTimer);
  const label = document.getElementById('dossier-timer-label');
  const tick = () => {
    label.textContent = formatRemaining(endsAt);
    const remaining = endsAt ? Math.max(0, Math.round((endsAt - Date.now()) / 1000)) : 0;
    applyTimerUrgency(label, remaining);
  };
  tick(); dossierCountdownTimer = setInterval(tick, 500);
}

function startPhaseProgress(endsAt) {
  const fill = document.getElementById('phase-progress-fill');
  if (!fill) return;
  clearInterval(startPhaseProgress._t);
  const startedAt = Date.now();
  const tick = () => {
    if (!endsAt) { fill.style.width = '0%'; return; }
    const total = Math.max(1, endsAt - startedAt);
    const pct = Math.max(0, Math.min(100, ((Date.now() - startedAt) / total) * 100));
    fill.style.width = `${pct}%`;
  };
  tick(); startPhaseProgress._t = setInterval(tick, 500);
}
function startVoteCountdown(endsAt) {
  const label = document.getElementById('vote-timer-label');
  if (!label) return;
  clearInterval(startVoteCountdown._t);
  const tick = () => {
    label.textContent = formatRemaining(endsAt);
    const remaining = endsAt ? Math.max(0, Math.round((endsAt - Date.now()) / 1000)) : 0;
    applyTimerUrgency(label, remaining);
    applyTimerUrgency(document.querySelector('.vote-timer'), remaining);
  };
  tick(); startVoteCountdown._t = setInterval(tick, 500);
}

function phaseLabel(phase) {
  const map = {
    lobby: 'Lobby', distribution: 'Distribution', dossier: 'Dossier secret',
    enquete: 'Enquête', accusation: 'Accusation finale', reveal: 'Révélation'
  };
  return map[phase] || phase;
}

function routeToPhaseScreen(phase) {
  if (phase === 'lobby') show('screen-lobby');
  else if (phase === 'distribution' || phase === 'dossier') show('screen-dossier');
  else if (phase === 'enquete') show('screen-investigation');
  else if (phase === 'accusation') show('screen-vote');
  else if (phase === 'reveal') show('screen-reveal');
}

let countdownTimer = null;
let dossierCountdownTimer = null;
function formatRemaining(endsAt) {
  if (!endsAt) return '—';
  const remaining = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
  return `${String(Math.floor(remaining / 60)).padStart(2,'0')}:${String(remaining % 60).padStart(2,'0')}`;
}
function startCountdown(endsAt) {
  clearInterval(countdownTimer);
  const label = document.getElementById('timer-label');
  if (!endsAt) { label.textContent = '—'; return; }
  countdownTimer = setInterval(() => {
    const remaining = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
    const m = String(Math.floor(remaining / 60)).padStart(2, '0');
    const s = String(remaining % 60).padStart(2, '0');
    label.textContent = `${m}:${s}`;
    applyTimerUrgency(label, remaining);
    applyTimerUrgency(document.querySelector('.phase-hero .hero-timer'), remaining);
    if (state.phase === 'enquete') updateTension(endsAt);
    if (remaining <= 0) clearInterval(countdownTimer);
  }, 500);
}


function updateTension(endsAt) {
  const fill = document.getElementById('tension-fill');
  const label = document.getElementById('tension-label');
  if (!fill || !endsAt || !state.tensionStartedAt) return;
  const total = Math.max(1, endsAt - state.tensionStartedAt);
  const elapsed = Math.max(0, Math.min(total, Date.now() - state.tensionStartedAt));
  const pct = Math.round((elapsed / total) * 100);
  fill.style.width = `${pct}%`;
  if (label) label.textContent = pct < 25 ? 'CALME' : pct < 50 ? 'SOUS TENSION' : pct < 75 ? 'DANGER' : 'CRITIQUE';
  const confidenceBox = document.querySelector('.confidence-box');
  if (confidenceBox) {
    if (pct >= 45 || state.confidenceSubmitted) {
      confidenceBox.style.display = 'block';
      const st = document.getElementById('confidence-status');
      if (st && !state.confidenceSubmitted) st.textContent = 'À mi-parcours : choisis silencieusement ton suspect.';
    } else {
      confidenceBox.style.display = 'none';
    }
  }
}

let phaseAdvanceBusy = false;
document.getElementById('btn-advance-phase').onclick = () => {
  if (phaseAdvanceBusy) return;
  phaseAdvanceBusy = true;
  const btn = document.getElementById('btn-advance-phase'); if (btn) btn.disabled = true;
  socket.emit('phase:advance', {}, (res) => {
    phaseAdvanceBusy = false; if (btn) btn.disabled = false;
    if (!res.ok) toast(res.error);
  });
};

// ---------- INDICES ----------
socket.on('clue:revealed', (clue) => {
  state.clues.push(clue);
  SFX.clue();
  const counter = document.getElementById('clue-counter');
  if (counter) {
    counter.textContent = `${state.clues.length} / ${Math.max(state.clues.length, Number(counter.dataset.total || state.clues.length))}`;
    counter.classList.remove('counter-pop');
    void counter.offsetWidth;
    counter.classList.add('counter-pop');
  }
  const el = document.getElementById('clues-list');
  const li = document.createElement('li');
  li.className = 'clue-card clue-new';
  li.innerHTML = `<span class="clue-number">INDICE ${state.clues.length}</span>${clue.linkedCharacterId ? '<span class="hint"> PISTE LIÉE À UN SUSPECT</span>' : '<span class="hint"> PREUVE DE CONTEXTE</span>'}<br><strong>${clue.title}</strong><br><span>${clue.description}</span>`;
  el.appendChild(li);
  const badge = document.getElementById('clue-new-badge'); if (badge) { badge.style.display='inline-block'; setTimeout(()=>badge.style.display='none',4000); }
  announceBanner({ icon: '🔎', kicker: 'Nouvel indice dévoilé', title: clue.title, type: 'clue' });
});

// ---------- CHRONOLOGIE (adaptée au scénario et aux personnages présents) ----------
function renderTimeline(timeline) {
  const el = document.getElementById('timeline-list');
  el.innerHTML = '';
  (timeline || []).forEach((item) => {
    const li = document.createElement('li');
    li.innerHTML = `<strong>${item.time}</strong> — ${item.event}`;
    el.appendChild(li);
  });
}

socket.on('phase:changed', ({ phase }) => {
  if (phase === 'enquete' && storyData) renderTimeline(storyData.timeline);
});


function portraitSVG(name, large=false) {
  const n = String(name || '?').trim();
  let h = 0; for (let i=0;i<n.length;i++) h = (h*31 + n.charCodeAt(i)) >>> 0;
  const skin = ['#f0c7a5','#d99b72','#b97850','#8f573d'][h%4];
  const hair = ['#1c1512','#3b2418','#6b4427','#9b6a3d','#242b35'][((h>>>3)%5)];
  const shirt = ['#2b6b78','#70423b','#475b80','#66502f','#3c6a4c','#5b426e'][((h>>>7)%6)];
  const bg = ['#172235','#241d2b','#1c2a27','#29251c','#20243a'][((h>>>11)%5)];
  const glasses = ((h>>>13)%4===0);
  const beard = ((h>>>15)%5===0);
  const female = /sarah|emma|julie|claire/i.test(n);
  const hairLong = female || ((h>>>17)%4===0);
  const mouth = (h>>>19)%3;
  const safe = n.replace(/[<>&"']/g,'');
  return `<span class="character-portrait${large?' large':''}" title="${safe}" aria-label="Portrait de ${safe}">
  <svg viewBox="0 0 100 100" role="img" aria-hidden="true">
    <rect width="100" height="100" rx="20" fill="${bg}"/>
    <circle cx="50" cy="48" r="29" fill="${skin}"/>
    ${hairLong ? `<path d="M21 50 Q14 18 50 13 Q87 18 79 57 L70 47 Q71 28 50 27 Q28 28 27 51Z" fill="${hair}"/>` : `<path d="M21 48 Q20 18 50 13 Q80 18 79 48 L70 38 Q65 25 50 25 Q34 25 29 39Z" fill="${hair}"/>`}
    <path d="M31 49 Q37 44 43 49 M57 49 Q63 44 69 49" fill="none" stroke="#3a251c" stroke-width="3" stroke-linecap="round"/>
    <circle cx="39" cy="52" r="3" fill="#111820"/><circle cx="61" cy="52" r="3" fill="#111820"/>
    ${glasses ? `<rect x="29" y="46" width="20" height="14" rx="5" fill="none" stroke="#111820" stroke-width="2"/><rect x="51" y="46" width="20" height="14" rx="5" fill="none" stroke="#111820" stroke-width="2"/><path d="M49 50h2" stroke="#111820" stroke-width="2"/>` : ''}
    ${beard ? `<path d="M35 62 Q50 75 65 62 L62 73 Q50 82 38 73Z" fill="${hair}" opacity=".85"/>` : ''}
    <path d="M43 65 Q50 ${mouth===0?'69':mouth===1?'67':'71'} 57 65" fill="none" stroke="#8f4c48" stroke-width="2.5" stroke-linecap="round"/>
    <path d="M28 78 Q50 67 72 78 L82 100 H18Z" fill="${shirt}"/>
    <circle cx="50" cy="82" r="3" fill="rgba(255,255,255,.22)"/>
  </svg></span>`;
}
function avatarSVG(name) { return portraitSVG(name); }

// ---------- SUSPECTS ----------
function renderSuspectsAndVoteList(players) {
  const suspectsEl = document.getElementById('suspects-list');
  suspectsEl.innerHTML = '';
  players.forEach((p) => {
    const li = document.createElement('li');
    li.className = 'player-row-with-avatar';
    li.innerHTML = `${avatarSVG(p.characterName || p.name)}<span>${p.name}${p.characterName ? ' — ' + p.characterName : ''}</span>`;
    suspectsEl.appendChild(li);
  });
  if (state.phase === 'accusation') renderAccusationChecklist(players);
}

function renderInvestigationGuide(step=0) {
  const el=document.getElementById('investigation-guide'); if(!el) return;
  const steps=[
    ['🎯','Objectif actuel','Commence par lire les indices révélés et repère un suspect qui a à la fois un motif et une opportunité.'],
    ['📍','Objectif actuel','Clique sur un lieu de la carte pour vérifier les déplacements et compare-les aux alibis.'],
    ['🕵️','Objectif actuel','Interroge un suspect sur son alibi ou son accès au lieu du crime. Une réponse peut révéler une contradiction.'],
    ['🧩','Objectif actuel','Sélectionne 2 éléments dans ton tableau puis utilise « Croiser » pour formuler une hypothèse.'],
    ['⚖️','Dernière étape','Avant de voter, vérifie toujours : motif + opportunité + élément qui relie le suspect au crime.']
  ];
  const [icon,title,text]=steps[Math.min(step,steps.length-1)];
  el.style.display='block';
  el.innerHTML=`<div class="objective-card"><div class="objective-icon">${icon}</div><div><strong>${title}</strong><span>${text}</span></div><button id="guide-next" class="secondary-btn">Compris ✓</button></div>`;
  document.getElementById('guide-next')?.addEventListener('click',()=>{ const next=Math.min(step+1,steps.length-1); localStorage.setItem('mystery_guide_step',String(next)); renderInvestigationGuide(next); });
}


// ---------- ACCUSATION FINALE (manche unique, libre, sans élimination) ----------
function renderAccusationChecklist(players) {
  const el = document.getElementById('vote-list');
  if (!el) return;
  el.innerHTML = '';
  players.filter((p) => p.id !== state.playerId).forEach((p) => {
    const li = document.createElement('li');
    li.className = 'accusation-option';
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'accusation-checkbox';
    cb.value = p.id;
    label.appendChild(cb);
    const span = document.createElement('span');
    span.innerHTML = `${avatarSVG(p.characterName || p.name)}<span>${p.name}${p.characterName ? ' — ' + p.characterName : ''}</span>`;
    label.appendChild(span);
    li.appendChild(label);
    el.appendChild(li);
  });
}

document.getElementById('btn-submit-accusation').onclick = () => {
  const checked = [...document.querySelectorAll('.accusation-checkbox:checked')].map((cb) => cb.value);
  const confirmMsg = checked.length
    ? `Sceller ton accusation contre ${checked.length} suspect(s) ? C'est définitif.`
    : 'Envoyer une accusation vide (aucun suspect désigné) ? C\'est définitif.';
  if (!confirm(confirmMsg)) return;
  socket.emit('accusation:submit', { accusedPlayerIds: checked }, (res) => {
    if (!res.ok) return toast(res.error);
    toast('🔏 Accusation scellée.');
    document.getElementById('vote-result').textContent = 'Ton accusation est enregistrée. En attente des autres joueurs...';
    document.querySelectorAll('.accusation-checkbox').forEach((cb) => (cb.disabled = true));
    const btn = document.getElementById('btn-submit-accusation');
    btn.disabled = true;
    btn.textContent = '✓ Accusation envoyée';
  });
};

socket.on('accusation:progress', ({ submitted, total }) => {
  document.getElementById('vote-progress').textContent = `${submitted} / ${total} joueurs ont scellé leur accusation.`;
});


// ---------- VOTE DE CONFIANCE SILENCIEUX ----------
function renderConfidenceList(players) {
  const el = document.getElementById('confidence-list');
  const btn = document.getElementById('btn-confidence');
  if (!el || !btn) return;
  el.innerHTML = '';
  players.filter(p => p.id !== state.playerId).forEach(p => {
    const label = document.createElement('label');
    label.className = 'confidence-option';
    label.innerHTML = `<input type="radio" name="confidence-target" value="${p.id}"><span></span>`;
    label.querySelector('span').textContent = `${p.name}${p.characterName ? ' — ' + p.characterName : ''}`;
    el.appendChild(label);
  });
  btn.disabled = false;
  btn.textContent = 'Enregistrer mon intuition';
}
document.getElementById('btn-confidence').onclick = () => {
  const selected = document.querySelector('input[name="confidence-target"]:checked');
  if (!selected) return toast('Choisis le joueur qui te paraît le plus suspect.');
  socket.emit('confidence:submit', { targetPlayerId: selected.value }, (res) => {
    if (!res.ok) return toast(res.error);
    state.confidenceSubmitted = true;
    document.querySelectorAll('input[name="confidence-target"]').forEach(x => x.disabled = true);
    document.getElementById('btn-confidence').disabled = true;
    document.getElementById('btn-confidence').textContent = '✓ Intuition scellée';
    document.getElementById('confidence-status').textContent = 'Vote enregistré secrètement · révélation en fin de partie';
  });
};
socket.on('confidence:accepted', ({message}) => toast('🕯️ ' + message));

// ---------- CHAT ----------
document.getElementById('btn-send-chat').onclick = sendChat;
document.querySelectorAll('#quick-chat button').forEach(btn => btn.onclick = () => { document.getElementById('chat-input').value = btn.dataset.msg; document.getElementById('chat-input').focus(); });
document.getElementById('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});
function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat:send', { text });
  SFX.send();
  input.value = '';
}

socket.on('chat:rate_limited', ({message}) => toast('⚠️ ' + message));
socket.on('chat:message', (msg) => {
  const log = document.getElementById('chat-log');
  const div = document.createElement('div');
  div.className = 'msg' + (msg.system ? ' system' : '') + (msg.accusation ? ' accusation' : '');
  div.innerHTML = msg.system
    ? escSafe(msg.text)
    : `<span class="author">${escSafe(msg.name)} :</span> ${escSafe(msg.text)}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
});

// ---------- ACCUSATION FORMELLE ----------
document.getElementById('btn-accuse').onclick = () => {
  const suspectName = document.getElementById('acc-suspect').value.trim();
  const motif = document.getElementById('acc-motif').value.trim();
  const opportunite = document.getElementById('acc-opportunite').value.trim();
  const indice = document.getElementById('acc-indice').value.trim();
  if (!suspectName || !motif || !opportunite || !indice) {
    return toast('Remplis les 4 champs de l\'accusation.');
  }
  socket.emit('accusation:final', { suspectName, motif, opportunite, indice });
  ['acc-suspect', 'acc-motif', 'acc-opportunite', 'acc-indice'].forEach((id) => (document.getElementById(id).value = ''));
};

// ---------- RÉVÉLATION FINALE ----------

function loadHistory() {
  try {
    return Object.assign({
      games:0,
      guilty:{games:0,wins:0},
      investigator:{games:0,wins:0}
    }, JSON.parse(localStorage.getItem('mystery_history') || '{}'));
  } catch { return {games:0,guilty:{games:0,wins:0},investigator:{games:0,wins:0}}; }
}
function saveHistory(h) { localStorage.setItem('mystery_history', JSON.stringify(h)); }

socket.on('game:reveal', (reveal) => {
  const el = document.getElementById('reveal-content');
  const myOutcome = (reveal.playerOutcomes || []).find(x => x.playerId === state.playerId);
  const myRole = myOutcome?.role || 'enqueteur';
  const history = loadHistory();
  if (myOutcome) {
    history.games += 1;
    if (myOutcome.role === 'coupable') {
      history.guilty.games += 1;
      if (myOutcome.victory) history.guilty.wins += 1;
    } else {
      history.investigator.games += 1;
      if (myOutcome.victory) history.investigator.wins += 1;
    }
    saveHistory(history);
  }
  const myHist = myRole === 'coupable' ? history.guilty : history.investigator;
  const confidenceHtml = (reveal.confidenceVotes || []).length
    ? `<div class="confidence-reveal"><h3>🕯️ Les intuitions secrètes</h3>${reveal.confidenceVotes.map(v =>
        `<div class="confidence-reveal-item">${avatarSVG(v.voterName)}<span><strong>${v.voterName}</strong> soupçonnait <strong>${v.targetName}</strong>${v.targetCharacterName ? ` — ${v.targetCharacterName}` : ''}</span></div>`
      ).join('')}</div>`
    : `<div class="confidence-reveal"><h3>🕯️ Les intuitions secrètes</h3><p class="hint">Aucun vote de confiance n’a été enregistré.</p></div>`;
  el.innerHTML = `
    <div class="history-card card">
      <span class="eyebrow">TON HISTORIQUE LOCAL</span>
      <h3>Parties jouées : ${history.games}</h3>
      <div class="history-grid">
        <div class="history-stat"><strong>${history.guilty.wins}</strong><span>victoires comme coupable · ${history.guilty.games} parties</span></div>
        <div class="history-stat"><strong>${history.investigator.wins}</strong><span>victoires comme enquêteur · ${history.investigator.games} parties</span></div>
      </div>
      <p class="hint">Ces statistiques sont stockées uniquement sur cet appareil.</p>
    </div>
    <h3>Victime : ${reveal.victim.name} (${reveal.victim.age} ans)</h3>
    <h3>🏁 Verdict de ton équipe</h3>
    <p class="hint">Tu étais <strong>${myRole === 'coupable' ? 'COUPABLE' : 'ENQUÊTEUR'}</strong> · ${myOutcome?.victory ? '🏆 Victoire' : '❌ Défaite'}.</p>
    <h3>Coupable(s)</h3>
    <ul>${reveal.guilty.map((g) => `<li><strong>${escSafe(g.character)}</strong> — ${escSafe(g.explanation)}</li>`).join('')}</ul>
    <h3>Fausses pistes</h3>
    <ul>${reveal.falseLeadsSummary.map((f) => `<li>${escSafe(f)}</li>`).join('')}</ul>
    <h3>Qui était qui</h3>
    <ul>${reveal.assignments.map((a) => `<li>${avatarSVG(a.characterName)} ${escSafe(a.playerName)} incarnait <strong>${escSafe(a.characterName)}</strong>${a.wasGuilty ? ' — COUPABLE' : ''}</li>`).join('')}</ul>
    <h3>⚖️ Verdicts</h3>
    <ul>${(reveal.accusationResults || []).map((r) => `<li><strong>${escSafe(r.playerName)}</strong> — ${
      r.perfect ? '🎯 accusation parfaite' : `${r.correctCount} coupable(s) trouvé(s), ${r.wrongCount} innocent(s) accusé(s) à tort`
    } (${r.pointsEarned >= 0 ? '+' : ''}${r.pointsEarned} pts)${r.accusedCharacterNames.length ? ` — a accusé : ${r.accusedCharacterNames.map(escSafe).join(', ')}` : ' — aucune accusation'}</li>`).join('')}</ul>
    ${confidenceHtml}
    <h3>🏆 Scores</h3>
    <ol>${(reveal.scores || []).map((s) => `<li><strong>${escSafe(s.playerName)}</strong> — ${Number(s.score)||0} pts</li>`).join('')}</ol>
    <p><em>${reveal.closingLine}</em></p>
  `;
  setPhaseTheme('reveal');
  show('screen-reveal');
  document.getElementById('btn-replay').style.display = (state.isHost || state.isGameMaster) ? 'block' : 'none';
  document.getElementById('btn-new-case').style.display = (state.isHost || state.isGameMaster) ? 'block' : 'none';
  if (myOutcome?.victory) { SFX.victory(); launchConfetti(); }
  else SFX.defeat();
});

document.getElementById('btn-replay').onclick = () => {
  socket.emit('game:replay', { mode: 'same-case' }, (res) => { if (!res.ok) toast(res.error); });
};
document.getElementById('btn-new-case').onclick = () => {
  if (!confirm('Lancer une nouvelle affaire aléatoire avec les mêmes joueurs ? Le scénario changera, mais les fonctionnalités et statistiques resteront.')) return;
  socket.emit('game:replay', { mode: 'new-case' }, (res) => { if (!res.ok) toast(res.error); });
};

socket.on('game:restarted', (info = {}) => {
  state.clues = [];
  state.bonusClueUsed = false;
  state.confidenceSubmitted = false;
  state.tensionStartedAt = null;
  const same = document.getElementById('btn-replay');
  const fresh = document.getElementById('btn-new-case');
  if (same) same.style.display = 'none';
  if (fresh) fresh.style.display = 'none';
  const badge = document.getElementById('case-mode-badge');
  if (badge) badge.textContent = info.newCase ? '🎲 Nouvelle affaire surprise' : '🎭 Affaire sélectionnée';
  show('screen-lobby');
  toast(info.newCase ? '🎲 Nouvelle affaire sélectionnée. Les mêmes joueurs peuvent repartir !' : '🔄 Retour au lobby.');
});

// ---------- CHAT PRIVÉ DES COUPABLES ----------
socket.on('chat:guilty:enabled', (history) => {
  document.getElementById('guilty-chat-box').style.display = 'block';
  const log = document.getElementById('guilty-chat-log');
  log.innerHTML = '';
  (history || []).forEach(renderGuiltyMsg);
});

socket.on('chat:guilty:message', (msg) => renderGuiltyMsg(msg));

function renderGuiltyMsg(msg) {
  const log = document.getElementById('guilty-chat-log');
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `<span class="author">${msg.name} :</span> ${msg.text}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

document.getElementById('btn-send-guilty-chat').onclick = () => {
  const input = document.getElementById('guilty-chat-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat:guilty:send', { text });
  input.value = '';
};
document.getElementById('guilty-chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-send-guilty-chat').click();
});


// ---------- INDICE BONUS ----------
document.getElementById('gm-btn-bonus-clue').onclick = () => {
  if (state.bonusClueUsed) return toast('L’indice bonus a déjà été utilisé.');
  if (!confirm('Débloquer l’indice bonus ? Il sera révélé immédiatement, mais 60 secondes seront retirées du temps d’enquête.')) return;
  socket.emit('gm:bonus_clue', {}, (res) => { if (!res.ok) toast(res.error); });
};
socket.on('bonus:used', ({costSeconds, phaseEndsAt}) => {
  state.bonusClueUsed = true;
  const btn = document.getElementById('gm-btn-bonus-clue');
  if (btn) { btn.disabled = true; btn.textContent = `✓ Bonus utilisé · −${costSeconds}s`; }
  startCountdown(phaseEndsAt);
  toast(`⚡ Indice bonus débloqué : −${costSeconds} secondes.`);
});
// ---------- PANNEAU GAME MASTER ----------
document.getElementById('gm-btn-clue').onclick = () => {
  socket.emit('gm:reveal_clue_now', {}, (res) => { if (!res.ok) toast(res.error); });
};
document.getElementById('gm-btn-pause').onclick = () => {
  socket.emit('gm:pause', {}, (res) => { if (!res.ok) toast(res.error); else toast('Partie en pause.'); });
};
document.getElementById('gm-btn-resume').onclick = () => {
  socket.emit('gm:resume', {}, (res) => { if (!res.ok) toast(res.error); else toast('Partie reprise.'); });
};
document.getElementById('gm-btn-restart').onclick = () => {
  if (!confirm('Redémarrer entièrement la partie ?')) return;
  socket.emit('gm:restart', {}, (res) => { if (!res.ok) toast(res.error); });
};
document.getElementById('gm-btn-solution').onclick = () => {
  socket.emit('gm:view_solution', {}, (res) => {
    if (!res.ok) return toast(res.error);
    const s = res.solution;
    const lines = [
      `Victime : ${s.victim.name} (${s.victim.age} ans)`,
      '',
      'Coupable(s) :',
      ...s.guilty.map((g) => `- ${g.character} : ${g.explanation}`),
      '',
      'Répartition des personnages :',
      ...s.assignments.map((a) => `- ${a.playerName} = ${a.characterName}${a.wasGuilty ? ' (COUPABLE)' : ''}`)
    ];
    document.getElementById('gm-solution-view').textContent = lines.join('\n');
  });
};

socket.on('accusation:accepted', ({ correct, message }) => toast((correct ? '🎯 ' : '🕵️ ') + message));

socket.on('phase:forced', ({ phase }) => toast(`⚡ Phase passée par le contrôleur : ${phaseLabel(phase)}`));
socket.on('phase:paused', () => toast('⏸ Partie mise en pause par le contrôleur.'));
socket.on('phase:resumed', ({ phaseEndsAt }) => {
  toast('▶ Partie reprise.');
  startCountdown(phaseEndsAt);
});
socket.on('game:restarted', () => {
  toast('La partie a été redémarrée.');
  document.getElementById('guilty-chat-box').style.display = 'none';
  document.getElementById('gm-solution-view').textContent = '';
  state.confidenceSubmitted = false;
  state.bonusClueUsed = false;
  show('screen-lobby');
});

// ---------- PRÉSENCE FIABLE (changement d'appli, verrouillage d'écran...) ----------
document.addEventListener('visibilitychange', () => {
  if (!state.code) return;
  if (document.hidden) socket.emit('presence:away');
  else socket.emit('presence:back');
});


// ============================================================================
// ENQUÊTE ULTIME : carte, interrogatoires, tableau de preuves et statistiques
// ============================================================================
const InvestigationUI = (() => {
  let notes = [];
  let evidence = [];
  let selected = new Set();
  let interrogations = 0;

  function storageKey() { return `mystery_investigation_${state.code || 'local'}_${state.playerId || 'player'}`; }
  function load() {
    try { const x=JSON.parse(localStorage.getItem(storageKey())||'{}'); notes=x.notes||[]; evidence=x.evidence||[]; } catch { notes=[]; evidence=[]; }
  }
  function save() { localStorage.setItem(storageKey(), JSON.stringify({notes,evidence})); }
  function esc(v){const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML;}

  function renderMap(locations=[]) {
    const map=document.getElementById('interactive-map'); if(!map) return;
    map.innerHTML='';
    locations.forEach((l,i)=>{
      const b=document.createElement('button'); b.className='map-place'; b.dataset.id=l.id;
      b.innerHTML=`<strong>${esc(l.name)}</strong><small>${esc(l.description||'Lieu de l’affaire')}</small>`;
      b.onclick=()=>{
        map.querySelectorAll('.map-place').forEach(x=>x.classList.remove('active')); b.classList.add('active');
        const d=document.getElementById('map-detail'); if(d)d.innerHTML=`<strong>📍 ${esc(l.name)}</strong><span>${esc(l.description||'Aucune information supplémentaire.')}</span>`;
        addEvidence('Lieu',l.name,l.description||'');
      }; map.appendChild(b);
    });
  }

  function renderInterrogation(players, questions=[]) {
    const t=document.getElementById('interrogation-target'), q=document.getElementById('interrogation-question'); if(!t||!q)return;
    const oldT=t.value, oldQ=q.value;
    t.innerHTML='<option value="">Choisir un suspect…</option>';
    players.filter(p=>p.id!==state.playerId&&p.connected&&p.alive&&p.characterName).forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=`${p.name} — ${p.characterName}`;t.appendChild(o);});
    q.innerHTML='<option value="">Choisir une question…</option>';
    questions.forEach((x,i)=>{const o=document.createElement('option');o.value=i;o.textContent=x;q.appendChild(o);});
    t.value=oldT;q.value=oldQ;
  }

  function addEvidence(type,title,description='') {
    const key=title+'|'+description; if(evidence.some(x=>x.key===key)) return;
    evidence.unshift({key,type,title,description}); evidence=evidence.slice(0,30); save(); renderBoard();
  }
  function renderBoard(){
    const b=document.getElementById('evidence-board'); if(!b)return; b.innerHTML='';
    notes.forEach((n,i)=>{const el=document.createElement('div');el.className='evidence-card';el.innerHTML=`<span class="evidence-type">NOTE</span><button data-note="${i}" aria-label="Supprimer">×</button><strong>${esc(n)}</strong>`;el.querySelector('button').onclick=()=>{notes.splice(i,1);save();renderBoard()};b.appendChild(el);});
    evidence.forEach((e,i)=>{const el=document.createElement('div');el.className='evidence-card'+(selected.has(e.key)?' selected':'');el.innerHTML=`<span class="evidence-type">${esc(e.type)}</span><strong>${esc(e.title)}</strong><div>${esc(e.description)}</div>`;el.onclick=()=>{selected.has(e.key)?selected.delete(e.key):selected.add(e.key);renderBoard()};b.appendChild(el);});
  }
  function init(){load();renderBoard();}
  function bind(){
    document.getElementById('btn-add-note')?.addEventListener('click',()=>{const x=document.getElementById('investigation-note');if(!x?.value.trim())return;notes.unshift(x.value.trim());x.value='';save();renderBoard();toast('📝 Note ajoutée à ton tableau d’enquête.');});
    document.getElementById('btn-combine-evidence')?.addEventListener('click',()=>{
      const picks=evidence.filter(e=>selected.has(e.key)); if(picks.length<2)return toast('Sélectionne au moins 2 éléments à croiser.');
      const result=document.getElementById('combination-result'); if(!result)return;
      result.style.display='block'; result.innerHTML=`🔗 <strong>Déduction :</strong> ${picks.map(p=>esc(p.title)).join(' + ')} → ces éléments peuvent être reliés. Vérifie cette hypothèse avec les prochains indices et les alibis.`;
      addEvidence('DÉDUCTION','Hypothèse créée',picks.map(p=>p.title).join(' + ')); selected.clear();
    });
    document.getElementById('btn-get-hint')?.addEventListener('click',()=>{
      const cluesNow=evidence.filter(e=>e.type==='Indice' || e.type==='Interrogatoire');
      const hints=[
        'Regarde d’abord les alibis qui couvrent précisément l’heure du crime.',
        'Un motif seul ne suffit pas : cherche une opportunité réelle d’accéder au lieu.',
        'Utilise la carte pour vérifier si un déplacement annoncé est plausible.',
        'Compare les réponses d’interrogatoire aux indices déjà révélés.',
        'Si tu hésites entre deux suspects, privilégie celui dont l’alibi est contredit par un élément indépendant.'
      ];
      const idx=Math.min(cluesNow.length, hints.length-1);
      toast(`💡 Conseil : ${hints[idx]}`);
      renderInvestigationGuide(Math.min(idx+1,4));
    });
    document.getElementById('btn-interrogate')?.addEventListener('click',()=>{
      const t=document.getElementById('interrogation-target'),q=document.getElementById('interrogation-question');
      if(!t?.value||q?.value==='')return toast('Choisis un suspect et une question.');
      socket.emit('investigation:interrogate',{targetPlayerId:t.value,questionIndex:Number(q.value)},res=>{
        if(!res.ok)return toast(res.error); interrogations++; const a=document.getElementById('interrogation-answer');
        a.innerHTML=`<strong>❯ ${esc(res.question)}</strong><br>${esc(res.answer)}`; addEvidence('Interrogatoire',`Réponse de ${res.target}`,res.answer); toast('🕵️ Interrogatoire enregistré.');
      });
    });
  }
  function clues(clue){addEvidence('Indice',clue.title,clue.description||'');}
  return {init,bind,renderMap,renderInterrogation,clues,getInterrogations:()=>interrogations};
})();

socket.on('story:intro', data => { InvestigationUI.renderMap(data.locations||[]); InvestigationUI.renderInterrogation(state.players||[], data.questions||[]); });
socket.on('clue:revealed', clue => InvestigationUI.clues(clue));
const _oldRenderRoomState=renderRoomState;
renderRoomState=function(room){_oldRenderRoomState(room); InvestigationUI.renderInterrogation(room.players||[], storyData?.questions||[]);};
const _oldStoryIntro=socket.listeners('story:intro')[0]; // preserve existing listener; map listener above handles same event

document.addEventListener('DOMContentLoaded',()=>{InvestigationUI.init();InvestigationUI.bind();});

// Ajoute les éléments connus dès qu'un dossier privé arrive.
socket.on('dossier:yours', d=>{
  if(d?.alibi) { const x=document.getElementById('evidence-board'); if(x) { /* tableau privé : aucune donnée n'est envoyée aux autres */ } }
});

// Reconstruction finale + récompenses : on réutilise les données autoritaires du serveur.
function renderUltimateReveal(reveal){
  const banner=document.getElementById('final-verdict-banner'); if(banner){
    const names=(reveal.guilty||[]).map(x=>x.character).join(' + ');
    banner.innerHTML=`🔐 <strong>Verdict officiel</strong><br><span>${escSafe(names||'Affaire résolue')}</span>`;
  }
  const rec=document.getElementById('final-reconstruction'); if(rec){
    const events=(reveal.timeline||[]).slice().sort((a,b)=>String(a.time||'').localeCompare(String(b.time||'')));
    rec.innerHTML='<h3>🎬 Reconstitution des faits</h3>'+events.map(e=>`<div class="reconstruction-line"><div class="reconstruction-time">${escSafe(e.time||'—')}</div><div>${escSafe(e.event||'')}</div></div>`).join('');
  }
  const awards=document.getElementById('final-awards'); if(awards){
    const scores=(reveal.scores||[]).slice().sort((a,b)=>(b.score||0)-(a.score||0));
    awards.innerHTML='<h3>🏆 Palmarès de la partie</h3>'+scores.slice(0,4).map((s,i)=>`<div class="award-card">${['🥇','🥈','🥉','⭐'][i]||'⭐'}<strong>${escSafe(s.playerName)}</strong><span>${s.score||0} points</span></div>`).join('');
  }
}
function escSafe(v){const d=document.createElement('div');d.textContent=String(v??'');return d.innerHTML;}
const _existingRevealHandlers=socket.listeners('game:reveal');
socket.on('game:reveal', reveal=>setTimeout(()=>renderUltimateReveal(reveal),50));
