const socket = io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 500, reconnectionDelayMax: 5000 });

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
  myVote: null,
  connected: socket.connected,
  mode: localStorage.getItem('mystery_mode') || 'classic',
  markedClues: JSON.parse(localStorage.getItem('mystery_marked_clues') || '[]')
};

const STATS_KEY='mystery_stats_v9';
const BADGE_CATALOG=[['first','Première enquête','Terminer une première partie'],['firstVote','Premier vote','Être le premier à voter correctement'],['three','3 victoires','Gagner 3 enquêtes'],['streak5','Série de 5','Gagner 5 enquêtes de suite'],['clean','Déduction pure','Trouver le coupable sans indice bonus'],['speed','Éclair','Gagner en mode rapide'],['hardcore','Sans peur','Gagner en mode hardcore'],['detective','Détective','Obtenir 500 points cumulés'],['social','Enquêteur social','Envoyer 25 messages en enquête'],['notes','Carnet noir','Prendre des notes pendant une partie'],['survivor','Dernier debout','Gagner après une reconnexion']];
function getStats(){ try{return JSON.parse(localStorage.getItem(STATS_KEY)||'{\"games\":0,\"wins\":0,\"asGuilty\":0,\"guiltyWins\":0,\"bestScore\":0,\"streak\":0,\"bestStreak\":0,\"badges\":[],\"history\":[]}')}catch{return {games:0,wins:0,asGuilty:0,guiltyWins:0,bestScore:0,streak:0,bestStreak:0,badges:[],history:[]}}}
function saveStats(v){localStorage.setItem(STATS_KEY,JSON.stringify(v))}
function awardBadge(stats,id,label){if(!stats.badges.includes(id))stats.badges.push(id);return label}
function recordResult(reveal){if(state.lastRecordedGameId===reveal.gameId){return getStats()}state.lastRecordedGameId=reveal.gameId;const stats=getStats();stats.games++;const me=(reveal.scores||[]).find(x=>x.playerId===state.playerId);const myAssignment=(reveal.assignments||[]).find(x=>x.playerId===state.playerId);const guilty=!!myAssignment?.wasGuilty;const myVote=(reveal.votes||[]).find(x=>x.playerId===state.playerId);const guessedGuilty=(reveal.guilty||[]).some(g=>g.character===myVote?.characterName);if(guilty){stats.asGuilty++;if(!reveal.votes?.some(v=>v.playerName===myAssignment?.playerName&&v.count>0)){stats.guiltyWins++;}}if(!guilty&&guessedGuilty){stats.wins++;stats.streak++;stats.bestStreak=Math.max(stats.bestStreak,stats.streak)}else if(!guilty){stats.streak=0}stats.bestScore=Math.max(stats.bestScore,me?.score||0);stats.totalPoints=(stats.totalPoints||0)+(me?.score||0);stats.messagesSent=stats.messagesSent||0;if(stats.games===1)awardBadge(stats,'first','Première enquête');if(stats.wins>=3)awardBadge(stats,'three','3 victoires');if(stats.bestStreak>=5)awardBadge(stats,'streak5','Série de 5');if(!guilty&&guessedGuilty&&!state.bonusClueUsed)awardBadge(stats,'clean','Coupable trouvé sans bonus');if(!guilty&&guessedGuilty&&reveal.firstVotePlayerId===state.playerId)awardBadge(stats,'firstVote','Premier vote');if(!guilty&&guessedGuilty&&reveal.mode==='quick')awardBadge(stats,'speed','Victoire éclair');if(!guilty&&guessedGuilty&&reveal.mode==='hardcore')awardBadge(stats,'hardcore','Sans peur');if((stats.totalPoints||0)>=500)awardBadge(stats,'detective','Détective');if((state.notesUsed||0)>0)awardBadge(stats,'notes','Carnet noir');if((state.messagesSent||0)>=25)awardBadge(stats,'social','Enquêteur social');if(state.rejoined)awardBadge(stats,'survivor','Dernier debout');stats.history.unshift({title:reveal.scenarioTitle,score:me?.score||0,won:!guilty&&guessedGuilty,mode:reveal.mode||'classic',ts:Date.now()});stats.history=stats.history.slice(0,20);saveStats(stats);return stats}


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

