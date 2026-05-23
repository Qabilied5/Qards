const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const path    = require("path");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "..")));

// ─── Game state ──────────────────────────────────────────────────────────────
const rooms = {};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function generateColor() {
  const r = Math.floor(Math.random() * 256);
  const g = Math.floor(Math.random() * 256);
  const b = Math.floor(Math.random() * 256);
  return { r, g, b, hex: rgbToHex(r, g, b) };
}
function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map(x => x.toString(16).padStart(2, "0")).join("").toUpperCase();
}
function colorDistance(c1, c2) {
  const rD = c1.r - c2.r, gD = c1.g - c2.g, bD = c1.b - c2.b;
  const dist = Math.sqrt(2*rD*rD + 4*gD*gD + 3*bD*bD);
  const maxDist = Math.sqrt(2*255*255 + 4*255*255 + 3*255*255);
  const accuracy = Math.max(0, 100 - (dist / maxDist) * 100);
  return { distance: Math.round(dist), accuracy: Math.round(accuracy * 10) / 10 };
}
function generateBotColor(target) {
  const err = Math.floor(Math.random() * 80) + 20;
  const clamp = v => Math.max(0, Math.min(255, Math.round(v)));
  return {
    r: clamp(target.r + (Math.random() * err * 2 - err)),
    g: clamp(target.g + (Math.random() * err * 2 - err)),
    b: clamp(target.b + (Math.random() * err * 2 - err)),
  };
}

function createRoom(roomId) {
  return {
    id: roomId,
    players: [],         // { id, name, playerNumber }
    hostId: null,
    targetColor: null,
    submissions: {},
    submitOrder: [],
    round: 0,
    maxRounds: 5,
    scores: {},
    status: "waiting",   // waiting | memorizing | playing | reviewing | finished
    roundStartTime: null,
    soloMode: false,
    botSubmitTimeout: null,
  };
}

const MEMORIZE_SECONDS = 5;

// ─── Bot ─────────────────────────────────────────────────────────────────────
function scheduleBotSubmit(room) {
  if (!room.soloMode) return;
  const delay = Math.floor(Math.random() * 9000) + 3000;
  room.botSubmitTimeout = setTimeout(() => {
    if (!room || room.status !== "playing" || room.submissions["bot"]) return;
    const botColor = generateBotColor(room.targetColor);
    room.submissions["bot"] = { color: botColor, timeTaken: Date.now() - room.roundStartTime };
    room.submitOrder.push("bot");
    io.to(room.id).emit("player_submitted", {
      playerId: "bot", submissionOrder: room.submitOrder.length, totalPlayers: 2,
    });
    if (room.submitOrder.length === 2) setTimeout(() => resolveRound(room), 800);
  }, delay);
}

// ─── Round logic ─────────────────────────────────────────────────────────────
function startRound(room) {
  room.targetColor = generateColor();
  room.submissions = {};
  room.submitOrder = [];
  room.status = "memorizing";
  room.round++;

  io.to(room.id).emit("memorize_start", {
    round: room.round, maxRounds: room.maxRounds,
    targetColor: room.targetColor, scores: room.scores,
    memorizeSeconds: MEMORIZE_SECONDS,
  });

  setTimeout(() => {
    if (!room || room.status !== "memorizing") return;
    room.status = "playing";
    room.roundStartTime = Date.now();
    io.to(room.id).emit("memorize_end", {});
    scheduleBotSubmit(room);
  }, MEMORIZE_SECONDS * 1000);
}

function resolveRound(room) {
  room.status = "reviewing";
  const results = [];

  room.submitOrder.forEach((playerId, index) => {
    const sub    = room.submissions[playerId];
    const isBot  = playerId === "bot";
    const player = isBot ? { id: "bot", name: "BOT" } : room.players.find(p => p.id === playerId);
    const { distance, accuracy } = colorDistance(room.targetColor, sub.color);
    let roundScore = Math.round(accuracy);
    let speedBonus = 0;
    if (index === 0 && accuracy > 50) { speedBonus = 5; roundScore += speedBonus; }
    room.scores[playerId] = (room.scores[playerId] || 0) + roundScore;
    results.push({
      playerId, playerName: player?.name || "Player",
      color: sub.color, accuracy, distance, roundScore, speedBonus,
      totalScore: room.scores[playerId],
      submittedFirst: index === 0, timeTaken: sub.timeTaken,
    });
  });

  results.sort((a, b) => b.accuracy - a.accuracy);
  io.to(room.id).emit("round_result", {
    results, targetColor: room.targetColor, round: room.round, maxRounds: room.maxRounds, scores: room.scores,
  });

  if (room.round >= room.maxRounds) {
    setTimeout(() => endGame(room), 4000);
  } else {
    setTimeout(() => startRound(room), 5000);
  }
}

function endGame(room) {
  room.status = "finished";
  const allPlayers = room.soloMode
    ? [...room.players, { id: "bot", name: "BOT" }]
    : room.players;
  const finalResults = allPlayers
    .map(p => ({ playerId: p.id, playerName: p.name, totalScore: room.scores[p.id] || 0 }))
    .sort((a, b) => b.totalScore - a.totalScore);
  io.to(room.id).emit("game_over", { finalResults });
}

