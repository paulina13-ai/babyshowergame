const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager, REVEAL_SECONDS, VOTING_SECONDS, isGuessCorrect } = require('./rooms');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

const manager = new RoomManager();
// socket.id -> { roomCode, clientId }
const socketMeta = new Map();

function broadcastRoomState(room) {
  io.to(room.code).emit('room:state', room.publicState());
}

function socketForClient(room, clientId) {
  const player = room.players.get(clientId);
  if (!player || !player.socketId) return null;
  return io.sockets.sockets.get(player.socketId) || null;
}

function roundStartPayload(room, drawer) {
  return {
    drawerClientId: drawer.clientId,
    drawerName: drawer.name,
    roundNumber: room.roundNumber,
    totalRounds: room.totalRounds,
    endsAt: room.roundEndsAt,
    roundSeconds: room.roundSeconds,
  };
}

function launchRound(room) {
  const drawer = room.beginRound();
  if (!drawer) {
    endGame(room);
    return;
  }
  broadcastRoomState(room);
  io.to(room.code).emit('draw:clear');
  io.to(room.code).emit('round:start', roundStartPayload(room, drawer));
  const drawerSocket = socketForClient(room, drawer.clientId);
  if (drawerSocket) drawerSocket.emit('round:word', { word: room.currentWord });

  room.timer = setTimeout(() => finishRoundAndScheduleNext(room, 'timeout'), room.roundSeconds * 1000);
}

function finishRoundAndScheduleNext(room, reason) {
  if (room.state !== 'drawing') return;
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  const summary = room.finishRound();
  broadcastRoomState(room);
  io.to(room.code).emit('round:end', { ...summary, reason });

  if (room.isGameOver()) {
    room.revealTimer = setTimeout(() => startVotingPhase(room), REVEAL_SECONDS * 1000);
  } else {
    room.revealTimer = setTimeout(() => launchRound(room), REVEAL_SECONDS * 1000);
  }
}

function startVotingPhase(room) {
  room.clearTimers();
  if (!room.canStartVoting()) {
    endGame(room);
    return;
  }
  room.startVoting();
  broadcastRoomState(room);
  const endsAt = Date.now() + VOTING_SECONDS * 1000;
  for (const player of room.connectedPlayers) {
    const s = socketForClient(room, player.clientId);
    if (s) {
      s.emit('voting:start', {
        drawings: room.votingGalleryForClient(player.clientId),
        votingSeconds: VOTING_SECONDS,
        endsAt,
      });
    }
  }
  room.timer = setTimeout(() => revealWinnerAndEndGame(room), VOTING_SECONDS * 1000);
}

function revealWinnerAndEndGame(room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  endGame(room, room.tallyDrawingContest());
}

function endGame(room, drawingContest = null) {
  room.clearTimers();
  room.state = 'gameover';
  broadcastRoomState(room);
  io.to(room.code).emit('game:end', { finalScores: room.finalScores(), drawingContest });
}

