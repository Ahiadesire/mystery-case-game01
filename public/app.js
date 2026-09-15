const socket = io();

let state = {
  code: null,
  playerId: null,
  token: null,
  isHost: false,
  isGameMaster: false,
  players: [],
  phase: 'lobby',
  scenarioId: null,
  clues: [],
  phaseEndsAt: null,
  bonusClueUsed: false,
  connected: socket.connected
};

let storyData = null;
let myDossier = null;
let replyTo = null;
let countdownTimer = null;
let dossierTimer = null;

const $ = id => document.getElementById(id);

function show(id) {
  document.querySelectorAll('.screen').forEach(x => x.classList.remove('active'));
  $(id)?.classList.add('active');
}

function esc(value) {
  const d = document.createElement('div');
  d.textContent = String(value ?? '');
  return d.innerHTML;
}

function toast(message) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 3200);
}

function formatTime(msOrDate) {
  const remaining = Math.max(0, Math.round((Number(msOrDate) - Date.now()) / 1000));
  return `${String(Math.floor(remaining / 60)).padStart(2,'0')}:${String(remaining % 60).padStart(2,'0')}`;
}

function saveSession() {
  localStorage.setItem('mystery_session', JSON.stringify({
    code: state.code, playerId: state.playerId, token: state.token
  }));
}

function loadSession() {
  try { return JSON.parse(localStorage.getItem('mystery_session') || 'null'); }
  catch { return null; }
}

function clearSession() {
  localStorage.removeItem('mystery_session');
}

function avatar(name) {
  const value = String(name || '?').trim();
  const parts = value.split(/\s+/).filter(Boolean);
  const initials = (parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length-1][0] : '');
  let hash = 0;
  for (const c of value) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const icons = ['🕵️','🎭','🧩','🔐','🗝️','🎩','🕯️','📜'];
  return `<span class="avatar a${hash % 8}">${esc(initials.toUpperCase())}</span>`;
}

function setConnectionStatus(connected, reconnecting = false) {
  state.connected = connected;
  const banner = $('connection-banner');
  const text = $('connection-text');
  if (!banner || !text) return;
  banner.classList.toggle('offline', !connected);
  banner.classList.toggle('reconnecting', reconnecting);
  text.textContent = connected ? 'Connexion en direct' : (reconnecting ? 'Reconnexion… la partie est conservée' : 'Connexion perdue — reconnexion automatique');
}

/* ---------------- Accueil / session ---------------- */

$('btn-create').onclick = () => {
  const name = $('create-name').value.trim();
  if (!name) return toast('Entre ton nom.');
  socket.emit('room:create', { name, asGameMaster: $('create-gm').checked }, res => {
    if (!res.ok) return $('home-error').textContent = res.error;
    applyJoinResult(res);
  });
};

$('btn-join').onclick = () => {
  const name = $('join-name').value.trim();
  const code = $('join-code').value.trim().toUpperCase();
  if (!name || !code) return toast('Nom et code requis.');
  socket.emit('room:join', { name, code }, res => {
    if (!res.ok) return $('home-error').textContent = res.error;
    applyJoinResult(res);
  });
};

function applyJoinResult(res) {
  state.code = res.code;
  state.playerId = res.playerId;
  state.token = res.token;
  state.isGameMaster = !!res.isGameMaster;
  saveSession();
  renderRoom(res.room);
  route(res.room.phase);
  if (res.rejoined) toast('Connexion rétablie. Tu reprends ta place.');
}

function tryReconnect() {
  const saved = loadSession();
  if (!saved?.code || !saved?.playerId || !saved?.token) return;
  if (tryReconnect.busy) return;
  tryReconnect.busy = true;
  socket.emit('room:reconnect', saved, res => {
    tryReconnect.busy = false;
    if (!res.ok) {
      if (/Reconnexion invalide|Salle introuvable/i.test(res.error || '')) {
        clearSession();
        state.code = state.playerId = state.token = null;
      }
      return;
    }
    state.code = saved.code;
    state.playerId = saved.playerId;
    state.token = saved.token;
    state.isGameMaster = !!res.isGameMaster;
    renderRoom(res.room);
    route(res.phase);
    toast('🟢 Reconnecté — progression conservée.');
  });
}