function avatar(name, extraClass = '') {
  // Petit avatar illustré, déterministe : un même personnage garde toujours le même visage.
  const value = String(name || '?').trim();
  let hash = 0;
  for (const c of value) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const skins = ['#f2c7a5','#d89b72','#8d5b3f','#f0b98d','#b87552'];
  const hairs = ['#1b1513','#3b2418','#5b3a22','#22252a','#7b4b2b','#d0a45b'];
  const shirts = ['#234e5a','#5a354e','#3f5a42','#5a4728','#3c4764','#6a3834'];
  const skin = skins[hash % skins.length];
  const hair = hairs[(hash >>> 3) % hairs.length];
  const shirt = shirts[(hash >>> 6) % shirts.length];
  const accessory = (hash >>> 9) % 6;
  const accessories = [
    '<path d="M12 25h24" stroke="#e5b85c" stroke-width="2"/><circle cx="24" cy="25" r="2.4" fill="#e5b85c"/>',
    '<path d="M15 17h18" stroke="#55d9e8" stroke-width="2"/><path d="M15 17l-2 5m20-5l2 5" stroke="#55d9e8" stroke-width="2"/>',
    '<path d="M14 15h20l-2 5H16z" fill="#e5b85c" opacity=".9"/>',
    '<circle cx="19" cy="21" r="3" fill="none" stroke="#dbe7ea" stroke-width="1.5"/><circle cx="29" cy="21" r="3" fill="none" stroke="#dbe7ea" stroke-width="1.5"/><path d="M22 21h4" stroke="#dbe7ea" stroke-width="1.5"/>',
    '<path d="M31 19l4 4-4 4" fill="none" stroke="#e35b55" stroke-width="2"/>',
    '<path d="M16 16h16v4H16z" fill="#dbe7ea" opacity=".8"/>'
  ];
  const svg = `<svg class="avatar-svg" viewBox="0 0 48 48" role="img" aria-label="Avatar de ${esc(value)}">
    <defs><linearGradient id="av${hash}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#183743"/><stop offset="1" stop-color="#09171f"/></linearGradient></defs>
    <circle cx="24" cy="24" r="23" fill="url(#av${hash})"/>
    <path d="M9 44c1-9 7-14 15-14s14 5 15 14" fill="${shirt}"/>
    <ellipse cx="24" cy="21" rx="10" ry="12" fill="${skin}"/>
    <path d="M14 20c0-9 4-13 10-13s10 4 10 13c-3-4-6-6-10-6s-7 2-10 6z" fill="${hair}"/>
    <circle cx="20" cy="21" r="1.2" fill="#172127"/><circle cx="28" cy="21" r="1.2" fill="#172127"/>
    <path d="M21 26c2 1 4 1 6 0" fill="none" stroke="#8d5b3f" stroke-width="1.2" stroke-linecap="round"/>
    ${accessories[accessory]}
    <circle cx="24" cy="24" r="22" fill="none" stroke="#315967" stroke-width="1"/>
  </svg>`;
  return `<span class="avatar ${extraClass}" data-avatar="${esc(value)}">${svg}</span>`;
}

/* ---------------- Son (synthétisé, sans fichier externe) ---------------- */

let audioCtx = null;
state.soundOn = localStorage.getItem('mystery_sound') !== 'off';

function ensureAudioCtx() {
  if (!state.soundOn) return null;
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { return null; }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playTone(freq = 660, duration = 0.14, when = 0, gain = 0.05) {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  g.gain.value = gain;
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + when + duration);
  osc.connect(g).connect(ctx.destination);
  osc.start(ctx.currentTime + when);
  osc.stop(ctx.currentTime + when + duration + 0.02);
}

