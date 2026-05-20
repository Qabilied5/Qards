const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Game Constants ───────────────────────────────────────────────────────────
const STARTING_COINS = 100;
const HAND_SIZE = 5;

const CARD_TYPES = [
  // Attack cards
  { id: 'slash',      name: 'Tebasan',     type: 'attack',  power: 15, cost: 10, desc: 'Serang musuh dengan tebasan pedang.' },
  { id: 'fireball',   name: 'Bola Api',    type: 'attack',  power: 25, cost: 18, desc: 'Lempar bola api ke musuh.' },
  { id: 'lightning',  name: 'Petir',       type: 'attack',  power: 35, cost: 25, desc: 'Hantam musuh dengan petir.' },
  { id: 'poison',     name: 'Racun',       type: 'attack',  power: 12, cost: 8,  desc: 'Racuni musuh, damage berkali-kali.' },
  { id: 'arrow',      name: 'Panah',       type: 'attack',  power: 18, cost: 12, desc: 'Tembak panah tepat sasaran.' },
  { id: 'bomb',       name: 'Bom',         type: 'attack',  power: 40, cost: 35, desc: 'Bom besar! Damage sangat tinggi.' },
  { id: 'punch',      name: 'Tinju',       type: 'attack',  power: 10, cost: 6,  desc: 'Pukulan cepat dan murah.' },
  { id: 'ice',        name: 'Es Beku',     type: 'attack',  power: 20, cost: 15, desc: 'Bekukan musuh dengan es.' },

  // Defense cards
  { id: 'shield',     name: 'Perisai',     type: 'defense', block: 20, cost: 12, desc: 'Blok serangan musuh.' },
  { id: 'dodge',      name: 'Menghindar',  type: 'defense', block: 30, cost: 18, desc: 'Hindari serangan sepenuhnya.' },
  { id: 'barrier',    name: 'Penghalang',  type: 'defense', block: 15, cost: 8,  desc: 'Buat penghalang magis.' },
  { id: 'fortify',    name: 'Benteng',     type: 'defense', block: 40, cost: 28, desc: 'Pertahanan maksimal.' },

  // Special cards
  { id: 'steal',      name: 'Mencuri',     type: 'special', effect: 'steal',   cost: 20, desc: 'Curi 15 koin dari musuh.' },
  { id: 'double',     name: 'Gandakan',    type: 'special', effect: 'double',  cost: 25, desc: 'Gandakan damage serangan berikutnya.' },
  { id: 'heal',       name: 'Pulihkan',    type: 'special', effect: 'heal',    cost: 15, desc: 'Pulihkan 20 koin.' },
  { id: 'mirror',     name: 'Cermin',      type: 'special', effect: 'mirror',  cost: 22, desc: 'Balikkan serangan musuh ke mereka.' },
  { id: 'gamble',     name: 'Judi',        type: 'special', effect: 'gamble',  cost: 0,  desc: 'Taruh semua untuk peluang besar!' },
];

function createDeck() {
  const deck = [];
  for (let i = 0; i < 4; i++) {
    CARD_TYPES.forEach(c => deck.push({ ...c }));
  }
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
  const deck1 = createDeck();
  const deck2 = createDeck();
  const hand1 = [], hand2 = [];
  drawCards(deck1, hand1, HAND_SIZE);
  drawCards(deck2, hand2, HAND_SIZE);

  return {
    id: roomId,
    players: [],          // [socketId, socketId]
    names: {},            // socketId -> name
    coins: {},            // socketId -> amount
    hands: {},            // socketId -> cards[]
    decks: {},            // socketId -> deck[]
    pendingAttack: {},    // socketId -> power
    doubleNext: {},       // socketId -> bool
    mirrorActive: {},     // socketId -> bool
    turn: null,           // socketId whose turn it is
    round: 0,
    phase: 'waiting',     // waiting | playing | gameover
    playedCard: {},       // last played card per player
    betAmount: {},        // bet per player this round
    roundBet: 0,          // total bet in the pot this round
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
    oppName: room.names[opp],
    myCoins: room.coins[forPlayer],
    oppCoins: room.coins[opp],
    myHand: room.hands[forPlayer],
    oppHandCount: opp ? room.hands[opp].length : 0,
    turn: room.turn,
    round: room.round,
    phase: room.phase,
    myPlayedCard: room.playedCard[forPlayer],
    oppPlayedCard: room.playedCard[opp],
    doubleActive: room.doubleNext[forPlayer],
    mirrorActive: room.mirrorActive[forPlayer],
    roundBet: room.roundBet,
    log: room.log
  };
}

