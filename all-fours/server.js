'use strict';

const express        = require('express');
const http           = require('http');
const { Server }     = require('socket.io');
const path           = require('path');
const { networkInterfaces } = require('os');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ── Constants ─────────────────────────────────────────────────────────────────
const SUITS    = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANKS    = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VAL = Object.fromEntries(RANKS.map((r, i) => [r, i]));
const CARD_PTS = { A: 4, K: 3, Q: 2, J: 1, '10': 10 };
const SYM      = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' };

// ── Game State ────────────────────────────────────────────────────────────────
let G = newGame();

function newGame() {
  return {
    // Phases: lobby | begging | playing | hand_end | game_over
    phase        : 'lobby',
    // Begging sub-phase: nondeal | dealer | gifting
    begPhase     : null,
    players      : [],   // [{ socketId, name, seat, hand, connected }]
    dealer       : 0,
    deck         : [],
    trumpCard    : null, // the face-up proposed trump card
    origTrumpSuit: null, // suit of first proposed card (gift comparison)
    trump        : null, // confirmed trump suit (null until stand/take-it-up)
    trick        : [],   // [{ seat, card }] — current trick in progress
    trickLeader  : null,
    tricks       : [],   // completed tricks: [{ winner, cards }]
    teamScores   : [0, 0],
    teamNames    : ['Team A', 'Team B'],
    highTrump    : null, // { seat, card } — highest trump dealt
    lowTrump     : null, // { seat, card } — lowest trump dealt
    jackWinner   : null, // seat that wins the jack-of-trumps trick
    currentTurn  : null,
    message      : 'Waiting for players to join...',
    handResult   : null,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const team     = s => s % 2;              // seats 0,2 → team 0; seats 1,3 → team 1
const nextSeat = s => (s + 1) % 4;
const ndSeat   = () => (G.dealer + 3) % 4; // bagger: player to the RIGHT of dealer (always other team)
const bySeat   = s  => G.players.find(p => p.seat === s);
const byId     = id => G.players.find(p => p.socketId === id);

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function mkDeck() {
  return SUITS.flatMap(s => RANKS.map(r => ({ suit: s, rank: r })));
}

function cmpRank(a, b) {
  return RANK_VAL[a.rank] - RANK_VAL[b.rank];
}

// Build state visible to one seat (hides opponents' cards)
function viewFor(seat) {
  // During begging, only the dealer and the right-hand player (bagger) can see their cards
  const canSeeHand = G.phase !== 'begging' || seat === G.dealer || seat === ndSeat();

  return {
    phase      : G.phase,
    begPhase   : G.begPhase,
    dealer     : G.dealer,
    baggerSeat : ndSeat(),
    trump      : G.trump,
    trumpCard  : G.trumpCard,
    trick      : G.trick,
    trickLeader: G.trickLeader,
    teamScores : G.teamScores,
    teamNames  : G.teamNames,
    currentTurn: G.currentTurn,
    message    : G.message,
    handResult : G.handResult,
    highTrump  : G.highTrump,
    lowTrump   : G.lowTrump,
    mySeat     : seat,
    myTeam     : team(seat),
    players: G.players.map(p => ({
      name       : p.name,
      seat       : p.seat,
      connected  : p.connected,
      cardCount  : p.hand.length,
      isDealer   : p.seat === G.dealer,
      isBagger   : p.seat === ndSeat(),
      // Only send your own hand, and only when you're allowed to see it
      hand       : p.seat === seat ? (canSeeHand ? p.hand : []) : null,
      handHidden : p.seat === seat && !canSeeHand,
    })),
  };
}

// Broadcast lobby state to ALL connected sockets (including visitors not yet in-game)
function broadcastLobby() {
  const lobbyState = {
    seats: [0, 1, 2, 3].map(s => {
      const p = bySeat(s);
      return p ? { taken: true, name: p.name } : { taken: false };
    }),
    teamNames: G.teamNames,
    phase: G.phase,
  };
  io.emit('lobby', lobbyState);
}

function broadcast() {
  for (const p of G.players) {
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) sock.emit('state', viewFor(p.seat));
  }
}

// ── Game Flow ─────────────────────────────────────────────────────────────────

function startHand() {
  // Reset per-hand state
  G.deck = shuffle(mkDeck());
  G.trumpCard = G.origTrumpSuit = G.trump = null;
  G.trick = [];
  G.trickLeader = null;
  G.tricks = [];
  G.highTrump = G.lowTrump = G.jackWinner = G.handResult = null;
  for (const p of G.players) p.hand = [];

  // Deal 6 cards each (3 at a time, 2 rounds) starting left of dealer
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 4; i++) {
      const p = bySeat((G.dealer + 1 + i) % 4);
      for (let c = 0; c < 3; c++) p.hand.push(G.deck.pop());
    }
  }

  // Turn up proposed trump card
  G.trumpCard     = G.deck.pop();
  G.origTrumpSuit = G.trumpCard.suit;
  G.phase         = 'begging';
  G.begPhase      = 'nondeal';
  G.currentTurn   = ndSeat();

  G.message = `${bySeat(G.dealer).name} deals. Proposed trump: ${SYM[G.trumpCard.suit]} ${G.trumpCard.suit}. ` +
              `${bySeat(ndSeat()).name} (right of dealer): Play or Beg?`;
  broadcast();
}