function chimeClue() { playTone(880, 0.12, 0, 0.05); playTone(1180, 0.16, 0.09, 0.045); }
function chimeChat() { playTone(520, 0.09, 0, 0.03); }
function chimeReveal() { playTone(440, 0.18, 0, 0.05); playTone(660, 0.22, 0.16, 0.05); playTone(880, 0.3, 0.34, 0.05); }

function setSoundButton() {
  const btn = $('btn-sound');
  if (!btn) return;
  btn.textContent = state.soundOn ? '🔔 Sons activés' : '🔕 Sons coupés';
  btn.setAttribute('aria-pressed', String(state.soundOn));
}
setSoundButton();
$('btn-sound').onclick = () => {
  state.soundOn = !state.soundOn;
  localStorage.setItem('mystery_sound', state.soundOn ? 'on' : 'off');
  setSoundButton();
  if (state.soundOn) { ensureAudioCtx(); playTone(700, 0.1); }
};

function applySettings(){const root=document.documentElement;const c=localStorage.getItem('mystery_contrast')||'normal',f=localStorage.getItem('mystery_font')||'normal',m=localStorage.getItem('mystery_motion')||'on',cb=localStorage.getItem('mystery_color')||'normal';root.dataset.contrast=c;root.dataset.font=f;root.dataset.motion=m;root.dataset.colorblind=cb}
applySettings();
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js').catch(()=>{}));
function speak(text){if(!('speechSynthesis'in window)||!text)return;window.speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(text);u.lang='fr-FR';u.rate=.95;window.speechSynthesis.speak(u)}
function roomLink(){return `${location.origin}/rejoindre/${state.code}`}
async function shareRoom(){const data={title:'Le Dernier Dîner',text:`Rejoins mon enquête ${state.code} 🕵️`,url:roomLink()};try{if(navigator.share)await navigator.share(data);else{await navigator.clipboard.writeText(roomLink());toast('🔗 Lien de salle copié.')}}catch{}}
$('btn-qr-room').onclick=()=>{const link=roomLink();$('room-qr').src=`/api/qr/${encodeURIComponent(state.code)}`;$('qr-code-label').textContent=state.code;$('qr-link-label').textContent=link;openModal('qr-modal')};
$('btn-copy-room-link').onclick=async()=>{try{await navigator.clipboard.writeText(roomLink());toast('🔗 Lien de salle copié.')}catch{toast(roomLink())}};
function openModal(id){$(id)?.classList.remove('hidden')}function closeModal(id){$(id)?.classList.add('hidden')}
function closeOnboarding(){localStorage.setItem('mystery_onboarding_v9','1');$('onboarding-modal')?.classList.add('hidden')}
$('btn-onboarding-close')?.addEventListener('click',closeOnboarding);$('btn-onboarding-skip')?.addEventListener('click',closeOnboarding);setTimeout(()=>{if(!localStorage.getItem('mystery_onboarding_v9'))$('onboarding-modal')?.classList.remove('hidden')},450);window.addEventListener('keydown',e=>{if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))return;if(e.key==='Escape')document.querySelectorAll('.modal:not(.hidden)').forEach(m=>m.classList.add('hidden'));if(e.key.toLowerCase()==='n'&&state.phase==='enquete')$('btn-notes')?.click();if(e.key.toLowerCase()==='r'&&state.phase==='enquete')$('btn-read-clues')?.click();if(e.key==='Enter'&&state.phase==='vote'&&state.myVote)$('btn-submit-vote')?.click()});
function renderStats(){const s=getStats();const names=Object.fromEntries(BADGE_CATALOG.map(x=>[x[0],x[1]]));$('profile-content').innerHTML=`<div class="stats-cards"><div><b>${s.games}</b><span>Parties</span></div><div><b>${s.wins}</b><span>Victoires</span></div><div><b>${s.bestScore}</b><span>Meilleur score</span></div><div><b>${s.bestStreak}</b><span>Meilleure série</span></div></div><h3>Badges</h3><div class="badges">${BADGE_CATALOG.map(x=>s.badges.includes(x[0])?`<span title="${esc(x[2])}">🏅 ${esc(names[x[0]])}</span>`:`<span class="locked-badge" title="${esc(x[2])}">🔒 ${esc(names[x[0]])}</span>`).join('')}</div><h3>Dernières parties</h3><div class="history">${s.history.slice(0,8).map(h=>`<div><span>${esc(h.title)} · ${esc(h.mode||'classic')}</span><b>${h.score} pts</b></div>`).join('')||'<span class=muted>Aucune partie.</span>'}</div>`}
$('btn-profile').onclick=()=>{renderStats();openModal('profile-modal')};$('btn-settings').onclick=()=>openModal('settings-modal');$('btn-share-room').onclick=shareRoom;document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>closeModal(b.dataset.close));
$('btn-notes').onclick=()=>{ state.notesUsed=(state.notesUsed||0)+1; $('notes-area').value=localStorage.getItem(`mystery_notes_${state.code}`)||'';openModal('notes-modal')};$('btn-save-notes').onclick=()=>{localStorage.setItem(`mystery_notes_${state.code}`,$('notes-area').value);closeModal('notes-modal');toast('📝 Notes enregistrées.')};$('btn-clear-notes').onclick=()=>{$('notes-area').value='';localStorage.removeItem(`mystery_notes_${state.code}`)};
$('btn-read-dossier').onclick=()=>speak($('my-dossier-panel').innerText||$('story-text').innerText);$('btn-read-clues').onclick=()=>speak([...document.querySelectorAll('#clues-list .clue-card')].map(x=>x.innerText).join('. '));$('btn-mark-clue').onclick=()=>{const cards=[...document.querySelectorAll('#clues-list .clue-card')];const last=cards.at(-1);if(!last)return toast('Aucun indice à marquer.');const title=last.querySelector('h3')?.innerText||'Indice';state.markedClues.push(title);localStorage.setItem('mystery_marked_clues',JSON.stringify([...new Set(state.markedClues)]));toast('⭐ Indice marqué.');};
for(const id of ['setting-contrast','setting-font','setting-motion','setting-color'])$(id).onchange=e=>{localStorage.setItem('mystery_'+id.replace('setting-',''),e.target.value);applySettings()};
let deferredInstall=null;window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();deferredInstall=e});$('btn-install').onclick=async()=>{if(deferredInstall){deferredInstall.prompt();deferredInstall=null}else toast('Sur iPhone/iPad : Partager → Ajouter à l’écran d’accueil.')}
/* ---------------- Règles du jeu ---------------- */

