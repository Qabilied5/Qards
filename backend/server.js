const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, '..')));

// ─── Game Constants ───────────────────────────────────────────────────────────
const STARTING_HAND = 5;
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS = ['♠','♥','♦','♣'];
const SUIT_ORDER = { '♣': 1, '♦': 2, '♥': 3, '♠': 4, '🃏': 5 };

function rankToValue(rank) {
  if (rank === 'J') return 11;
  if (rank === 'Q') return 12;
  if (rank === 'K') return 13;
  if (rank === 'A') return 14;
  return parseInt(rank, 10);
}

function createDeck() {
  const deck = [];
  RANKS.forEach(rank => {
    SUITS.forEach(suit => {
      deck.push({
        id: `${rank}${suit}`,
        name: `${rank}${suit}`,
        rank,
        suit,
        value: rankToValue(rank),
        type: 'standard'
      });
    });
  });
  deck.push({ id: 'JOKER1', name: 'Joker 🃏', rank: 'JK', suit: '🃏', value: 15, type: 'joker' });
  deck.push({ id: 'JOKER2', name: 'Joker 🃏', rank: 'JK', suit: '🃏', value: 15, type: 'joker' });
  return shuffle(deck);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function drawCards(deck, hand, n = 1) {
  for (let i = 0; i < n; i++) {
    if (deck.length === 0) deck.push(...createDeck());
    hand.push(deck.shift());
  }
}

// ─── Room Management ──────────────────────────────────────────────────────────
const rooms = {};
const playerRoom = {};

function createRoom(roomId) {
  const deck = createDeck();
  const hand1 = [];
  const hand2 = [];
  drawCards(deck, hand1, STARTING_HAND);
  drawCards(deck, hand2, STARTING_HAND);

  return {
    id: roomId,
    players: [],
    names: {},
    hands: {},
    deck,
    scores: {},
    currentTrick: {},
    lastTrick: null,
    turn: null,
    round: 1,
    phase: 'waiting',
    log: []
  };
}

function getOpponent(room, socketId) {
  return room.players.find(p => p !== socketId);
}

function addLog(room, msg) {
  room.log.unshift({ msg, time: Date.now() });
  if (room.log.length > 20) room.log.pop();
}

function gameState(room, forPlayer) {
  const opp = getOpponent(room, forPlayer);
  return {
    myId: forPlayer,
    oppId: opp,
    myName: room.names[forPlayer],
    oppName: opp ? room.names[opp] : 'Menunggu...',
    myScore: room.scores[forPlayer] || 0,
    oppScore: opp ? room.scores[opp] || 0 : 0,
    myHand: room.hands[forPlayer],
    oppHandCount: opp ? room.hands[opp].length : 0,
    turn: room.turn,
    round: room.round,
    phase: room.phase,
    myPlayedCard: room.currentTrick[forPlayer],
    oppPlayedCard: opp ? room.currentTrick[opp] : null,
    lastTrick: room.lastTrick
      ? {
          ...room.lastTrick,
          winnerName: room.lastTrick.winner ? room.names[room.lastTrick.winner] : null
        }
      : null,
    deckCount: room.deck.length,
    log: room.log
  };
}

function broadcastState(room) {
  room.players.forEach(pid => {
    io.to(pid).emit('gameState', gameState(room, pid));
  });
}

function finishGame(room) {
  room.phase = 'gameover';
  const [first, second] = room.players;
  const score1 = room.scores[first] || 0;
  const score2 = room.scores[second] || 0;
  let winner = null;

  if (score1 > score2) winner = first;
  else if (score2 > score1) winner = second;

  if (winner) {
    const loser = getOpponent(room, winner);
    addLog(room, `🏆 ${room.names[winner]} menang permainan dengan skor ${room.scores[winner]}:${room.scores[loser]}!`);
    room.players.forEach(pid => {
      io.to(pid).emit('gameOver', {
        winner,
        winnerName: room.names[winner],
        loserName: room.names[loser],
        isWinner: pid === winner,
        draw: false
      });
    });
  } else {
    addLog(room, `🤝 Permainan berakhir seri ${score1}:${score2}.`);
    room.players.forEach(pid => {
      io.to(pid).emit('gameOver', {
        draw: true,
        message: `Permainan berakhir seri ${score1}:${score2}.`
      });
    });
  }
}

function resolveTrick(room) {
  const [first, second] = room.players;
  const card1 = room.currentTrick[first];
  const card2 = room.currentTrick[second];
  let winner = null;
  let resultMsg = '';

  if (card1.value > card2.value) winner = first;
  else if (card2.value > card1.value) winner = second;
  else {
    if (card1.value === 15 && card2.value === 15) {
      winner = null;
    } else {
      if (SUIT_ORDER[card1.suit] > SUIT_ORDER[card2.suit]) winner = first;
      else if (SUIT_ORDER[card2.suit] > SUIT_ORDER[card1.suit]) winner = second;
      else winner = null;
    }
  }

  if (winner) {
    room.scores[winner] = (room.scores[winner] || 0) + 1;
    const winningCard = winner === first ? card1 : card2;
    resultMsg = `🏆 ${room.names[winner]} menang trik dengan ${winningCard.name}!`;
  } else {
    resultMsg = `🤝 Trik seri antara ${room.names[first]} dan ${room.names[second]}!`;
  }

  room.lastTrick = { card1, card2, winner };
  room.currentTrick = {};
  room.round += 1;

  addLog(room, resultMsg);

  if (room.hands[first].length === 0 && room.hands[second].length === 0) {
    finishGame(room);
    return;
  }

  if (winner) {
    room.turn = winner;
  } else {
    room.turn = room.players[Math.random() < 0.5 ? 0 : 1];
  }

  broadcastState(room);
}

function resolveCard(room, playerId, card) {
  const opp = getOpponent(room, playerId);
  if (!opp) return;

  room.currentTrick[playerId] = card;
  addLog(room, `🃏 ${room.names[playerId]} memainkan ${card.name}`);

  if (!room.currentTrick[opp]) {
    broadcastState(room);
    return;
  }

  resolveTrick(room);
}

// ─── Socket Events ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('joinRoom', ({ roomId, playerName }) => {
    const name = (playerName || 'Player').trim().slice(0, 20);
    let room = rooms[roomId];

    if (!room) {
      room = createRoom(roomId);
      rooms[roomId] = room;
    }

    if (room.players.length >= 2) {
      socket.emit('roomFull');
      return;
    }

    if (room.players.includes(socket.id)) return;

    room.players.push(socket.id);
    room.names[socket.id] = name;
    room.scores[socket.id] = 0;
    room.hands[socket.id] = [];
    drawCards(room.deck, room.hands[socket.id], STARTING_HAND);

    playerRoom[socket.id] = roomId;
    socket.join(roomId);

    socket.emit('joined', { roomId, playerId: socket.id, playerName: name });

    if (room.players.length === 2) {
      room.phase = 'playing';
      room.turn = room.players[Math.random() < 0.5 ? 0 : 1];
      addLog(room, `🎮 Game dimulai! ${room.names[room.turn]} mulai duluan!`);
      broadcastState(room);
    } else {
      socket.emit('waiting', { msg: 'Menunggu pemain kedua...' });
    }
  });

  socket.on('playCard', ({ cardId }) => {
    const roomId = playerRoom[socket.id];
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room || room.phase !== 'playing') return;
    if (room.turn !== socket.id) {
      socket.emit('notYourTurn');
      return;
    }

    const hand = room.hands[socket.id];
    const cardIdx = hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1) {
      socket.emit('error', { msg: 'Kartu tidak ditemukan.' });
      return;
    }

    const card = hand.splice(cardIdx, 1)[0];
    resolveCard(room, socket.id, card);
  });

  socket.on('disconnect', () => {
    const roomId = playerRoom[socket.id];
    if (roomId) {
      const room = rooms[roomId];
      if (room) {
        addLog(room, `❌ ${room.names[socket.id] || 'Pemain'} keluar dari game.`);
        room.phase = 'gameover';
        const opp = getOpponent(room, socket.id);
        if (opp) {
          io.to(opp).emit('opponentLeft', { msg: 'Lawan keluar dari game. Kamu menang!' });
        }
        delete rooms[roomId];
      }
      delete playerRoom[socket.id];
    }
  });

  socket.on('rematch', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.players.length < 2) return;

    room.deck = createDeck();
    room.hands = {};
    room.scores = {};
    room.currentTrick = {};
    room.lastTrick = null;
    room.round = 1;
    room.phase = 'playing';
    room.log = [];

    room.players.forEach(pid => {
      room.scores[pid] = 0;
      room.hands[pid] = [];
      drawCards(room.deck, room.hands[pid], STARTING_HAND);
    });

    room.turn = room.players[Math.random() < 0.5 ? 0 : 1];
    addLog(room, `🔄 Rematch dimulai! ${room.names[room.turn]} mulai duluan!`);
    broadcastState(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 Card Battle server running on port ${PORT}`));