socket.on('connect', () => {
  setConnectionStatus(true);
  if (!state.code) {
    const saved = loadSession();
    if (saved) Object.assign(state, { code:saved.code, playerId:saved.playerId, token:saved.token });
  }
  if (state.code) tryReconnect();
});

socket.on('disconnect', () => {
  tryReconnect.busy = false;
  setConnectionStatus(false, true);
});
socket.on('connect_error', () => setConnectionStatus(false, true));

window.addEventListener('load', tryReconnect);

document.addEventListener('visibilitychange', () => {
  if (!state.code) return;
  socket.emit(document.hidden ? 'presence:away' : 'presence:back');
});

/* ---------------- Salle / scénario aléatoire ---------------- */

socket.on('room:state', renderRoom);

function renderRoom(room) {
  state.players = room.players || [];
  state.phase = room.phase;
  state.scenarioId = room.scenarioId;
  document.querySelectorAll('.phase-steps span').forEach((el, i) => el.classList.toggle('active', room.phase === 'enquete' ? i < 2 : room.phase === 'reveal' ? true : i === 0));
  state.bonusClueUsed = !!room.bonusClueUsed;
  state.isHost = !!room.players?.find(p => p.id === state.playerId)?.isHost;

  $('lobby-code').textContent = room.code || '—';
  $('lobby-count').textContent = `${room.players.filter(p => p.connected).length} / ${room.maxPlayers} joueurs`;

  $('case-title').textContent = room.scenarioTitle || 'Affaire en préparation';
  $('case-difficulty').textContent = `Difficulté : ${room.scenarioDifficulty || '—'}`;
  $('case-pool').textContent = `🎲 ${room.scenarioPoolSize || 0} affaires disponibles`;
  $('scenario-note').textContent =
    `${room.scenarioPlayedCount || 0} affaire(s) déjà jouée(s) dans cette salle. Les nouvelles affaires ne se répètent pas avant d'avoir épuisé le catalogue.`;

  const controller = state.isHost || state.isGameMaster;
  const reroll = $('btn-reroll-scenario');
  reroll.style.display = controller && room.phase === 'lobby' && (room.scenarioPoolSize || 0) > 1 ? 'inline-flex' : 'none';
  reroll.disabled = false;

  const list = $('lobby-players');
  list.innerHTML = '';
  room.players.forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `${avatar(p.name)}<div class="player-main"><strong>${esc(p.name)}</strong><small>${p.connected ? '🟢 En ligne' : '⚪ Déconnecté'}</small></div>${p.isHost ? '<span class="host-badge">HÔTE</span>' : ''}`;
    if (controller && room.phase === 'lobby' && !p.isHost) {
      const kick = document.createElement('button');
      kick.className = 'tiny-danger';
      kick.textContent = 'Retirer';
      kick.onclick = () => {
        if (confirm(`Retirer ${p.name} de la salle ?`))
          socket.emit('room:kick', { targetPlayerId:p.id }, r => { if (!r.ok) toast(r.error); });
      };
      li.appendChild(kick);
    }
    list.appendChild(li);
  });

  $('btn-start').style.display = controller && room.phase === 'lobby' ? 'block' : 'none';
  if (room.phase === 'lobby') {
    const count = room.players.filter(p => p.connected).length;
    $('btn-start').disabled = count < room.minPlayers;
    $('lobby-hint').textContent = count < room.minPlayers
      ? `Encore ${room.minPlayers - count} joueur(s) nécessaire(s).`
      : `✓ Tout est prêt. ${room.minPlayers} à ${room.maxPlayers} joueurs.`;
  }

  renderSuspects(room.players);
}

