'use strict';

const socket = io();
let state        = null;
let selectedSeat = null;  // seat the player has clicked in the lobby

// ── Constants ─────────────────────────────────────────────────────────────────
const SYM      = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };
const RED      = new Set(['hearts', 'diamonds']);
const RANK_VAL = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,J:11,Q:12,K:13,A:14 };
const SUIT_ORD = { spades:0, hearts:1, diamonds:2, clubs:3 };

// ── Utility ───────────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const sym = s  => SYM[s] || '?';
const red = s  => RED.has(s);

// Position of another seat relative to mine
// offset 1 → right, 2 → top (across), 3 → left
function relPos(mine, theirs) {
  if (theirs === mine) return 'bottom';
  return { 1:'right', 2:'top', 3:'left' }[(theirs - mine + 4) % 4];
}

function teamLetter(seat) { return seat % 2 === 0 ? 'A' : 'B'; }
function teamName(seat, s) {
  const names = s?.teamNames || ['Team A', 'Team B'];
  return esc(names[seat % 2]);
}

// ── Socket Events ─────────────────────────────────────────────────────────────
socket.on('connect', () => {
  // On reconnect, try to rejoin automatically with saved name
  const saved = sessionStorage.getItem('af_name');
  if (saved) socket.emit('join', { name: saved, seat: -1 }); // seat -1 = reconnect attempt
});

socket.on('lobby', lobbyState => {
  // Update seat picker while still in the lobby screen
  if ($('screen-lobby').classList.contains('hidden')) return;
  updateSeatPicker(lobbyState);
  // Sync team name inputs (skip if the player is actively typing in that field)
  if (lobbyState.teamNames) {
    [0, 1].forEach(i => {
      const el = $(`team-name-${i}`);
      if (el && document.activeElement !== el) el.value = lobbyState.teamNames[i];
    });
  }
});

socket.on('state', s => {
  state = s;
  showScreen('game');
  render(s);
});

socket.on('err', msg => {
  showError(msg);
  // Also show in lobby error div if we're still there
  if (!$('screen-lobby').classList.contains('hidden')) {
    const errEl = $('lobby-error');
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
    setTimeout(() => errEl.classList.add('hidden'), 3000);
  }
});

// ── Lobby ─────────────────────────────────────────────────────────────────────
$('join-btn').addEventListener('click', doJoin);
$('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });

// Team name inputs — debounced so we only emit after typing pauses
const _nameTimers = [null, null];
[0, 1].forEach(i => {
  const el = $(`team-name-${i}`);
  if (!el) return;
  el.addEventListener('input', () => {
    clearTimeout(_nameTimers[i]);
    _nameTimers[i] = setTimeout(() => {
      socket.emit('set_team_name', { team: i, name: el.value });
    }, 400);
  });
});

// Seat button clicks
document.querySelectorAll('.seat-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('seat-taken')) return;
    // Deselect previous
    document.querySelectorAll('.seat-btn').forEach(b => b.classList.remove('seat-selected'));
    btn.classList.add('seat-selected');
    selectedSeat = parseInt(btn.dataset.seat, 10);
  });
});

function updateSeatPicker(lobbyState) {
  lobbyState.seats.forEach((s, i) => {
    const nameEl = $(`seat-name-${i}`);
    const btn    = document.querySelector(`.seat-btn[data-seat="${i}"]`);
    if (!nameEl || !btn) return;

    if (s.taken) {
      nameEl.textContent = s.name;
      btn.classList.add('seat-taken');
      btn.classList.remove('seat-selected');
      if (selectedSeat === i) selectedSeat = null; // seat taken by someone else
    } else {
      nameEl.textContent = 'Empty';
      btn.classList.remove('seat-taken');
    }
  });

  const filled  = lobbyState.seats.filter(s => s.taken).length;
  const statusEl = $('lobby-status');
  if (statusEl) {
    statusEl.textContent = filled === 4
      ? 'All seats filled — starting soon!'
      : `${filled}/4 players seated. Pick a seat to join.`;
  }
}

function doJoin() {
  const name = $('name-input').value.trim();
  if (!name) { showLobbyError('Enter your name first.'); return; }
  if (selectedSeat === null) { showLobbyError('Click a seat to choose where you sit.'); return; }
  sessionStorage.setItem('af_name', name);
  socket.emit('join', { name, seat: selectedSeat });
}