// Scan all hands for highest/lowest trump once trump is confirmed
function setHighLow() {
  let hi = null, lo = null;
  for (const p of G.players) {
    for (const c of p.hand) {
      if (c.suit !== G.trump) continue;
      if (!hi || cmpRank(c, hi.card) > 0) hi = { seat: p.seat, card: c };
      if (!lo || cmpRank(c, lo.card)  < 0) lo = { seat: p.seat, card: c };
    }
  }
  G.highTrump = hi;
  G.lowTrump  = lo;
}

function startPlay() {
  setHighLow();
  G.phase       = 'playing';
  G.begPhase    = null;
  G.trick       = [];
  G.trickLeader = ndSeat();
  G.currentTurn = ndSeat();
  G.message     = `Trump: ${SYM[G.trump]} ${G.trump}. ${bySeat(ndSeat()).name} leads the first trick.`;
  broadcast();
}

// Deal 3 more cards each and turn a new trump card (gift phase)
function doGift() {
  for (let i = 0; i < 4; i++) {
    const p = bySeat((G.dealer + 1 + i) % 4);
    for (let c = 0; c < 3; c++) {
      if (!G.deck.length) { redeal(); return; }
      p.hand.push(G.deck.pop());
    }
  }
  if (!G.deck.length) { redeal(); return; }

  G.trumpCard = G.deck.pop();

  if (G.trumpCard.suit === G.origTrumpSuit) {
    // Same suit as what was originally begged — auto-gift again
    G.message = `New card: ${G.trumpCard.rank}${SYM[G.trumpCard.suit]} — same suit! Auto-gifting again...`;
    broadcast();
    setTimeout(doGift, 1400);
  } else {
    G.trump   = G.trumpCard.suit;
    G.message = `New trump: ${SYM[G.trump]} ${G.trump}!`;
    broadcast();
    setTimeout(startPlay, 900);
  }
}

function redeal() {
  G.message = 'Deck ran out during gifting — redealing...';
  broadcast();
  setTimeout(startHand, 1500);
}

// Determine winner of the current trick
function evalTrick() {
  const trick   = G.trick;
  const ledSuit = trick[0].card.suit;
  let winner    = trick[0];

  for (let i = 1; i < trick.length; i++) {
    const e      = trick[i];
    const wTrump = winner.card.suit === G.trump;
    const eTrump = e.card.suit      === G.trump;

    if (eTrump && !wTrump)                                           { winner = e; continue; }
    if (eTrump && wTrump  && cmpRank(e.card, winner.card) > 0)      { winner = e; continue; }
    if (!eTrump && !wTrump && e.card.suit === ledSuit
        && cmpRank(e.card, winner.card) > 0)                         { winner = e; }
  }

  // Jack of trumps played in this trick? Winner of trick wins the Jack point.
  for (const { card } of trick) {
    if (card.suit === G.trump && card.rank === 'J') {
      G.jackWinner = winner.seat;
    }
  }

  G.tricks.push({ winner: winner.seat, cards: [...trick] });
  G.trick       = [];
  G.trickLeader = winner.seat;
  G.currentTurn = winner.seat;
  return winner.seat;
}

// Sum card-point values per team from all won tricks
function teamCardPts() {
  const pts = [0, 0, 0, 0];
  for (const { winner, cards } of G.tricks)
    for (const { card } of cards)
      pts[winner] += CARD_PTS[card.rank] || 0;
  return [pts[0] + pts[2], pts[1] + pts[3]];
}