$('btn-reroll-scenario').onclick = () => {
  const btn = $('btn-reroll-scenario');
  btn.disabled = true;
  socket.emit('room:reroll_scenario', {}, res => {
    btn.disabled = false;
    if (!res.ok) toast(res.error);
    else toast(`🎲 Nouvelle affaire : ${res.scenario?.title || 'affaire tirée au sort'}`);
  });
};

$('btn-start').onclick = () => socket.emit('room:start', {}, res => {
  if (!res.ok) toast(res.error);
  else toast('🔎 L’enquête commence…');
});

socket.on('room:kicked', () => {
  clearSession();
  alert('Tu as été retiré de la salle.');
  location.reload();
});

/* ---------------- Phases ---------------- */

function route(phase) {
  if (phase === 'lobby') show('screen-lobby');
  else if (phase === 'distribution' || phase === 'dossier') show('screen-dossier');
  else if (phase === 'enquete') show('screen-investigation');
  else if (phase === 'reveal') show('screen-reveal');
}

function phaseLabel(phase) {
  return ({distribution:'Distribution', dossier:'Dossier secret', enquete:'Enquête', reveal:'Révélation'}[phase] || phase);
}

socket.on('phase:changed', ({ phase, phaseEndsAt, revealedClueCount = 0, activeClueCount = 0 }) => {
  state.phase = phase;
  state.phaseEndsAt = phaseEndsAt;
  if (storyData) storyData.activeClueCount = activeClueCount;
  state.phaseStartedAt = Date.now();
  state.clues = [];
  $('phase-title').textContent = phaseLabel(phase);
  route(phase);

  if (phase === 'dossier') {
    startDossierTimer(phaseEndsAt);
    $('btn-dossier-ready').disabled = false;
    $('btn-dossier-ready').textContent = 'J’ai fini de lire';
  }
  if (phase === 'enquete') {
    startCountdown(phaseEndsAt);
    updatePressure(phaseEndsAt);
  }
  if (phase === 'reveal') {
    clearInterval(countdownTimer);
    $('pressure-fill').style.width = '100%';
    $('pressure-label').textContent = 'AFFAIRE CLASSÉE';
  }

  const controller = state.isHost || state.isGameMaster;
  const adv = $('btn-advance-phase');
  adv.style.display = controller && phase === 'enquete' ? 'block' : 'none';
  adv.textContent = 'Terminer l’enquête → Révéler la vérité';

  $('gm-panel').style.display = state.isGameMaster ? 'block' : 'none';
  $('gm-btn-bonus-clue').disabled = !!state.bonusClueUsed;
});

$('btn-advance-phase').onclick = () => {
  $('btn-advance-phase').disabled = true;
  socket.emit('phase:advance', {}, res => {
    $('btn-advance-phase').disabled = false;
    if (!res.ok) toast(res.error);
  });
};

function startCountdown(endsAt) {
  clearInterval(countdownTimer);
  const tick = () => {
    $('timer-label').textContent = formatTime(endsAt);
    const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
    const pct = Math.max(0, Math.min(100, 100 - (left / Math.max(1, (endsAt - (state.phaseStartedAt || Date.now()))) * 100)));
    updatePressure(endsAt, pct);
    $('timer-label').classList.toggle('critical', left <= 20);
    if (left <= 0) clearInterval(countdownTimer);
  };
  tick();
  countdownTimer = setInterval(tick, 500);
}

function startDossierTimer(endsAt) {
  clearInterval(dossierTimer);
  const tick = () => {
    $('dossier-timer').textContent = formatTime(endsAt);
    $('dossier-timer').classList.toggle('critical', (endsAt-Date.now()) <= 20000);
  };
  tick();
  dossierTimer = setInterval(tick, 500);
}