io.on('connection', (socket) => {
  socket.on('host:create', ({ clientId, name }, cb) => {
    if (typeof cb !== 'function') return;
    const cleanName = (name || '').trim().slice(0, 20);
    if (!clientId || !cleanName) return cb({ ok: false, error: 'Missing name.' });

    const room = manager.createRoom();
    const player = room.addPlayer(clientId, cleanName, true);
    player.socketId = socket.id;
    socket.join(room.code);
    socketMeta.set(socket.id, { roomCode: room.code, clientId });

    cb({ ok: true, roomCode: room.code, state: room.publicState() });
    broadcastRoomState(room);
  });

  socket.on('player:join', ({ clientId, roomCode, name }, cb) => {
    if (typeof cb !== 'function') return;
    const room = manager.getRoom(roomCode);
    if (!room) return cb({ ok: false, error: 'Room not found. Double check the code.' });
    if (!clientId) return cb({ ok: false, error: 'Missing client id.' });

    const existing = room.players.get(clientId);
    if (existing) {
      existing.connected = true;
      existing.socketId = socket.id;
      room.ensureHost();
      socket.join(room.code);
      socketMeta.set(socket.id, { roomCode: room.code, clientId });
      cb({ ok: true, roomCode: room.code, state: room.publicState(), rejoined: true });
      broadcastRoomState(room);
      if (room.state === 'drawing') {
        const drawer = room.currentDrawer();
        socket.emit('round:start', roundStartPayload(room, drawer));
        if (drawer && drawer.clientId === clientId) {
          socket.emit('round:word', { word: room.currentWord });
        }
      }
      return;
    }

    const cleanName = (name || '').trim().slice(0, 20);
    if (!cleanName) return cb({ ok: false, error: 'Enter a name.' });
    if (room.state !== 'lobby') return cb({ ok: false, error: 'This game already started.' });
    if (room.findPlayerByName(cleanName)) return cb({ ok: false, error: 'That name is taken in this room.' });

    const player = room.addPlayer(clientId, cleanName, false);
    player.socketId = socket.id;
    socket.join(room.code);
    socketMeta.set(socket.id, { roomCode: room.code, clientId });

    cb({ ok: true, roomCode: room.code, state: room.publicState() });
    broadcastRoomState(room);
  });

  socket.on('host:configure', ({ roundsPerPlayer, roundSeconds }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = manager.getRoom(meta.roomCode);
    if (!room || room.state !== 'lobby' || meta.clientId !== room.hostClientId) return;
    if (Number.isInteger(roundsPerPlayer) && roundsPerPlayer >= 1 && roundsPerPlayer <= 3) {
      room.roundsPerPlayer = roundsPerPlayer;
    }
    if (Number.isInteger(roundSeconds) && roundSeconds >= 30 && roundSeconds <= 180) {
      room.roundSeconds = roundSeconds;
    }
    broadcastRoomState(room);
  });

  socket.on('host:start', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = manager.getRoom(meta.roomCode);
    if (!room || room.state !== 'lobby' || meta.clientId !== room.hostClientId) return;
    if (room.connectedPlayers.length < 2) return;
    room.startGame();
    launchRound(room);
  });

  socket.on('draw:stroke', (stroke) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = manager.getRoom(meta.roomCode);
    if (!room || room.state !== 'drawing') return;
    const drawer = room.currentDrawer();
    if (!drawer || drawer.clientId !== meta.clientId) return;
    socket.to(room.code).emit('draw:stroke', stroke);
  });

  socket.on('drawer:skip-word', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = manager.getRoom(meta.roomCode);
    if (!room || room.state !== 'drawing' || room.skipUsedThisRound) return;
    const drawer = room.currentDrawer();
    if (!drawer || drawer.clientId !== meta.clientId) return;
    room.skipUsedThisRound = true;
    room.currentWord = room.pickWord();
    socket.emit('round:word', { word: room.currentWord });
  });

  socket.on('guess:submit', ({ text }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = manager.getRoom(meta.roomCode);
    if (!room || room.state !== 'drawing') return;
    const drawer = room.currentDrawer();
    if (!drawer || drawer.clientId === meta.clientId) return;
    const guesser = room.players.get(meta.clientId);
    if (!guesser || room.correctClientIds.has(meta.clientId)) return;

    const cleanText = (text || '').toString().trim().slice(0, 60);
    if (!cleanText) return;

    if (isGuessCorrect(cleanText, room.currentWord)) {
      const result = room.awardCorrectGuess(meta.clientId);
      if (result) {
        io.to(room.code).emit('guess:correct', {
          clientId: meta.clientId,
          name: result.guesser.name,
          points: result.points,
        });
        broadcastRoomState(room);
      }
      if (room.allEligibleGuessersDone()) {
        finishRoundAndScheduleNext(room, 'all-guessed');
      }
    } else {
      io.to(room.code).emit('guess:attempt', { clientId: meta.clientId, name: guesser.name, text: cleanText });
    }
  });

  socket.on('drawer:end-round', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = manager.getRoom(meta.roomCode);
    if (!room || room.state !== 'drawing') return;
    const drawer = room.currentDrawer();
    if (!drawer || drawer.clientId !== meta.clientId) return;
    finishRoundAndScheduleNext(room, 'ended-early');
  });

  socket.on('host:next-round', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = manager.getRoom(meta.roomCode);
    if (!room || room.state !== 'reveal' || meta.clientId !== room.hostClientId) return;
    if (room.revealTimer) clearTimeout(room.revealTimer);
    room.revealTimer = null;
    if (room.isGameOver()) startVotingPhase(room);
    else launchRound(room);
  });

  socket.on('host:reveal-winner', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = manager.getRoom(meta.roomCode);
    if (!room || room.state !== 'voting' || meta.clientId !== room.hostClientId) return;
    revealWinnerAndEndGame(room);
  });

  socket.on('vote:submit', ({ index }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = manager.getRoom(meta.roomCode);
    if (!room || room.state !== 'voting') return;
    if (room.castVote(meta.clientId, index)) {
      io.to(room.code).emit('vote:progress', {
        votedCount: room.votes.size,
        totalEligible: room.connectedPlayers.length,
      });
    }
  });

  socket.on('round:snapshot', ({ dataUrl }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = manager.getRoom(meta.roomCode);
    if (!room || room.state !== 'reveal') return;
    const drawer = room.currentDrawer();
    if (!drawer || drawer.clientId !== meta.clientId) return;
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/') || dataUrl.length > 500_000) return;
    room.addDrawing(room.roundNumber, drawer.clientId, drawer.name, room.currentWord, dataUrl);
  });

  socket.on('host:play-again', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = manager.getRoom(meta.roomCode);
    if (!room || room.state !== 'gameover' || meta.clientId !== room.hostClientId) return;
    room.resetForPlayAgain();
    broadcastRoomState(room);
  });

  socket.on('player:leave', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    socketMeta.delete(socket.id);
    socket.leave(meta.roomCode);
    const room = manager.getRoom(meta.roomCode);
    if (!room) return;

    const wasDrawer = room.state === 'drawing' && room.currentDrawer()?.clientId === meta.clientId;
    room.removePlayer(meta.clientId);
    room.ensureHost();
    broadcastRoomState(room);

    if (wasDrawer) finishRoundAndScheduleNext(room, 'drawer-left');
    manager.removeRoomIfEmpty(room.code);
  });

  socket.on('disconnect', () => {
    const meta = socketMeta.get(socket.id);
    socketMeta.delete(socket.id);
    if (!meta) return;
    const room = manager.getRoom(meta.roomCode);
    if (!room) return;
    const player = room.players.get(meta.clientId);
    if (player && player.socketId === socket.id) {
      player.connected = false;
      room.ensureHost();
      broadcastRoomState(room);
    }
    manager.removeRoomIfEmpty(room.code);
  });
});

server.listen(PORT, () => {
  console.log(`Baby shower pictionary running on http://localhost:${PORT}`);
});
