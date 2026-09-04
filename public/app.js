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
  suspects: []
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
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.style.display = 'none'), 3500);
}

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
window.addEventListener('load', () => {
  const saved = loadSession();
  if (!saved) return;
  socket.emit('room:reconnect', saved, (res) => {
    if (!res.ok) { clearSession(); return; }
    state.code = saved.code;
    state.playerId = saved.playerId;
    state.token = saved.token;
    state.isGameMaster = !!res.isGameMaster;
    renderRoomState(res.room);
    routeToPhaseScreen(res.phase);
    toast('Reconnecté à la partie.');
  });
});

// ---------- ÉTAT DE SALLE (poussé par le serveur) ----------
socket.on('room:state', (room) => renderRoomState(room));

function renderRoomState(room) {
  state.players = room.players;
  state.phase = room.phase;
  state.isHost = room.players.find((p) => p.id === state.playerId)?.isHost || false;
  state.alivePlayers = room.players.filter((p) => p.alive);
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
      ? `Scénario : ${room.scenarioTitle} (${room.scenarioDifficulty})`
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
    div.innerHTML = `<div class="scenario-title">${s.title}</div><div class="scenario-diff">Difficulté : ${s.difficulty}</div>`;
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
});

// ---------- DOSSIER PRIVÉ ----------
let myDossierHTML = '';
function renderDossierHTML(dossier) {
  const statusClass = dossier.statut === 'COUPABLE' ? 'status-guilty' : 'status-innocent';
  return `
    <h3>DOSSIER CONFIDENTIEL</h3>
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
  routeToPhaseScreen(phase);
  document.getElementById('phase-label').textContent = phaseLabel(phase);
  startCountdown(phaseEndsAt);
  startPhaseProgress(phaseEndsAt);
  updateLiveStrip();

  const btnAdv = document.getElementById('btn-advance-phase');
  const controller = state.isHost || state.isGameMaster;
  btnAdv.style.display = controller && !['reveal'].includes(phase) ? 'block' : 'none';
  if (phase === 'dossier') btnAdv.textContent = '⚡ Tout le monde est prêt → Lancer l’enquête';
  else if (phase === 'enquete') btnAdv.textContent = '⚡ Terminer l’enquête → Ouvrir l’accusation finale';
  else if (phase === 'accusation') btnAdv.textContent = '⚡ Clore l’accusation finale';
  else btnAdv.textContent = '⚡ Passer à la phase suivante';
  document.getElementById('gm-panel').style.display = state.isGameMaster ? 'block' : 'none';
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
  const tick = () => { label.textContent = formatRemaining(endsAt); };
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
  const tick = () => { label.textContent = formatRemaining(endsAt); };
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
    if (remaining <= 0) clearInterval(countdownTimer);
  }, 500);
}

document.getElementById('btn-advance-phase').onclick = () => {
  socket.emit('phase:advance', {}, (res) => { if (!res.ok) toast(res.error); });
};

// ---------- INDICES ----------
socket.on('clue:revealed', (clue) => {
  state.clues.push(clue);
  const counter = document.getElementById('clue-counter');
  if (counter) counter.textContent = `${state.clues.length} / ${Math.max(state.clues.length, Number(counter.dataset.total || state.clues.length))}`;
  const el = document.getElementById('clues-list');
  const li = document.createElement('li');
  li.className = 'clue-card clue-new';
  li.innerHTML = `<span class="clue-number">INDICE ${state.clues.length}</span><strong>${clue.title}</strong><br><span>${clue.description}</span>`;
  el.appendChild(li);
  const badge = document.getElementById('clue-new-badge'); if (badge) { badge.style.display='inline-block'; setTimeout(()=>badge.style.display='none',4000); }
  toast(`🔎 Nouvel indice : ${clue.title}`);
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

// ---------- SUSPECTS ----------
function renderSuspectsAndVoteList(players) {
  const suspectsEl = document.getElementById('suspects-list');
  suspectsEl.innerHTML = '';
  players.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = `${p.name}${p.characterName ? ' — ' + p.characterName : ''}`;
    suspectsEl.appendChild(li);
  });
  if (state.phase === 'accusation') renderAccusationChecklist(players);
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
    span.textContent = `${p.name}${p.characterName ? ' — ' + p.characterName : ''}`;
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
  input.value = '';
}

socket.on('chat:message', (msg) => {
  const log = document.getElementById('chat-log');
  const div = document.createElement('div');
  div.className = 'msg' + (msg.system ? ' system' : '') + (msg.accusation ? ' accusation' : '');
  div.innerHTML = msg.system
    ? msg.text
    : `<span class="author">${msg.name} :</span> ${msg.text}`;
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
socket.on('game:reveal', (reveal) => {
  const el = document.getElementById('reveal-content');
  el.innerHTML = `
    <h3>Victime : ${reveal.victim.name} (${reveal.victim.age} ans)</h3>
    <h3>Coupable(s)</h3>
    <ul>${reveal.guilty.map((g) => `<li><strong>${g.character}</strong> — ${g.explanation}</li>`).join('')}</ul>
    <h3>Fausses pistes</h3>
    <ul>${reveal.falseLeadsSummary.map((f) => `<li>${f}</li>`).join('')}</ul>
    <h3>Qui était qui</h3>
    <ul>${reveal.assignments.map((a) => `<li>${a.playerName} incarnait <strong>${a.characterName}</strong>${a.wasGuilty ? ' — COUPABLE' : ''}</li>`).join('')}</ul>
    <h3>⚖️ Verdicts</h3>
    <ul>${(reveal.accusationResults || []).map((r) => `<li><strong>${r.playerName}</strong> — ${
      r.perfect
        ? '🎯 accusation parfaite'
        : `${r.correctCount} coupable(s) trouvé(s), ${r.wrongCount} innocent(s) accusé(s) à tort`
    } (${r.pointsEarned >= 0 ? '+' : ''}${r.pointsEarned} pts)${r.accusedCharacterNames.length ? ` — a accusé : ${r.accusedCharacterNames.join(', ')}` : ' — aucune accusation'}</li>`).join('')}</ul>
    <h3>🏆 Scores</h3>
    <ol>${(reveal.scores || []).map((s) => `<li><strong>${s.playerName}</strong> — ${s.score} pts</li>`).join('')}</ol>
    <p><em>${reveal.closingLine}</em></p>
  `;
  show('screen-reveal');
  document.getElementById('btn-replay').style.display = (state.isHost || state.isGameMaster) ? 'block' : 'none';
});

document.getElementById('btn-replay').onclick = () => { socket.emit('game:replay', {}, (res) => { if (!res.ok) toast(res.error); }); };

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
  show('screen-lobby');
});

// ---------- PRÉSENCE FIABLE (changement d'appli, verrouillage d'écran...) ----------
document.addEventListener('visibilitychange', () => {
  if (!state.code) return;
  if (document.hidden) socket.emit('presence:away');
  else socket.emit('presence:back');
});