function updatePressure(endsAt) {
  if (!endsAt) return;
  const total = Math.max(1, state.phaseStartedAt ? endsAt - state.phaseStartedAt : 1200000);
  const elapsed = Math.max(0, total - Math.max(0, endsAt - Date.now()));
  const pct = Math.max(0, Math.min(100, elapsed / total * 100));
  $('pressure-fill').style.width = `${pct}%`;
  $('pressure-label').textContent = pct < 30 ? 'CALME' : pct < 60 ? 'SOUS PRESSION' : pct < 82 ? 'DANGER' : 'CRITIQUE';
}

/* ---------------- Dossier ---------------- */

function renderDossier(d) {
  if (!d) return;
  myDossier = d;
  const status = d.statut === 'COUPABLE' ? 'guilty' : 'innocent';
  const html = `
    <div class="identity"><div class="big-avatar">${avatar(d.identite.nom)}</div><div><span class="label">TU INCARNES</span><h2>${esc(d.identite.nom)}</h2><p>${esc(d.identite.role)} · ${esc(d.identite.age)} ans</p></div></div>
    <div class="dossier-grid">
      <div><span>Relation</span><p>${esc(d.relation)}</p></div>
      <div><span>Motif</span><p>${esc(d.motif)}</p></div>
      <div><span>Secret</span><p>${esc(d.secret)}</p></div>
      <div><span>Alibi</span><p>${esc(d.alibi)}</p></div>
      <div><span>Opportunité</span><p>${esc(d.opportunite)}</p></div>
      <div><span>Objectif</span><p>${esc(d.objectif)}</p></div>
    </div>
    ${d.informations?.length ? `<div class="info-box"><span class="label">CE QUE TU SAIS</span>${d.informations.map(x=>`<p>• ${esc(x)}</p>`).join('')}</div>` : ''}
    <div class="secret-status ${status}">${status === 'guilty' ? '🤫 TU ES COUPABLE — joue ton rôle sans te faire repérer.' : '🕵️ TU ES ENQUÊTEUR — découvre les incohérences avant les autres.'}</div>
  `;
  $('dossier-content').innerHTML = html;
  $('my-dossier-panel').innerHTML = html;
}

socket.on('dossier:yours', renderDossier);

$('btn-dossier-ready').onclick = () => {
  socket.emit('dossier:ready', {}, res => {
    if (!res.ok) return toast(res.error);
    $('btn-dossier-ready').disabled = true;
    $('btn-dossier-ready').textContent = '✓ Dossier lu';
  });
};

$('btn-toggle-dossier').onclick = () => {
  const el = $('my-dossier-panel');
  el.classList.toggle('hidden');
  $('btn-toggle-dossier').textContent = el.classList.contains('hidden') ? 'Afficher' : 'Masquer';
};

/* ---------------- Introduction / synchronisation ---------------- */

function renderStory(data) {
  if (!data) return;
  storyData = data;
  $('story-text').textContent = data.text || '';
  renderTimeline(data.timeline || []);
}

socket.on('story:intro', renderStory);

socket.on('game:sync', data => {
  if (data.room) { renderRoom(data.room); if (storyData) storyData.activeClueCount = data.room.activeClueCount || storyData.activeClueCount || 0; }
  if (data.story) renderStory(data.story);
  if (data.dossier) renderDossier(data.dossier);
  state.clues = [];
  clearClues();
  (data.revealedClues || []).forEach(c => renderClue(c, false));
  renderChatHistory(data.chatLog || []);
  if (data.room?.phase === 'enquete') {
    state.phaseEndsAt = data.room.phaseEndsAt;
    state.phaseStartedAt = data.room.phaseStartedAt || Date.now();
    startCountdown(data.room.phaseEndsAt);
  }
});

/* ---------------- Indices / chronologie / suspects ---------------- */

function clearClues() {
  $('clues-list').innerHTML = '';
  $('empty-clues').style.display = 'block';
  $('clue-counter').textContent = '0 / 0';
}

