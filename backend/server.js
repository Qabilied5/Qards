const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

app.use(express.static(path.join(__dirname, "..")));

// Game state
const rooms = {};

function generateColor() {
  const r = Math.floor(Math.random() * 256);
  const g = Math.floor(Math.random() * 256);
  const b = Math.floor(Math.random() * 256);
  return { r, g, b, hex: rgbToHex(r, g, b) };
}

function rgbToHex(r, g, b) {
  return (
    "#" +
    [r, g, b]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

function colorDistance(c1, c2) {
  // Using weighted Euclidean distance (human perception)
  const rDiff = c1.r - c2.r;
  const gDiff = c1.g - c2.g;
  const bDiff = c1.b - c2.b;
  const dist = Math.sqrt(
    2 * rDiff * rDiff + 4 * gDiff * gDiff + 3 * bDiff * bDiff
  );
  // Max possible distance ~= 764.8
  const maxDist = Math.sqrt(2 * 255 * 255 + 4 * 255 * 255 + 3 * 255 * 255);
  const accuracy = Math.max(0, 100 - (dist / maxDist) * 100);
  return { distance: Math.round(dist), accuracy: Math.round(accuracy * 10) / 10 };
}

function createRoom(roomId) {
  return {
    id: roomId,
    players: [],
    targetColor: null,
    submissions: {},
    submitOrder: [],
    round: 0,
    maxRounds: 5,
    scores: {},
    status: "waiting", // waiting, playing, reviewing, finished
    roundStartTime: null,
  };
}

const MEMORIZE_SECONDS = 10;

function startRound(room) {
  room.targetColor = generateColor();
  room.submissions = {};
  room.submitOrder = [];
  room.status = "memorizing";
  room.round++;

  // Phase 1: show target color for memorization
  io.to(room.id).emit("memorize_start", {
    round: room.round,
    maxRounds: room.maxRounds,
    targetColor: room.targetColor,
    scores: room.scores,
    memorizeSeconds: MEMORIZE_SECONDS,
  });

  // Phase 2: hide color and start picking phase
  setTimeout(() => {
    if (!room || room.status !== "memorizing") return;
    room.status = "playing";
    room.roundStartTime = Date.now();
    io.to(room.id).emit("memorize_end", {});
  }, MEMORIZE_SECONDS * 1000);
}

function resolveRound(room) {
  room.status = "reviewing";
  const results = [];

  // Process in submission order
  room.submitOrder.forEach((playerId, index) => {
    const sub = room.submissions[playerId];
    const player = room.players.find((p) => p.id === playerId);
    const { distance, accuracy } = colorDistance(room.targetColor, sub.color);

    // Bonus points for submitting first (only if accuracy > 50%)
    let roundScore = Math.round(accuracy);
    let speedBonus = 0;
    if (index === 0 && accuracy > 50) {
      speedBonus = 5;
      roundScore += speedBonus;
    }

    room.scores[playerId] = (room.scores[playerId] || 0) + roundScore;

    results.push({
      playerId,
      playerName: player?.name || "Player",
      color: sub.color,
      accuracy,
      distance,
      roundScore,
      speedBonus,
      totalScore: room.scores[playerId],
      submittedFirst: index === 0,
      timeTaken: sub.timeTaken,
    });
  });

  // Sort by accuracy descending
  results.sort((a, b) => b.accuracy - a.accuracy);

  io.to(room.id).emit("round_result", {
    results,
    targetColor: room.targetColor,
    round: room.round,
    maxRounds: room.maxRounds,
    scores: room.scores,
  });

  // Check if game over
  if (room.round >= room.maxRounds) {
    setTimeout(() => endGame(room), 4000);
  } else {
    setTimeout(() => startRound(room), 5000);
  }
}

function endGame(room) {
  room.status = "finished";
  const finalResults = room.players.map((p) => ({
    playerId: p.id,
    playerName: p.name,
    totalScore: room.scores[p.id] || 0,
  }));
  finalResults.sort((a, b) => b.totalScore - a.totalScore);

  io.to(room.id).emit("game_over", { finalResults });
}

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("join_room", ({ roomId, playerName }) => {
    // Find or create room
    if (!rooms[roomId]) {
      rooms[roomId] = createRoom(roomId);
    }
    const room = rooms[roomId];

    // Don't allow more than 2 players
    if (room.players.length >= 2) {
      socket.emit("error", { message: "Room is full!" });
      return;
    }

    // Add player
    const player = {
      id: socket.id,
      name: playerName || `Player ${room.players.length + 1}`,
      playerNumber: room.players.length + 1,
    };
    room.players.push(player);
    room.scores[socket.id] = 0;
    socket.join(roomId);
    socket.roomId = roomId;

    socket.emit("joined", {
      player,
      roomId,
      playerCount: room.players.length,
    });

    io.to(roomId).emit("player_update", {
      players: room.players,
      playerCount: room.players.length,
    });

    // Start game when 2 players join
    if (room.players.length === 2) {
      setTimeout(() => startRound(room), 2000);
    }
  });

  socket.on("submit_color", ({ color }) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];

    if (room.status !== "playing") return;
    if (room.submissions[socket.id]) return; // Already submitted

    const timeTaken = Date.now() - room.roundStartTime;
    room.submissions[socket.id] = { color, timeTaken };
    room.submitOrder.push(socket.id);

    // Notify room that a player submitted (without revealing color)
    const submitterIndex = room.submitOrder.length;
    io.to(roomId).emit("player_submitted", {
      playerId: socket.id,
      submissionOrder: submitterIndex,
      totalPlayers: room.players.length,
    });

    // If all players submitted, resolve round
    if (room.submitOrder.length === room.players.length) {
      setTimeout(() => resolveRound(room), 800);
    }
  });

  socket.on("play_again", () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];

    if (room.status === "finished") {
      // Reset room
      room.round = 0;
      room.scores = {};
      room.players.forEach((p) => (room.scores[p.id] = 0));
      setTimeout(() => startRound(room), 1000);
    }
  });

  socket.on("disconnect", () => {
    const roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      room.players = room.players.filter((p) => p.id !== socket.id);

      if (room.players.length === 0) {
        delete rooms[roomId];
      } else {
        io.to(roomId).emit("player_disconnected", {
          players: room.players,
          playerCount: room.players.length,
        });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 ColorPick Game running on port ${PORT}`);
});