function endHand() {
  G.phase = 'hand_end';
  const res = { points: [0, 0], breakdown: [] };

  // Award High — holder of highest trump dealt
  if (G.highTrump) {
    const t = team(G.highTrump.seat);
    res.points[t]++;
    res.breakdown.push({ name: 'High', winner: bySeat(G.highTrump.seat).name, team: t });
  }

  // Award Low — holder of lowest trump dealt
  if (G.lowTrump) {
    const t = team(G.lowTrump.seat);
    res.points[t]++;
    res.breakdown.push({ name: 'Low', winner: bySeat(G.lowTrump.seat).name, team: t });
  }

  // Award Jack — winner of the trick containing the Jack of trumps
  if (G.jackWinner !== null) {
    const t = team(G.jackWinner);
    res.points[t]++;
    res.breakdown.push({ name: 'Jack', winner: bySeat(G.jackWinner).name, team: t });
  } else {
    res.breakdown.push({ name: 'Jack', winner: 'Not in play', team: null });
  }

  // Award Game — team with most card-point value in won tricks
  const [tA, tB] = teamCardPts();
  if (tA === tB) {
    res.breakdown.push({ name: 'Game', winner: `Tied (${tA}–${tB}) — no point`, team: null });
  } else {
    const t = tA > tB ? 0 : 1;
    res.points[t]++;
    res.breakdown.push({ name: 'Game', winner: `${G.teamNames[t]} (${Math.max(tA, tB)} card pts)`, team: t });
  }

  // Apply points to running totals
  G.teamScores[0] += res.points[0];
  G.teamScores[1] += res.points[1];
  G.handResult     = { ...res, cardPts: [tA, tB] };

  // Check win condition (pegging order already applied above)
  const won = G.teamScores[0] >= 11 ? 0 : G.teamScores[1] >= 11 ? 1 : -1;
  if (won >= 0) {
    G.phase   = 'game_over';
    G.message = `${G.teamNames[won]} wins the game!`;
    broadcast();
    return;
  }

  G.message = `Hand over! +${res.points[0]} ${G.teamNames[0]}, +${res.points[1]} ${G.teamNames[1]}. Next hand in 5s...`;
  broadcast();
  setTimeout(() => { G.dealer = nextSeat(G.dealer); startHand(); }, 5000);
}