function renderClue(clue, animate = true) {
  state.clues.push(clue);
  $('empty-clues').style.display = 'none';
  $('clue-counter').textContent = `${state.clues.length} / ${Math.max(state.clues.length, storyData?.activeClueCount || state.clues.length)}`;
  const card = document.createElement('article');
  card.className = 'clue-card' + (animate ? ' clue-new' : '');
  card.innerHTML = `<div class="clue-top"><span>PREUVE ${state.clues.length}</span><time>${esc(clue.order || '')}</time></div><h3>${esc(clue.title)}</h3><p>${esc(clue.description)}</p><button class="reply-evidence" type="button">Partager dans le chat</button>`;
  card.querySelector('button').onclick = () => {
    $('chat-input').value = `🔎 J’ai relevé « ${clue.title} » : ${clue.description}`;
    $('chat-input').focus();
  };
  $('clues-list').prepend(card);
}

socket.on('clue:revealed', clue => {
  renderClue(clue, true);
  toast(`🔎 Nouvel indice : ${clue.title}`);
});

function renderTimeline(items) {
  const el = $('timeline-list');
  el.innerHTML = (items || []).map(x => `<div class="timeline-item"><time>${esc(x.time)}</time><p>${esc(x.event)}</p></div>`).join('');
}

function renderSuspects(players) {
  const list = $('suspects-list');
  list.innerHTML = '';
  (players || []).filter(p => p.characterName).forEach(p => {
    const li = document.createElement('li');
    li.innerHTML = `${avatar(p.characterName)}<div><strong>${esc(p.name)}</strong><small>${esc(p.characterName)}</small></div><span class="${p.connected?'online':'offline'}">${p.connected?'●':'○'}</span>`;
    if (p.id !== state.playerId && p.connected && state.phase === 'enquete') {
      const btn = document.createElement('button');
      btn.className = 'interrogate-btn';
      btn.textContent = 'Interroger';
      btn.onclick = () => openInterrogation(p);
      li.appendChild(btn);
    }
    list.appendChild(li);
  });
}

let interrogationTarget = null;
const interrogationQuestions = [
  'Où étais-tu au moment des faits ?',
  'Quelle était ta relation avec la victime ?',
  'Pourquoi aurais-tu pu lui en vouloir ?'
];

function openInterrogation(player) {
  interrogationTarget = player;
  $('interrogate-title').textContent = `Interroger ${player.name}`;
  $('interrogate-answer').classList.add('hidden');
  $('interrogate-answer').textContent = '';
  const box = $('interrogate-questions');
  box.innerHTML = '';
  interrogationQuestions.forEach((q, index) => {
    const b = document.createElement('button');
    b.className = 'secondary question-btn';
    b.textContent = q;
    b.onclick = () => askInterrogation(index);
    box.appendChild(b);
  });
  $('interrogate-modal').classList.remove('hidden');
}

function askInterrogation(questionIndex) {
  if (!interrogationTarget) return;
  $('interrogate-questions').querySelectorAll('button').forEach(b => b.disabled = true);
  socket.emit('investigation:interrogate', { targetPlayerId: interrogationTarget.id, questionIndex }, res => {
    $('interrogate-questions').querySelectorAll('button').forEach(b => b.disabled = false);
    if (!res.ok) return toast(res.error);
    const answer = $('interrogate-answer');
    answer.innerHTML = `<strong>${esc(res.question)}</strong><p>${esc(res.answer)}</p>`;
    answer.classList.remove('hidden');
    toast(`🔎 Réponse obtenue de ${res.target}`);
  });
}

function closeInterrogation() { $('interrogate-modal').classList.add('hidden'); interrogationTarget = null; }
$('interrogate-close').onclick = closeInterrogation;
$('interrogate-modal').addEventListener('click', e => { if (e.target.id === 'interrogate-modal') closeInterrogation(); });

/* ---------------- Chat façon WhatsApp ---------------- */

function setReply(msg) {
  replyTo = msg;
  $('reply-name').textContent = msg.name;
  $('reply-text').textContent = msg.text;
  $('reply-preview').classList.remove('hidden');
  $('chat-input').focus();
}