$('btn-rules').onclick = () => $('rules-modal').classList.remove('hidden');
$('rules-close').onclick = () => $('rules-modal').classList.add('hidden');
$('rules-close-main').onclick = () => $('rules-modal').classList.add('hidden');

/* ---------------- Copier le code de salle ---------------- */

$('btn-copy-code').onclick = async () => {
  const code = $('lobby-code').textContent.trim();
  if (!code || code === '—') return;
  try {
    await navigator.clipboard.writeText(code);
    toast('📋 Code copié : ' + code);
  } catch {
    toast('Code de salle : ' + code);
  }
};

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
  if (res.rejoined) { state.rejoined=true; toast('Connexion rétablie. Tu reprends ta place.'); }
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
  document.querySelectorAll('.phase-steps span').forEach((el, i) => el.classList.toggle('active', (room.phase === 'enquete' || room.phase === 'vote') ? i < 2 : room.phase === 'reveal' ? true : i === 0));
  state.bonusClueUsed = !!room.bonusClueUsed; state.mode=room.mode||state.mode; document.querySelectorAll('.mode-btn').forEach(x=>x.classList.toggle('active',x.dataset.mode===state.mode));
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
  if (room.phase === 'vote') {
    $('vote-status').textContent = `${room.voteCount || 0} / ${room.voteTotal || room.players.length}`;
    renderVotePanel();
  }
}


document.querySelectorAll('.mode-btn').forEach(btn=>btn.onclick=()=>{state.mode=btn.dataset.mode;localStorage.setItem('mystery_mode',state.mode);document.querySelectorAll('.mode-btn').forEach(x=>x.classList.toggle('active',x===btn));socket.emit('room:set_mode',{mode:state.mode},res=>{if(!res.ok)toast(res.error)});});