function broadcastState(room) {
  room.players.forEach(pid => {
    io.to(pid).emit('gameState', gameState(room, pid));
  });
}

function endGame(room, winnerId) {
  room.phase = 'gameover';
  const loserId = getOpponent(room, winnerId);
  addLog(room, `🏆 ${room.names[winnerId]} MENANG! ${room.names[loserId]} kehabisan koin!`);
  room.players.forEach(pid => {
    io.to(pid).emit('gameOver', {
      winner: winnerId,
      winnerName: room.names[winnerId],
      loserName: room.names[loserId],
      isWinner: pid === winnerId
    });
  });
}

function resolveCard(room, playerId, card, betAmt) {
  const opp = getOpponent(room, playerId);
  if (!opp) return;

  let resultMsg = '';

  // Deduct bet first
  room.coins[playerId] = Math.max(0, room.coins[playerId] - betAmt);
  room.coins[opp] = Math.max(0, room.coins[opp] - betAmt);
  room.roundBet += betAmt * 2;

  if (card.type === 'attack') {
    let dmg = card.power;
    if (room.doubleNext[playerId]) { dmg *= 2; room.doubleNext[playerId] = false; }

    if (room.mirrorActive[opp]) {
      // Mirror: reflect damage back to attacker
      room.coins[playerId] = Math.max(0, room.coins[playerId] - dmg);
      room.mirrorActive[opp] = false;
      resultMsg = `🪞 ${room.names[opp]} memantulkan serangan! ${room.names[playerId]} kena ${dmg} damage!`;
    } else {
      room.pendingAttack[opp] = (room.pendingAttack[opp] || 0) + dmg;
      resultMsg = `⚔️ ${room.names[playerId]} menyerang dengan ${card.name} (${dmg} power)!`;
    }

  } else if (card.type === 'defense') {
    const incoming = room.pendingAttack[playerId] || 0;
    const blocked = Math.min(incoming, card.block);
    const remaining = incoming - blocked;
    room.coins[playerId] = Math.max(0, room.coins[playerId] - remaining);
    room.pendingAttack[playerId] = 0;

    // Winner of round gets the pot
    if (blocked >= incoming && incoming > 0) {
      room.coins[playerId] += room.roundBet;
      resultMsg = `🛡️ ${room.names[playerId]} memblok serangan! Menang ronde, dapat ${room.roundBet} koin!`;
      room.roundBet = 0;
    } else {
      resultMsg = `🛡️ ${room.names[playerId]} memblok ${blocked} dari ${incoming} damage. Sisa ${remaining} kena!`;
    }

  } else if (card.type === 'special') {
    switch (card.effect) {
      case 'steal':
        const stolen = Math.min(15, room.coins[opp]);
        room.coins[opp] -= stolen;
        room.coins[playerId] += stolen;
        resultMsg = `💰 ${room.names[playerId]} mencuri ${stolen} koin dari ${room.names[opp]}!`;
        break;
      case 'double':
        room.doubleNext[playerId] = true;
        resultMsg = `✨ ${room.names[playerId]} mengaktifkan Gandakan! Serangan berikutnya 2x!`;
        break;
      case 'heal':
        room.coins[playerId] += 20;
        resultMsg = `💚 ${room.names[playerId]} memulihkan 20 koin!`;
        break;
      case 'mirror':
        room.mirrorActive[playerId] = true;
        resultMsg = `🪞 ${room.names[playerId]} siap memantulkan serangan berikutnya!`;
        break;
      case 'gamble':
        const roll = Math.random();
        if (roll > 0.45) {
          const pot = Math.floor(room.coins[opp] * 0.3);
          room.coins[opp] -= pot;
          room.coins[playerId] += pot;
          resultMsg = `🎲 JUDI BERHASIL! ${room.names[playerId]} menang ${pot} koin dari ${room.names[opp]}!`;
        } else {
          const lose = Math.floor(room.coins[playerId] * 0.3);
          room.coins[playerId] -= lose;
          room.coins[opp] += lose;
          resultMsg = `🎲 JUDI GAGAL! ${room.names[playerId]} kehilangan ${lose} koin!`;
        }
        break;
    }
  }

  // Apply unblocked attack at end of turn if no defense played
  if (card.type !== 'defense' && room.pendingAttack[opp]) {
    // Attack waits for next turn's defense
  }

  addLog(room, resultMsg);
  room.playedCard[playerId] = card;

  // Draw a new card
  drawCards(room.decks[playerId], room.hands[playerId], 1);

  // Check for game over
  const coins1 = room.coins[room.players[0]];
  const coins2 = room.coins[room.players[1]];

  if (coins1 <= 0 && coins2 <= 0) {
    addLog(room, '💀 Dua-duanya bangkrut! Seri!');
    room.phase = 'gameover';
    room.players.forEach(pid => io.to(pid).emit('gameOver', { draw: true }));
    return;
  }
  if (coins1 <= 0) return endGame(room, room.players[1]);
  if (coins2 <= 0) return endGame(room, room.players[0]);

  // Switch turn
  room.turn = opp;
  room.round++;

  broadcastState(room);
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
    room.coins[socket.id] = STARTING_COINS;
    room.hands[socket.id] = [];
    room.decks[socket.id] = createDeck();
    room.doubleNext[socket.id] = false;
    room.mirrorActive[socket.id] = false;
    room.pendingAttack[socket.id] = 0;
    room.betAmount[socket.id] = 0;
    drawCards(room.decks[socket.id], room.hands[socket.id], HAND_SIZE);

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

  socket.on('playCard', ({ cardId, bet }) => {
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

    const card = hand[cardIdx];
    const betAmt = Math.max(0, Math.min(parseInt(bet) || 0, room.coins[socket.id]));

    if (room.coins[socket.id] < card.cost) {
      socket.emit('error', { msg: `Koin tidak cukup! Butuh ${card.cost} koin.` });
      return;
    }

    // Deduct card cost
    room.coins[socket.id] -= card.cost;

    // Remove card from hand
    hand.splice(cardIdx, 1);

    resolveCard(room, socket.id, card, betAmt);
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
    // Reset room for rematch
    const room = rooms[roomId];
    if (!room || room.players.length < 2) return;

    room.coins = {};
    room.hands = {};
    room.decks = {};
    room.pendingAttack = {};
    room.doubleNext = {};
    room.mirrorActive = {};
    room.playedCard = {};
    room.roundBet = 0;
    room.round = 0;
    room.log = [];

    room.players.forEach(pid => {
      room.coins[pid] = STARTING_COINS;
      room.hands[pid] = [];
      room.decks[pid] = createDeck();
      room.doubleNext[pid] = false;
      room.mirrorActive[pid] = false;
      room.pendingAttack[pid] = 0;
      drawCards(room.decks[pid], room.hands[pid], HAND_SIZE);
    });

    room.turn = room.players[Math.floor(Math.random() * 2)];
    room.phase = 'playing';
    addLog(room, `🔄 Rematch dimulai! ${room.names[room.turn]} mulai duluan!`);
    broadcastState(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 Card Battle server running on port ${PORT}`));