function cancelReply() {
  replyTo = null;
  $('reply-preview').classList.add('hidden');
}

$('cancel-reply').onclick = cancelReply;

function renderChatMessage(msg) {
  const log = $('chat-log');
  const wrap = document.createElement('div');
  wrap.className = `chat-message ${msg.playerId === state.playerId ? 'mine' : 'other'} ${msg.system ? 'system' : ''}`;
  const reply = msg.replyTo
    ? `<div class="quoted"><strong>${esc(msg.replyTo.name)}</strong><span>${esc(msg.replyTo.text)}</span></div>`
    : '';
  wrap.innerHTML = msg.system
    ? `<div class="system-bubble">${esc(msg.text)}</div>`
    : `<div class="bubble">${reply}<div class="message-author">${esc(msg.name)}</div><div class="message-text">${esc(msg.text)}</div><div class="message-foot"><time>${new Date(msg.ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time><button class="reply-btn">Répondre</button></div></div>`;
  wrap.querySelector('.reply-btn')?.addEventListener('click', () => setReply(msg));
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
}

function renderChatHistory(messages) {
  $('chat-log').innerHTML = '';
  (messages || []).forEach(renderChatMessage);
}

function sendChat() {
  const text = $('chat-input').value.trim();
  if (!text) return;
  socket.emit('chat:send', { text, replyTo });
  $('chat-input').value = '';
  cancelReply();
}

$('btn-send-chat').onclick = sendChat;
$('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendChat();
});
socket.on('chat:message', renderChatMessage);
socket.on('chat:rate_limited', ({message}) => toast(message));

/* ---------------- Canal coupables ---------------- */