$('btn-reroll-scenario').onclick = () => {
  const btn = $('btn-reroll-scenario');
  btn.disabled = true;
  socket.emit('room:reroll_scenario', {}, res => {
    btn.disabled = false;
    if (!res.ok) toast(res.error);
    else toast(`🎲 Nouvelle affaire : ${res.scenario?.title || 'affaire tirée au sort'}`);
  });
};

$('btn-start').onclick = () => socket.emit('room:start', { mode: state.mode }, res => {
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
  else if (phase === 'enquete' || phase === 'vote') show('screen-investigation');
  else if (phase === 'reveal') show('screen-reveal');
}

(function prefillRoomFromUrl(){const m=location.pathname.match(/^\/rejoindre\/([A-Za-z0-9]{5})$/);if(m){$('join-code').value=m[1].toUpperCase();$('join-name').focus();toast('🔗 Salle '+m[1].toUpperCase()+' prête à rejoindre.')}})();

function phaseLabel(phase) {
  return ({distribution:'Distribution', dossier:'Dossier secret', enquete:'Enquête', vote:'Vote final', reveal:'Révélation'}[phase] || phase);
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
    $('dossier-readiness').textContent = '';
  }
  if (phase === 'enquete') {
    startCountdown(phaseEndsAt);
    updatePressure(phaseEndsAt);
  }
  if (phase === 'vote') {
    clearInterval(countdownTimer);
    startCountdown(phaseEndsAt);
    state.myVote = null;
    renderVotePanel();
  }
  $('vote-panel').style.display = phase === 'vote' ? 'block' : 'none';

  if (phase === 'reveal') {
    clearInterval(countdownTimer);
    $('pressure-fill').style.width = '100%';
    $('pressure-label').textContent = 'AFFAIRE CLASSÉE';
  }

  const controller = state.isHost || state.isGameMaster;
  const adv = $('btn-advance-phase');
  adv.style.display = controller && (phase === 'enquete' || phase === 'vote') ? 'block' : 'none';
  adv.textContent = phase === 'vote' ? 'Révéler la vérité →' : 'Terminer l’enquête → Passer au vote';

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
    $('timer-label').classList.toggle('warning', left <= 60 && left > 20);
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
    const left = endsAt - Date.now();
    $('dossier-timer').classList.toggle('warning', left <= 30000 && left > 10000);
    $('dossier-timer').classList.toggle('critical', left <= 10000);
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

socket.on('dossier:ready:progress', ({ ready = 0, total = 0 }) => {
  const el = $('dossier-readiness');
  if (!el) return;
  el.textContent = total ? `${ready} / ${total} joueur(s) ont fini de lire leur dossier.` : '';
});

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
  state.myVote = data.myVote ?? state.myVote;
  if (data.room?.phase === 'vote') {
    state.phaseEndsAt = data.room.phaseEndsAt;
    state.phaseStartedAt = data.room.phaseStartedAt || Date.now();
    renderVotePanel();
    startCountdown(data.room.phaseEndsAt);
  }
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
  chimeClue();
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
    list.appendChild(li);
  });
}

/* ---------------- Vote final ---------------- */

function renderVotePanel() {
  const panel = $('vote-panel');
  if (!panel) return;
  panel.style.display = state.phase === 'vote' ? 'block' : 'none';
  if (state.phase !== 'vote') return;
  const list = $('vote-list');
  list.innerHTML = '';
  const players = (state.players || []).filter(p => p.characterName && p.id !== state.playerId);
  players.forEach(p => {
    const label = document.createElement('label');
    label.className = 'vote-option' + (state.myVote === p.id ? ' selected' : '');
    label.innerHTML = `${avatar(p.characterName)}<span><strong>${esc(p.name)}</strong><small>${esc(p.characterName)}</small></span><input type="radio" name="final-vote" value="${esc(p.id)}" ${state.myVote === p.id ? 'checked' : ''}>`;
    label.onclick = () => {
      state.myVote = p.id;
      list.querySelectorAll('.vote-option').forEach(x => x.classList.remove('selected'));
      label.classList.add('selected');
      $('btn-submit-vote').disabled = false;
    };
    list.appendChild(label);
  });
  $('btn-submit-vote').disabled = !state.myVote;
  $('btn-submit-vote').textContent = state.myVote ? '✓ Confirmer mon vote' : 'Voter pour ce suspect';
  $('vote-note').textContent = state.myVote ? 'Ton choix est prêt. Tu peux encore le modifier avant la fin du vote.' : 'Un seul vote par joueur. Les résultats resteront secrets jusqu’à la révélation.';
}