function showLobbyError(msg) {
  const el = $('lobby-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

function showScreen(which) {
  $('screen-lobby').classList.toggle('hidden', which !== 'lobby');
  $('screen-game').classList.toggle('hidden', which !== 'game');
}

// ── Main Render ───────────────────────────────────────────────────────────────
function render(s) {
  renderScores(s);
  renderTrump(s);
  renderStatus(s);
  renderPlayers(s);
  renderTrick(s);
  renderHand(s);
  renderActions(s);
  renderHandResult(s);
}

// ── Scores ────────────────────────────────────────────────────────────────────
function renderScores(s) {
  const names = s.teamNames || ['Team A', 'Team B'];
  $('score-label-a').textContent = esc(names[0]);
  $('score-label-b').textContent = esc(names[1]);
  $('score-a').textContent = s.teamScores[0];
  $('score-b').textContent = s.teamScores[1];
  $('score-team-a').classList.toggle('my-team', s.myTeam === 0);
  $('score-team-b').classList.toggle('my-team', s.myTeam === 1);
}

// ── Trump Indicator ───────────────────────────────────────────────────────────
function renderTrump(s) {
  const el = $('trump-card');
  if (s.trump) {
    el.textContent = sym(s.trump);
    el.className   = red(s.trump) ? 'red' : '';
  } else if (s.trumpCard) {
    el.textContent = `${s.trumpCard.rank}${sym(s.trumpCard.suit)}?`;
    el.className   = `proposed${red(s.trumpCard.suit) ? ' red' : ''}`;
  } else {
    el.textContent = '–';
    el.className   = '';
  }
}

// ── Status Bar ────────────────────────────────────────────────────────────────
function renderStatus(s) {
  $('status-msg').textContent = s.message;
}

// ── Player Positions ──────────────────────────────────────────────────────────
function renderPlayers(s) {
  // Other players (top / left / right)
  for (const p of s.players) {
    if (p.seat === s.mySeat) continue;
    const pos = relPos(s.mySeat, p.seat);
    const el  = $(`pos-${pos}`);
    if (!el) continue;

    const active = s.currentTurn === p.seat;
    const tl     = teamLetter(p.seat);

    el.innerHTML = `
      <div class="player-info ${active ? 'active-player' : ''} ${!p.connected ? 'disconnected' : ''}">
        <span class="player-name">${esc(p.name)}${p.isDealer ? ' 🃏' : ''}</span>
        <span class="team-tag team-${tl.toLowerCase()}">${teamName(p.seat, s)}</span>
      </div>
      <div class="cards-back-row">
        ${'<div class="card-back-sm"></div>'.repeat(Math.min(p.cardCount, 9))}
      </div>`;
  }

  // Me (bottom label)
  const me = s.players.find(p => p.seat === s.mySeat);
  if (me) {
    const active = s.currentTurn === s.mySeat;
    const tl     = teamLetter(s.mySeat);
    $('me-info').innerHTML = `
      <div class="player-info ${active ? 'active-player' : ''}">
        <span class="player-name">${esc(me.name)}${me.isDealer ? ' 🃏' : ''} (you)</span>
        <span class="team-tag team-${tl.toLowerCase()}">${teamName(s.mySeat, s)}</span>
      </div>`;
  }
}

// ── Trick Area ────────────────────────────────────────────────────────────────
function renderTrick(s) {
  const area = $('trick-area');
  area.innerHTML = '';

  // During begging: show the proposed trump card in centre
  if (s.trumpCard && !s.trump && s.trick.length === 0) {
    area.innerHTML = `
      <div id="trump-proposal">
        <div id="trump-proposal-label">Proposed trump</div>
        ${makeCard(s.trumpCard)}
      </div>`;
    return;
  }

  // Show cards played so far in this trick
  for (const { seat, card } of s.trick) {
    const pos = relPos(s.mySeat, seat);
    const div = document.createElement('div');
    div.className = `trick-slot trick-${pos}`;
    div.innerHTML = makeCard(card);
    area.appendChild(div);
  }
}

// ── My Hand ───────────────────────────────────────────────────────────────────
function renderHand(s) {
  const handEl  = $('my-hand');
  const msgEl   = $('hand-hidden-msg');
  handEl.innerHTML = '';
  if (msgEl) msgEl.remove(); // clear any previous message

  const me = s.players?.find(p => p.seat === s.mySeat);
  if (!me) return;

  // During begging, non-active players (not dealer, not bagger) cannot see their cards
  if (me.handHidden) {
    const count = me.cardCount || 6;
    for (let i = 0; i < count; i++) {
      const div = document.createElement('div');
      div.className = 'card-face-down';
      handEl.appendChild(div);
    }
    // Informational message below the hand
    const msg = document.createElement('div');
    msg.id = 'hand-hidden-msg';
    msg.innerHTML = '🔒 Cards hidden — waiting for trump to be decided';
    $('hand-area').appendChild(msg);
    return;
  }

  if (!me.hand || me.hand.length === 0) return;

  const isMyTurn = s.phase === 'playing' && s.currentTurn === s.mySeat;

  // Sort: by suit order, then rank ascending
  const sorted = [...me.hand].sort((a, b) => {
    const sd = SUIT_ORD[a.suit] - SUIT_ORD[b.suit];
    return sd !== 0 ? sd : (RANK_VAL[a.rank] || 0) - (RANK_VAL[b.rank] || 0);
  });

  for (const card of sorted) {
    const div = document.createElement('div');
    div.className = `card${red(card.suit) ? ' red' : ''}${isMyTurn ? ' clickable' : ''}`;
    div.innerHTML = `<span class="card-rank">${card.rank}</span><span class="card-suit">${sym(card.suit)}</span>`;
    if (isMyTurn) {
      div.addEventListener('click', () => socket.emit('play_card', { rank: card.rank, suit: card.suit }));
    }
    handEl.appendChild(div);
  }
}

// ── Action Buttons ────────────────────────────────────────────────────────────
function renderActions(s) {
  const el     = $('actions');
  const isMe   = s.currentTurn === s.mySeat;
  el.innerHTML = '';

  if (s.phase === 'begging' && s.begPhase === 'nondeal' && isMe) {
    el.innerHTML = `
      <span class="action-prompt">Accept <strong>${s.trumpCard?.rank}${sym(s.trumpCard?.suit)}</strong> as trump?</span>
      <button class="btn-green"  onclick="socket.emit('stand')">Stand</button>
      <button class="btn-red"    onclick="socket.emit('beg')">Beg</button>`;

  } else if (s.phase === 'begging' && s.begPhase === 'dealer' && isMe) {
    el.innerHTML = `
      <span class="action-prompt">Opponent begged!</span>
      <button class="btn-yellow" onclick="socket.emit('take_it_up')">Take It Up (+1 to them)</button>
      <button class="btn-blue"   onclick="socket.emit('give_gift')">Give a Gift</button>`;

  } else if (s.phase === 'playing' && isMe) {
    el.innerHTML = `<span class="action-prompt">Your turn — tap a card to play</span>`;

  } else if (s.phase === 'game_over') {
    el.innerHTML = `<button class="btn-green" onclick="socket.emit('rematch')">Play Again</button>`;
  }
}

// ── Hand Result Overlay ───────────────────────────────────────────────────────
function renderHandResult(s) {
  const overlay = $('hand-result');

  if (!s.handResult || s.phase === 'playing') {
    overlay.classList.add('hidden');
    return;
  }

  overlay.classList.remove('hidden');
  const r = s.handResult;

  $('result-breakdown').innerHTML = r.breakdown.map(b => `
    <div class="result-row">
      <span class="result-name">${b.name}</span>
      <span class="result-winner">${esc(b.winner)}</span>
    </div>`).join('');

  const gameOver = s.phase === 'game_over';
  const n = s.teamNames || ['Team A', 'Team B'];
  $('result-scores').innerHTML = `
    ${gameOver ? `<div class="game-over-banner">🎉 ${esc(s.message)}</div>` : ''}
    <div>${esc(n[0])}: <strong>${s.teamScores[0]}</strong> pts &nbsp;|&nbsp; ${esc(n[1])}: <strong>${s.teamScores[1]}</strong> pts</div>
    ${r.cardPts ? `<div style="font-size:.78rem;margin-top:.3rem;opacity:.7">Card pts — ${esc(n[0])}: ${r.cardPts[0]}, ${esc(n[1])}: ${r.cardPts[1]}</div>` : ''}
  `;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeCard(card) {
  return `<div class="card${red(card.suit) ? ' red' : ''}">
    <span class="card-rank">${card.rank}</span>
    <span class="card-suit">${sym(card.suit)}</span>
  </div>`;
}

// Basic HTML-escape to prevent XSS from player names
function esc(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showError(msg) {
  const el = $('game-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}