// ─── Emit lobby state to all players in room ─────────────────────────────────
function emitLobbyState(room) {
  room.players.forEach(p => {
    io.to(p.id).emit("lobby_state", {
      players:   room.players,
      hostId:    room.hostId,
      isHost:    p.id === room.hostId,
      roomId:    room.id,
      canStart:  p.id === room.hostId && room.players.length >= 2,
    });
  });
}

// ─── Socket ──────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // ── Solo mode ──
  socket.on("solo_start", ({ playerName }) => {
    const roomId = "SOLO_" + socket.id.slice(0, 6).toUpperCase();
    rooms[roomId] = createRoom(roomId);
    const room = rooms[roomId];
    room.soloMode = true;
    room.hostId   = socket.id;
    room.scores["bot"] = 0;

    const player = { id: socket.id, name: playerName || "Player", playerNumber: 1 };
    room.players.push(player);
    room.scores[socket.id] = 0;
    socket.join(roomId);
    socket.roomId = roomId;

    socket.emit("joined", { player, roomId, soloMode: true });
    socket.emit("lobby_state", {
      players: room.players, hostId: room.hostId, isHost: true, roomId, canStart: false,
    });
    setTimeout(() => startRound(room), 1000);
  });

  // ── Create room ──
  socket.on("create_room", ({ playerName }) => {
    const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
    rooms[roomId] = createRoom(roomId);
    const room = rooms[roomId];
    room.hostId = socket.id;

    const player = { id: socket.id, name: playerName || "Player 1", playerNumber: 1 };
    room.players.push(player);
    room.scores[socket.id] = 0;
    socket.join(roomId);
    socket.roomId = roomId;

    socket.emit("joined", { player, roomId, soloMode: false });
    emitLobbyState(room);
  });

  // ── Join room ──
  socket.on("join_room", ({ roomId, playerName }) => {
    const room = rooms[roomId];
    if (!room) { socket.emit("error", { message: "Room not found!" }); return; }
    if (room.status !== "waiting") { socket.emit("error", { message: "Game already started!" }); return; }
    if (room.players.length >= 8) { socket.emit("error", { message: "Room is full! (max 8)" }); return; }

    const player = {
      id: socket.id,
      name: playerName || `Player ${room.players.length + 1}`,
      playerNumber: room.players.length + 1,
    };
    room.players.push(player);
    room.scores[socket.id] = 0;
    socket.join(roomId);
    socket.roomId = roomId;

    socket.emit("joined", { player, roomId, soloMode: false });
    emitLobbyState(room);
  });

  // ── Host starts game ──
  socket.on("host_start", () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (socket.id !== room.hostId) { socket.emit("error", { message: "Only the host can start!" }); return; }
    if (room.players.length < 2)   { socket.emit("error", { message: "Need at least 2 players!" }); return; }
    if (room.status !== "waiting") return;

    // Initialize scores for all players
    room.players.forEach(p => { if (!room.scores[p.id]) room.scores[p.id] = 0; });

    io.to(roomId).emit("game_starting", { players: room.players });
    setTimeout(() => startRound(room), 2000);
  });

  // ── Submit color ──
  socket.on("submit_color", ({ color }) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (room.status !== "playing" || room.submissions[socket.id]) return;

    const timeTaken = Date.now() - room.roundStartTime;
    room.submissions[socket.id] = { color, timeTaken };
    room.submitOrder.push(socket.id);

    io.to(roomId).emit("player_submitted", {
      playerId: socket.id,
      submissionOrder: room.submitOrder.length,
      totalPlayers: room.players.length,
    });

    if (room.submitOrder.length === (room.soloMode ? 2 : room.players.length)) {
      setTimeout(() => resolveRound(room), 800);
    }
  });

  // ── Play again (host only) ──
  socket.on("play_again", () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    if (room.status !== "finished") return;
    if (socket.id !== room.hostId) { socket.emit("error", { message: "Only the host can restart!" }); return; }

    room.round = 0;
    room.scores = {};
    room.players.forEach(p => (room.scores[p.id] = 0));
    if (room.soloMode) room.scores["bot"] = 0;
    room.status = "waiting";

    io.to(roomId).emit("game_starting", { players: room.players });
    setTimeout(() => startRound(room), 1500);
  });

  // ── Disconnect ──
  socket.on("disconnect", () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];

    room.players = room.players.filter(p => p.id !== socket.id);

    if (room.players.length === 0) {
      delete rooms[roomId];
      return;
    }

    // If host left, assign new host
    if (room.hostId === socket.id) {
      room.hostId = room.players[0].id;
      io.to(room.hostId).emit("you_are_host", {});
    }

    io.to(roomId).emit("player_disconnected", {
      players: room.players, playerCount: room.players.length, hostId: room.hostId,
    });

    // If game was in progress and only 1 player left, end game
    if (room.status !== "waiting" && room.status !== "finished" && room.players.length < 2) {
      endGame(room);
    } else if (room.status === "waiting") {
      emitLobbyState(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 ColorPick running on port ${PORT}`));