$('btn-submit-vote').onclick = () => {
  if (!state.myVote) return;
  $('btn-submit-vote').disabled = true;
  socket.emit('vote:submit', { targetPlayerId: state.myVote }, res => {
    if (!res.ok) {
      $('btn-submit-vote').disabled = false;
      return toast(res.error);
    }
    $('btn-submit-vote').textContent = '✓ Vote enregistré';
    $('vote-note').textContent = 'Vote enregistré. Tu peux encore changer ton choix si tu le souhaites.';
    toast('🗳️ Vote enregistré.');
  });
};

socket.on('vote:status', ({ submitted = 0, total = 0, myVote = null }) => {
  if (myVote !== undefined) state.myVote = myVote;
  $('vote-status').textContent = `${submitted} / ${total}`;
  if (state.phase === 'vote') renderVotePanel();
});

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
    : `${msg.playerId === state.playerId ? '' : avatar(msg.name, 'avatar-chat')}<div class="bubble">${reply}<div class="message-author">${esc(msg.name)}</div><div class="message-text">${esc(msg.text)}</div><div class="message-foot"><time>${new Date(msg.ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time><button class="reply-btn">Répondre</button></div></div>${msg.playerId === state.playerId ? avatar(msg.name, 'avatar-chat') : ''}`;
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
  state.messagesSent=(state.messagesSent||0)+1;
  socket.emit('chat:send', { text, replyTo });
  $('chat-input').value = '';
  cancelReply();
}

$('btn-send-chat').onclick = sendChat;
$('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendChat();
});
socket.on('chat:message', msg => {
  renderChatMessage(msg);
  if (!msg.system && msg.playerId !== state.playerId) chimeChat();
});
socket.on('chat:rate_limited', ({message}) => toast(message));

/* ---------------- Canal coupables ---------------- */

