const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager, REVEAL_SECONDS } = require('./rooms');

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
    wordShape: room.wordShape,
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
    room.revealTimer = setTimeout(() => endGame(room), REVEAL_SECONDS * 1000);
  } else {
    room.revealTimer = setTimeout(() => launchRound(room), REVEAL_SECONDS * 1000);
  }
}

function endGame(room) {
  room.clearTimers();
  room.state = 'gameover';
  broadcastRoomState(room);
  io.to(room.code).emit('game:end', { finalScores: room.finalScores() });
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

  socket.on('draw:clear', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = manager.getRoom(meta.roomCode);
    if (!room || room.state !== 'drawing') return;
    const drawer = room.currentDrawer();
    if (!drawer || drawer.clientId !== meta.clientId) return;
    socket.to(room.code).emit('draw:clear');
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
    room.wordShape = room.wordShapeFor(room.currentWord);
    io.to(room.code).emit('round:word-shape', { wordShape: room.wordShape });
    socket.emit('round:word', { word: room.currentWord });
  });

  socket.on('drawer:correct', ({ clientId }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = manager.getRoom(meta.roomCode);
    if (!room || room.state !== 'drawing') return;
    const drawer = room.currentDrawer();
    if (!drawer || drawer.clientId !== meta.clientId) return;
    if (clientId === drawer.clientId) return;

    const result = room.awardCorrectGuess(clientId);
    if (result) {
      io.to(room.code).emit('guess:correct', {
        clientId,
        name: result.guesser.name,
        points: result.points,
      });
      broadcastRoomState(room);
    }
    if (room.allEligibleGuessersDone()) {
      finishRoundAndScheduleNext(room, 'all-guessed');
    }
  });

  socket.on('drawer:undo-correct', ({ clientId }) => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = manager.getRoom(meta.roomCode);
    if (!room || room.state !== 'drawing') return;
    const drawer = room.currentDrawer();
    if (!drawer || drawer.clientId !== meta.clientId) return;
    if (room.undoCorrectGuess(clientId)) {
      io.to(room.code).emit('guess:undo', { clientId });
      broadcastRoomState(room);
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
    if (room.isGameOver()) endGame(room);
    else launchRound(room);
  });

  socket.on('host:play-again', () => {
    const meta = socketMeta.get(socket.id);
    if (!meta) return;
    const room = manager.getRoom(meta.roomCode);
    if (!room || room.state !== 'gameover' || meta.clientId !== room.hostClientId) return;
    room.resetForPlayAgain();
    broadcastRoomState(room);
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