function renderGuilty(msg) {
  const log = $('guilty-chat-log');
  const div = document.createElement('div');
  div.className = `guilty-msg ${msg.playerId === state.playerId ? 'mine' : ''}`;
  div.innerHTML = `<strong>${esc(msg.name)}</strong><span>${esc(msg.text)}</span>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

socket.on('chat:guilty:enabled', history => {
  $('guilty-chat-box').style.display = 'block';
  $('guilty-chat-log').innerHTML = '';
  (history || []).forEach(renderGuilty);
});
socket.on('chat:guilty:message', renderGuilty);

$('btn-send-guilty-chat').onclick = () => {
  const text = $('guilty-chat-input').value.trim();
  if (!text) return;
  socket.emit('chat:guilty:send', {text});
  $('guilty-chat-input').value = '';
};
$('guilty-chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('btn-send-guilty-chat').click();
});

/* ---------------- Game Master ---------------- */

$('gm-btn-clue').onclick = () => socket.emit('gm:reveal_clue_now', {}, r => { if (!r.ok) toast(r.error); });
$('gm-btn-bonus-clue').onclick = () => {
  if (state.bonusClueUsed) return;
  if (confirm('Révéler un indice supplémentaire en retirant 60 secondes ?'))
    socket.emit('gm:bonus_clue', {}, r => { if (!r.ok) toast(r.error); });
};
$('gm-btn-pause').onclick = () => socket.emit('gm:pause', {}, r => { if (!r.ok) toast(r.error); });
$('gm-btn-resume').onclick = () => socket.emit('gm:resume', {}, r => { if (!r.ok) toast(r.error); });
$('gm-btn-restart').onclick = () => {
  if (confirm('Redémarrer la salle ?')) socket.emit('gm:restart', {}, r => { if (!r.ok) toast(r.error); });
};
$('gm-btn-solution').onclick = () => socket.emit('gm:view_solution', {}, r => {
  if (!r.ok) return toast(r.error);
  $('gm-solution-view').textContent = (r.solution.guilty || []).map(x => `${x.character}\n${x.explanation}`).join('\n\n');
});

socket.on('bonus:used', ({costSeconds, phaseEndsAt}) => {
  state.bonusClueUsed = true;
  $('gm-btn-bonus-clue').disabled = true;
  $('gm-btn-bonus-clue').textContent = `✓ Bonus · −${costSeconds}s`;
  startCountdown(phaseEndsAt);
});

socket.on('phase:paused', () => toast('⏸ Enquête en pause.'));
socket.on('phase:resumed', ({phaseEndsAt}) => startCountdown(phaseEndsAt));

/* ---------------- Révélation ---------------- */

socket.on('game:reveal', reveal => {
  const me = (reveal.assignments || []).find(x => x.playerId === state.playerId);
  const role = me?.wasGuilty ? 'Coupable' : 'Enquêteur';
  $('reveal-intro').textContent = `Tu incarnas ${me?.characterName || 'un participant'} · ${role}.`;
  $('reveal-content').innerHTML = `
    <div class="truth-card"><span class="label">LA VÉRITÉ</span><h2>Le ou les coupables</h2>
      ${(reveal.guilty || []).map(g => `<div class="guilty-reveal">${avatar(g.character)}<div><strong>${esc(g.character)}</strong><p>${esc(g.explanation)}</p></div></div>`).join('')}
    </div>
    <div class="reveal-section"><span class="label">FAUSSES PISTES</span>
      ${(reveal.falseLeadsSummary || []).map(x => `<p>• ${esc(x)}</p>`).join('')}
    </div>
    <div class="reveal-section"><span class="label">QUI ÉTAIT QUI ?</span>
      <div class="assignment-grid">${(reveal.assignments || []).map(a => `<div>${avatar(a.characterName)}<span><strong>${esc(a.playerName)}</strong><small>${esc(a.characterName)}${a.wasGuilty?' · COUPABLE':''}</small></span></div>`).join('')}</div>
    </div>
    <div class="reveal-section"><span class="label">RECONSTITUTION</span>
      ${(reveal.timeline || []).map(x => `<div class="timeline-item"><time>${esc(x.time)}</time><p>${esc(x.event)}</p></div>`).join('')}
    </div>
    <p class="closing">“${esc(reveal.closingLine || '')}”</p>
  `;
  $('btn-new-case').style.display = (state.isHost || state.isGameMaster) ? 'inline-flex' : 'none';
  show('screen-reveal');
});

$('btn-new-case').onclick = () => {
  socket.emit('game:replay', {}, r => { if (!r.ok) toast(r.error); });
};

socket.on('game:restarted', info => {
  state.clues = [];
  state.bonusClueUsed = false;
  myDossier = null;
  $('guilty-chat-box').style.display = 'none';
  $('gm-solution-view').textContent = '';
  $('btn-new-case').style.display = 'none';
  show('screen-lobby');
  if (info?.newCase) toast('🎲 Nouvelle affaire sélectionnée.');
});

socket.on('story:recap', data => showEpisodeRecap(data));

/* ---------------- Récap retardataire ---------------- */

function showEpisodeRecap(data) {
  if (!data || state.phase === 'reveal') return;
  $('episode-title').textContent = data.title || 'Récap';
  $('episode-message').textContent = data.message || '';
  $('episode-case').textContent = data.scenarioTitle || '—';
  $('episode-phase').textContent = data.phase || '—';
  $('episode-victim').textContent = data.victim?.name || '—';
  $('episode-clues').textContent = `${data.clueCount || 0} / ${data.activeClueCount || 0}`;
  $('episode-clues-list').innerHTML = (data.revealedClues || []).map((c,i) =>
    `<div class="recap-clue"><strong>Preuve ${i+1} · ${esc(c.title)}</strong><span>${esc(c.description)}</span></div>`
  ).join('') || '<p class="muted">Aucun indice n’a encore été révélé.</p>';
  $('episode-modal').classList.remove('hidden');
}

function closeRecap() { $('episode-modal').classList.add('hidden'); }
$('episode-close').onclick = closeRecap;
$('episode-close-main').onclick = closeRecap;

/* Initialisation */
$('chat-log').innerHTML = '';