// ── Socket.io Events ──────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);
  // Send current lobby state so visitor can see which seats are taken
  broadcastLobby();

  socket.on('join', ({ name, seat }) => {
    if (typeof name !== 'string') return;
    name = name.trim().slice(0, 20);
    if (!name) return;

    // Allow reconnection by matching name to a disconnected player
    const existing = G.players.find(p => p.name === name && !p.connected);
    if (existing) {
      existing.socketId  = socket.id;
      existing.connected = true;
      socket.emit('state', viewFor(existing.seat));
      broadcast();
      broadcastLobby();
      return;
    }

    if (G.phase !== 'lobby') return socket.emit('err', 'Game already in progress.');
    if (G.players.length >= 4) return socket.emit('err', 'Game is full (4/4).');

    // Validate chosen seat (seat -1 was a reconnect attempt that didn't match above)
    if (typeof seat !== 'number' || seat < 0 || seat > 3 || !Number.isInteger(seat))
      return socket.emit('err', 'Pick a seat to join.');
    if (G.players.find(p => p.seat === seat))
      return socket.emit('err', 'That seat is already taken.');

    G.players.push({ socketId: socket.id, name, seat, hand: [], connected: true });
    G.message = `${name} took seat ${seat + 1}! (${G.players.length}/4)`;
    broadcast();
    broadcastLobby();

    if (G.players.length === 4) setTimeout(startHand, 1500);
  });

  // Non-dealer accepts proposed trump
  socket.on('stand', () => {
    const p = byId(socket.id);
    if (!p || G.phase !== 'begging' || G.begPhase !== 'nondeal' || G.currentTurn !== p.seat) return;
    G.trump   = G.trumpCard.suit;
    G.message = `${p.name} stands. Trump: ${SYM[G.trump]} ${G.trump}.`;
    broadcast();
    setTimeout(startPlay, 800);
  });

  // Non-dealer rejects proposed trump
  socket.on('beg', () => {
    const p = byId(socket.id);
    if (!p || G.phase !== 'begging' || G.begPhase !== 'nondeal' || G.currentTurn !== p.seat) return;
    G.begPhase    = 'dealer';
    G.currentTurn = G.dealer;
    G.message     = `${p.name} begs! ${bySeat(G.dealer).name}: Take It Up or Give a Gift?`;
    broadcast();
  });

  // Dealer keeps proposed trump, gifts 1 point to non-dealer's team
  socket.on('take_it_up', () => {
    const p = byId(socket.id);
    if (!p || G.phase !== 'begging' || G.begPhase !== 'dealer' || p.seat !== G.dealer) return;
    G.trump = G.trumpCard.suit;
    const t = team(ndSeat());
    G.teamScores[t]++;
    // Instant win from gift point?
    if (G.teamScores[t] >= 11) {
      G.phase   = 'game_over';
      G.message = `${G.teamNames[t]} wins from the gift point!`;
      broadcast();
      return;
    }
    G.message = `${p.name} takes it up! Trump: ${SYM[G.trump]}. ${G.teamNames[t]} +1 (gift).`;
    broadcast();
    setTimeout(startPlay, 1000);
  });

  // Dealer deals 3 more cards and turns new trump card
  socket.on('give_gift', () => {
    const p = byId(socket.id);
    if (!p || G.phase !== 'begging' || G.begPhase !== 'dealer' || p.seat !== G.dealer) return;
    G.begPhase = 'gifting';
    G.message  = `${p.name} gives a gift — dealing 3 more cards each...`;
    broadcast();
    setTimeout(doGift, 800);
  });

  // Player plays a card in a trick
  socket.on('play_card', ({ rank, suit }) => {
    const p = byId(socket.id);
    if (!p || G.phase !== 'playing' || G.currentTurn !== p.seat) return;

    const idx = p.hand.findIndex(c => c.rank === rank && c.suit === suit);
    if (idx === -1) return;

    // Validate: must follow suit if possible; trump is always legal
    if (G.trick.length > 0) {
      const ledSuit  = G.trick[0].card.suit;
      const canFollow = p.hand.some(c => c.suit === ledSuit);
      if (canFollow && suit !== ledSuit && suit !== G.trump) {
        socket.emit('err', `Must follow suit (${ledSuit}) or play trump.`);
        return;
      }
    }

    const card = p.hand.splice(idx, 1)[0];
    G.trick.push({ seat: p.seat, card });
    broadcast();

    if (G.trick.length === 4) {
      const winSeat = evalTrick();
      G.message = `${bySeat(winSeat).name} wins the trick! (${G.tricks.length}/6)`;
      broadcast();
      if (G.tricks.length === 6) {
        setTimeout(endHand, 1200);
      }
    } else {
      G.currentTurn = nextSeat(p.seat);
      broadcast();
    }
  });

  // Update a team name (lobby only)
  socket.on('set_team_name', ({ team: t, name }) => {
    if (G.phase !== 'lobby') return;
    if (t !== 0 && t !== 1) return;
    if (typeof name !== 'string') return;
    name = name.trim().slice(0, 20) || (t === 0 ? 'Team A' : 'Team B');
    G.teamNames[t] = name;
    broadcastLobby();
    broadcast(); // update any in-game views (none yet, but safe)
  });

  // Restart the game with the same players and team names
  socket.on('rematch', () => {
    if (G.phase !== 'game_over') return;
    const players   = G.players.map(p => ({ ...p, hand: [], connected: p.connected }));
    const teamNames = [...G.teamNames]; // preserve custom names
    G               = newGame();
    G.players       = players;
    G.teamNames     = teamNames;
    G.message       = 'New game! Starting...';
    broadcast();
    setTimeout(startHand, 1500);
  });

  socket.on('disconnect', () => {
    const p = byId(socket.id);
    if (p) {
      p.connected = false;
      G.message   = `${p.name} disconnected.`;
      broadcast();
      broadcastLobby();
    }
    console.log(`[-] ${socket.id}`);
  });
});

// ── Start Server ──────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  // Print local network IP so other devices know where to connect
  let localIP = 'localhost';
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) localIP = iface.address;
    }
  }
  console.log(`\n  ♠ All Fours running!\n`);
  console.log(`  Local   → http://localhost:${PORT}`);
  console.log(`  Network → http://${localIP}:${PORT}  ← share this with other players\n`);
});