function renderGuilty(msg) {
  const log = $('guilty-chat-log');
  const div = document.createElement('div');
  div.className = `guilty-msg ${msg.playerId === state.playerId ? 'mine' : ''}`;
  div.innerHTML = `${avatar(msg.name, 'avatar-chat')}<div class="guilty-msg-body"><strong>${esc(msg.name)}</strong><span>${esc(msg.text)}</span></div>`;
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

async function shareResultCard(reveal){
  const me=(reveal.scores||[]).find(x=>x.playerId===state.playerId);
  const rank=Math.max(1,(reveal.scores||[]).findIndex(x=>x.playerId===state.playerId)+1);
  const text=`🕵️ ${reveal.scenarioTitle}\n${me?.score||0} points · ${rank}e place\nLe Dernier Dîner`;
  try{
    const c=document.createElement('canvas');c.width=1200;c.height=675;const x=c.getContext('2d');
    const g=x.createLinearGradient(0,0,1200,675);g.addColorStop(0,'#173847');g.addColorStop(1,'#061017');x.fillStyle=g;x.fillRect(0,0,1200,675);
    x.fillStyle='#55d9e8';x.font='700 26px Arial';x.fillText('LE DERNIER DÎNER · AFFAIRE RÉSOLUE',70,90);
    x.fillStyle='#edf5f7';x.font='700 56px Georgia';x.fillText(String(reveal.scenarioTitle||'Enquête').slice(0,34),70,180);
    x.fillStyle='#e5b85c';x.font='700 42px Arial';x.fillText(`${me?.score||0} POINTS`,70,285);
    x.fillStyle='#d6e0e2';x.font='600 30px Arial';x.fillText(`${rank}e place · ${state.mode==='quick'?'Mode rapide':state.mode==='hardcore'?'Mode hardcore':'Mode classique'}`,70,345);
    x.fillStyle='#91a8b2';x.font='24px Arial';x.fillText('🕵️ Trouver la vérité. Tromper les autres. Rejouer.',70,520);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    if(blob&&navigator.share&&navigator.canShare){const file=new File([blob],'dernier-diner-resultat.png',{type:'image/png'});if(navigator.canShare({files:[file]})){await navigator.share({title:'Le Dernier Dîner',text,url:location.origin,files:[file]});return}}
    if(navigator.share){await navigator.share({title:'Le Dernier Dîner',text,url:location.origin});return}
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='dernier-diner-resultat.png';a.click();URL.revokeObjectURL(a.href);toast('📸 Carte de résultat générée.');
  }catch{try{await navigator.clipboard.writeText(text+'\n'+location.origin);toast('📋 Résultat copié.')}catch{}}
}

/* ---------------- Révélation ---------------- */

socket.on('game:reveal', reveal => {
  const stats=recordResult(reveal);
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
    <div class="reveal-section"><span class="label">VOTES & CLASSEMENT</span>
      <div class="vote-results">${(reveal.votes || []).map(v => `<div class="vote-result"><div>${avatar(v.characterName)}<span><strong>${esc(v.playerName)}</strong><small>${esc(v.characterName)}</small></span></div><b>${v.count} vote${v.count>1?'s':''}</b></div>`).join('') || '<p class="muted">Aucun vote enregistré.</p>'}</div>
      <div class="ranking">${(reveal.scores || []).map((s,i) => `<div class="rank-row"><span class="rank">${i+1}</span>${avatar(s.playerName, 'avatar-rank')}<strong>${esc(s.playerName)}</strong><span>${s.score} pts</span></div>`).join('')}</div>
    </div>
    <div class="reveal-section"><span class="label">QUI ÉTAIT QUI ?</span>
      <div class="assignment-grid">${(reveal.assignments || []).map(a => `<div>${avatar(a.characterName)}<span><strong>${esc(a.playerName)}</strong><small>${esc(a.characterName)}${a.wasGuilty?' · COUPABLE':''}</small></span></div>`).join('')}</div>
    </div>
    <div class="reveal-section"><span class="label">RECONSTITUTION</span>
      ${(reveal.timeline || []).map(x => `<div class="timeline-item"><time>${esc(x.time)}</time><p>${esc(x.event)}</p></div>`).join('')}
    </div>
    <p class="closing">“${esc(reveal.closingLine || '')}”</p>
  `;
  const mine=(reveal.scores||[]).find(x=>x.playerId===state.playerId);
  const rank=Math.max(1,(reveal.scores||[]).findIndex(x=>x.playerId===state.playerId)+1);
  $('reveal-share-card').innerHTML=`<div class="share-preview"><span>LE DERNIER DÎNER</span><strong>${esc(reveal.scenarioTitle)}</strong><b>${mine?.score||0} POINTS · ${rank}E PLACE</b><small>${stats.badges.length} badge(s) débloqué(s)</small></div>`;
  $('btn-new-case').style.display = (state.isHost || state.isGameMaster) ? 'inline-flex' : 'none';
  $('btn-share-result').onclick=()=>shareResultCard(reveal);
  show('screen-reveal');
  chimeReveal();
});

$('btn-new-case').onclick = () => {
  socket.emit('game:replay', {}, r => { if (!r.ok) toast(r.error); });
};

socket.on('game:restarted', info => {
  state.clues = [];
  state.bonusClueUsed = false;
  state.myVote = null;
  myDossier = null;
  $('guilty-chat-box').style.display = 'none';
  $('gm-solution-view').textContent = '';
  $('btn-new-case').style.display = 'none';
  $('dossier-readiness').textContent = '';
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
