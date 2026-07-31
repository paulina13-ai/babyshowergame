(() => {
  const socket = io();

  const COLORS = ['#000000', '#e0264a', '#ff8a00', '#ffd400', '#2ecc71', '#1e90ff', '#8e44ad', '#ffffff'];

  const els = {
    landingError: document.getElementById('landing-error'),
    createName: document.getElementById('create-name'),
    joinCode: document.getElementById('join-code'),
    joinName: document.getElementById('join-name'),
    btnCreate: document.getElementById('btn-create'),
    btnJoin: document.getElementById('btn-join'),

    lobbyCode: document.getElementById('lobby-code'),
    lobbyPlayers: document.getElementById('lobby-players'),
    hostSettings: document.getElementById('host-settings'),
    settingRounds: document.getElementById('setting-rounds'),
    settingSeconds: document.getElementById('setting-seconds'),
    btnStart: document.getElementById('btn-start'),

    roundLabel: document.getElementById('round-label'),
    timer: document.getElementById('timer'),
    drawerBanner: document.getElementById('drawer-banner'),
    wordShape: document.getElementById('word-shape'),
    yourWord: document.getElementById('your-word'),
    canvas: document.getElementById('canvas'),
    drawTools: document.getElementById('draw-tools'),
    colorSwatches: document.getElementById('color-swatches'),
    brushSize: document.getElementById('brush-size'),
    btnSkip: document.getElementById('btn-skip'),
    btnEndRound: document.getElementById('btn-end-round'),
    gamePlayers: document.getElementById('game-players'),
    guessBox: document.getElementById('guess-box'),
    guessInput: document.getElementById('guess-input'),
    btnGuess: document.getElementById('btn-guess'),
    guessAlreadyCorrect: document.getElementById('guess-already-correct'),
    guessFeed: document.getElementById('guess-feed'),

    btnLeaveRoom: document.getElementById('btn-leave-room'),

    revealWord: document.getElementById('reveal-word'),
    revealCorrect: document.getElementById('reveal-correct'),
    revealScores: document.getElementById('reveal-scores'),
    btnNextRound: document.getElementById('btn-next-round'),
    revealAutoHint: document.getElementById('reveal-auto-hint'),

    winnerBanner: document.getElementById('winner-banner'),
    finalScores: document.getElementById('final-scores'),
    btnPlayAgain: document.getElementById('btn-play-again'),
    gameoverHint: document.getElementById('gameover-hint'),
  };

  const ctx = els.canvas.getContext('2d');
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  function getClientId() {
    let id = localStorage.getItem('bsp_clientId');
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
      localStorage.setItem('bsp_clientId', id);
    }
    return id;
  }

  const clientId = getClientId();

  let room = null; // last known public room state
  let currentRound = null; // { drawerClientId, drawerName, roundNumber, totalRounds, endsAt, roundSeconds, wordShape }
  let correctSet = new Set();
  let timerInterval = null;
  let currentColor = COLORS[0];
  let currentWidth = Number(els.brushSize.value);
  let drawing = false;
  let lastPoint = null;

  function isHostMe() {
    return !!room && room.hostClientId === clientId;
  }

  function myPlayer() {
    return room ? room.players.find((p) => p.clientId === clientId) : null;
  }

  function showScreen(name) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    document.getElementById(`screen-${name}`).classList.add('active');
    els.btnLeaveRoom.classList.toggle('hidden', name === 'landing');
  }

  function saveSession(roomCode, name) {
    localStorage.setItem('bsp_session', JSON.stringify({ roomCode, name }));
  }

  function clearSession() {
    localStorage.removeItem('bsp_session');
  }

  // ---------- Landing ----------

  els.btnCreate.addEventListener('click', () => {
    const name = els.createName.value.trim();
    els.landingError.textContent = '';
    if (!name) { els.landingError.textContent = 'Enter your name first.'; return; }
    socket.emit('host:create', { clientId, name }, (res) => {
      if (!res.ok) { els.landingError.textContent = res.error; return; }
      room = res.state;
      saveSession(res.roomCode, name);
      showScreen('lobby');
      renderLobby();
    });
  });

  els.btnJoin.addEventListener('click', () => {
    const code = els.joinCode.value.trim().toUpperCase();
    const name = els.joinName.value.trim();
    els.landingError.textContent = '';
    if (!code || !name) { els.landingError.textContent = 'Enter the room code and your name.'; return; }
    socket.emit('player:join', { clientId, roomCode: code, name }, (res) => {
      if (!res.ok) { els.landingError.textContent = res.error; return; }
      room = res.state;
      saveSession(res.roomCode, name);
      showScreen(room.state === 'lobby' ? 'lobby' : 'lobby');
      renderLobby();
    });
  });

  // Attempt silent auto-rejoin after a refresh.
  (function tryAutoRejoin() {
    const raw = localStorage.getItem('bsp_session');
    if (!raw) return;
    let session;
    try { session = JSON.parse(raw); } catch { return; }
    if (!session || !session.roomCode || !session.name) return;
    socket.emit('player:join', { clientId, roomCode: session.roomCode, name: session.name }, (res) => {
      if (!res.ok) { clearSession(); return; }
      room = res.state;
      showScreen('lobby');
      renderLobby();
    });
  })();

  els.btnLeaveRoom.addEventListener('click', () => {
    if (!confirm('Leave this room and go back to the start page?')) return;
    socket.emit('player:leave');
    clearSession();
    room = null;
    currentRound = null;
    correctSet = new Set();
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    els.landingError.textContent = '';
    showScreen('landing');
  });

  // ---------- Lobby ----------

  els.settingRounds.addEventListener('change', () => {
    if (!isHostMe()) return;
    socket.emit('host:configure', { roundsPerPlayer: Number(els.settingRounds.value) });
  });
  els.settingSeconds.addEventListener('change', () => {
    if (!isHostMe()) return;
    socket.emit('host:configure', { roundSeconds: Number(els.settingSeconds.value) });
  });
  els.btnStart.addEventListener('click', () => {
    if (!isHostMe()) return;
    socket.emit('host:start');
  });

  function renderLobby() {
    if (!room) return;
    els.lobbyCode.textContent = room.code;
    els.lobbyPlayers.innerHTML = '';
    room.players.forEach((p) => {
      const li = document.createElement('li');
      if (p.isHost) li.classList.add('host');
      if (!p.connected) li.classList.add('disconnected');
      li.innerHTML = `<span>${escapeHtml(p.name)}${!p.connected ? ' (left)' : ''}</span>`;
      els.lobbyPlayers.appendChild(li);
    });

    const amHost = isHostMe();
    els.hostSettings.classList.toggle('hidden', !amHost);
    if (amHost) {
      els.settingRounds.value = String(room.roundsPerPlayer);
      els.settingSeconds.value = String(room.roundSeconds);
      const connectedCount = room.players.filter((p) => p.connected).length;
      els.btnStart.disabled = connectedCount < 2;
      els.btnStart.textContent = connectedCount < 2
        ? 'Start Game (need 2+ players)'
        : `Start Game (${connectedCount} players)`;
    }
  }

  // ---------- Canvas ----------

  function resetCanvas() {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, els.canvas.width, els.canvas.height);
  }

  function getPos(evt) {
    const rect = els.canvas.getBoundingClientRect();
    const scaleX = els.canvas.width / rect.width;
    const scaleY = els.canvas.height / rect.height;
    return {
      x: (evt.clientX - rect.left) * scaleX,
      y: (evt.clientY - rect.top) * scaleY,
    };
  }

  function drawSegment(p0, p1, color, width) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.stroke();
  }

  function amIDrawing() {
    return !!currentRound && currentRound.drawerClientId === clientId;
  }

  els.canvas.addEventListener('pointerdown', (evt) => {
    if (!amIDrawing()) return;
    drawing = true;
    els.canvas.setPointerCapture(evt.pointerId);
    lastPoint = getPos(evt);
  });

  els.canvas.addEventListener('pointermove', (evt) => {
    if (!drawing || !amIDrawing()) return;
    const p = getPos(evt);
    drawSegment(lastPoint, p, currentColor, currentWidth);
    socket.emit('draw:stroke', { x0: lastPoint.x, y0: lastPoint.y, x1: p.x, y1: p.y, color: currentColor, width: currentWidth });
    lastPoint = p;
  });

  ['pointerup', 'pointercancel', 'pointerleave'].forEach((evtName) => {
    els.canvas.addEventListener(evtName, () => { drawing = false; lastPoint = null; });
  });

  els.brushSize.addEventListener('input', () => { currentWidth = Number(els.brushSize.value); });

  COLORS.forEach((c, idx) => {
    const btn = document.createElement('div');
    btn.className = 'swatch' + (idx === 0 ? ' selected' : '');
    btn.style.background = c;
    btn.addEventListener('click', () => {
      currentColor = c;
      document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('selected'));
      btn.classList.add('selected');
    });
    els.colorSwatches.appendChild(btn);
  });

  els.btnSkip.addEventListener('click', () => {
    if (!amIDrawing()) return;
    socket.emit('drawer:skip-word');
  });

  els.btnEndRound.addEventListener('click', () => {
    if (!amIDrawing()) return;
    socket.emit('drawer:end-round');
  });

  function submitGuess() {
    const text = els.guessInput.value.trim();
    if (!text || amIDrawing() || correctSet.has(clientId)) return;
    socket.emit('guess:submit', { text });
    els.guessInput.value = '';
  }

  els.btnGuess.addEventListener('click', submitGuess);
  els.guessInput.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter') submitGuess();
  });

  function addGuessFeedEntry(text, isCorrect) {
    const li = document.createElement('li');
    if (isCorrect) li.classList.add('correct');
    li.textContent = text;
    els.guessFeed.appendChild(li);
    els.guessFeed.scrollTop = els.guessFeed.scrollHeight;
    while (els.guessFeed.children.length > 30) els.guessFeed.removeChild(els.guessFeed.firstChild);
  }

  // ---------- Game screen ----------

  function startTimerLoop() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(updateTimerDisplay, 250);
    updateTimerDisplay();
  }

  function updateTimerDisplay() {
    if (!currentRound) return;
    const remainingMs = currentRound.endsAt - Date.now();
    const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
    els.timer.textContent = String(seconds);
    els.timer.classList.toggle('low', seconds <= 10);
    if (seconds <= 0 && timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function renderWordShape(shape) {
    els.wordShape.textContent = shape.map((len) => '_'.repeat(len)).join('   ');
  }

  function renderGamePlayers() {
    if (!room || !currentRound) return;
    els.gamePlayers.innerHTML = '';
    const iAmDrawer = amIDrawing();
    room.players.forEach((p) => {
      const li = document.createElement('li');
      if (p.isHost) li.classList.add('host');
      if (!p.connected) li.classList.add('disconnected');
      const isDrawerPlayer = p.clientId === currentRound.drawerClientId;
      const isCorrect = correctSet.has(p.clientId);
      if (isCorrect) li.classList.add('correct');

      const nameLabel = isDrawerPlayer ? `🎨 ${escapeHtml(p.name)}` : escapeHtml(p.name);
      li.innerHTML = `<span>${nameLabel}${isCorrect ? ' ✅' : ''}</span><span class="score">${p.score}</span>`;

      if (iAmDrawer && !isDrawerPlayer && p.connected) {
        li.classList.add('tappable');
        li.addEventListener('click', () => {
          if (correctSet.has(p.clientId)) {
            socket.emit('drawer:undo-correct', { clientId: p.clientId });
          } else {
            socket.emit('drawer:correct', { clientId: p.clientId });
          }
        });
      }
      els.gamePlayers.appendChild(li);
    });
  }

  function enterRound(payload) {
    currentRound = payload;
    correctSet = new Set();
    resetCanvas();
    showScreen('game');
    els.roundLabel.textContent = `Round ${payload.roundNumber} / ${payload.totalRounds}`;
    startTimerLoop();

    els.guessFeed.innerHTML = '';
    els.guessInput.value = '';
    els.guessAlreadyCorrect.classList.add('hidden');

    const iAmDrawer = amIDrawing();
    els.drawTools.classList.toggle('hidden', !iAmDrawer);
    els.wordShape.classList.toggle('hidden', iAmDrawer);
    els.yourWord.classList.toggle('hidden', true);
    els.yourWord.textContent = '';
    els.guessBox.classList.toggle('hidden', iAmDrawer);

    if (iAmDrawer) {
      els.drawerBanner.textContent = "🎨 You're drawing — good luck!";
    } else {
      els.drawerBanner.textContent = `🖊️ ${payload.drawerName} is drawing — type your guess or shout it out!`;
      renderWordShape(payload.wordShape);
    }
    els.drawerBanner.classList.remove('hidden');
    renderGamePlayers();
  }

  // ---------- Reveal ----------

  function renderReveal(payload) {
    showScreen('reveal');
    els.revealWord.textContent = payload.word;
    els.revealCorrect.innerHTML = '';
    if (payload.correctGuessers.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'Nobody got it this time! 😅';
      els.revealCorrect.appendChild(li);
    } else {
      payload.correctGuessers.forEach((g) => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${escapeHtml(g.name)}</span><span class="score">+${g.points}</span>`;
        els.revealCorrect.appendChild(li);
      });
      if (payload.drawerBonus > 0 && currentRound) {
        const li = document.createElement('li');
        li.innerHTML = `<span>🎨 ${escapeHtml(currentRound.drawerName)} (drawing bonus)</span><span class="score">+${payload.drawerBonus}</span>`;
        els.revealCorrect.appendChild(li);
      }
    }

    els.revealScores.innerHTML = '';
    if (room) {
      [...room.players].sort((a, b) => b.score - a.score).forEach((p) => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${escapeHtml(p.name)}</span><span class="score">${p.score}</span>`;
        els.revealScores.appendChild(li);
      });
    }

    const amHost = isHostMe();
    els.btnNextRound.classList.toggle('hidden', !amHost);
    els.revealAutoHint.classList.toggle('hidden', amHost);
  }

  els.btnNextRound.addEventListener('click', () => {
    if (!isHostMe()) return;
    socket.emit('host:next-round');
  });

  // ---------- Game over ----------

  function renderGameOver(payload) {
    showScreen('gameover');
    const scores = payload.finalScores;
    els.finalScores.innerHTML = '';
    scores.forEach((p) => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(p.name)}</span><span class="score">${p.score}</span>`;
      els.finalScores.appendChild(li);
    });
    if (scores.length > 0) {
      const top = scores[0].score;
      const winners = scores.filter((p) => p.score === top).map((p) => p.name);
      els.winnerBanner.textContent = winners.length > 1
        ? `🏆 It's a tie! ${winners.join(' & ')} win with ${top} points!`
        : `🏆 ${winners[0]} wins with ${top} points!`;
    } else {
      els.winnerBanner.textContent = '';
    }
    const amHost = isHostMe();
    els.btnPlayAgain.classList.toggle('hidden', !amHost);
    els.gameoverHint.classList.toggle('hidden', amHost);
  }

  els.btnPlayAgain.addEventListener('click', () => {
    if (!isHostMe()) return;
    socket.emit('host:play-again');
  });

  // ---------- Socket listeners ----------

  socket.on('room:state', (payload) => {
    room = payload;
    if (room.state === 'lobby') {
      showScreen('lobby');
      renderLobby();
    } else if (room.state === 'drawing') {
      renderGamePlayers();
    }
  });

  socket.on('round:start', (payload) => {
    enterRound(payload);
  });

  socket.on('round:word', ({ word }) => {
    els.yourWord.textContent = `Your word: ${word}`;
    els.yourWord.classList.remove('hidden');
  });

  socket.on('round:word-shape', ({ wordShape }) => {
    if (currentRound) currentRound.wordShape = wordShape;
    if (!amIDrawing()) renderWordShape(wordShape);
  });

  socket.on('draw:stroke', (stroke) => {
    drawSegment({ x: stroke.x0, y: stroke.y0 }, { x: stroke.x1, y: stroke.y1 }, stroke.color, stroke.width);
  });

  socket.on('draw:clear', () => {
    resetCanvas();
  });

  socket.on('guess:correct', ({ clientId: id, name }) => {
    correctSet.add(id);
    renderGamePlayers();
    addGuessFeedEntry(`🎉 ${name} guessed it!`, true);
    if (id === clientId) {
      els.guessBox.classList.add('hidden');
      els.guessAlreadyCorrect.classList.remove('hidden');
    }
  });

  socket.on('guess:undo', ({ clientId: id }) => {
    correctSet.delete(id);
    renderGamePlayers();
    if (id === clientId) {
      els.guessBox.classList.remove('hidden');
      els.guessAlreadyCorrect.classList.add('hidden');
    }
  });

  socket.on('guess:attempt', ({ name, text }) => {
    addGuessFeedEntry(`${name}: ${text}`, false);
  });

  socket.on('round:end', (payload) => {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    renderReveal(payload);
  });

  socket.on('game:end', (payload) => {
    clearSession();
    renderGameOver(payload);
  });

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  resetCanvas();
})();
