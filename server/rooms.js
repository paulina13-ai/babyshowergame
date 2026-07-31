const crypto = require('crypto');
const PROMPTS = require('./prompts');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const DEFAULT_ROUND_SECONDS = 75;
const REVEAL_SECONDS = 6;
const VOTING_SECONDS = 30;
const MIN_DRAWINGS_TO_VOTE = 2;
const CORRECT_GUESS_MIN_POINTS = 40;
const CORRECT_GUESS_MAX_POINTS = 100;
const DRAWER_BONUS_PER_GUESSER = 15;

function makeRoomCode(existingCodes) {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  } while (existingCodes.has(code));
  return code;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'is', 'was', 'are', 'were', 'to', 'and', 'with', 'for', 'my', 'your', 'his', 'her', 'their']);

function normalizeText(str) {
  return str.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function significantWords(str) {
  return normalizeText(str).split(' ').filter((w) => w.length > 0 && !STOPWORDS.has(w));
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

// Forgiving guess check: exact match, typo tolerance, or majority keyword overlap
// for multi-word prompts, since guessers are typing while also watching a drawing.
function isGuessCorrect(guessRaw, wordRaw) {
  const guess = normalizeText(guessRaw);
  const word = normalizeText(wordRaw);
  if (!guess) return false;
  if (guess === word) return true;

  const maxLen = Math.max(guess.length, word.length);
  if (maxLen > 0 && levenshtein(guess, word) / maxLen <= 0.2) return true;

  const wordKeywords = significantWords(wordRaw);
  if (wordKeywords.length > 1) {
    const guessWords = new Set(significantWords(guessRaw));
    const matched = wordKeywords.filter((w) => guessWords.has(w)).length;
    if (matched >= Math.ceil(wordKeywords.length * 0.6)) return true;
  }
  return false;
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // clientId -> { clientId, name, score, connected, socketId, isHost }
    this.hostClientId = null;
    this.state = 'lobby'; // lobby | drawing | reveal | voting | gameover
    this.roundsPerPlayer = 1;
    this.roundSeconds = DEFAULT_ROUND_SECONDS;
    this.order = [];
    this.turnIndex = -1;
    this.roundNumber = 0;
    this.totalRounds = 0;
    this.usedPrompts = new Set();
    this.currentWord = null;
    this.roundEndsAt = null;
    this.correctClientIds = new Set();
    this.correctLog = [];
    this.skipUsedThisRound = false;
    this.timer = null;
    this.revealTimer = null;
    this.drawings = []; // { roundNumber, drawerClientId, drawerName, word, dataUrl }
    this.votes = new Map(); // voterClientId -> drawingIndex
  }

  get connectedPlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  findPlayerByName(name) {
    return [...this.players.values()].find((p) => p.name.toLowerCase() === name.toLowerCase());
  }

  addPlayer(clientId, name, isHost) {
    const player = {
      clientId,
      name,
      score: 0,
      connected: true,
      socketId: null,
      isHost: !!isHost,
    };
    this.players.set(clientId, player);
    if (isHost) this.hostClientId = clientId;
    return player;
  }

  removePlayer(clientId) {
    this.players.delete(clientId);
  }

  ensureHost() {
    if (this.hostClientId && this.players.get(this.hostClientId)?.connected) return;
    const next = this.connectedPlayers[0];
    if (next) {
      if (this.hostClientId && this.players.has(this.hostClientId)) {
        this.players.get(this.hostClientId).isHost = false;
      }
      this.hostClientId = next.clientId;
      next.isHost = true;
    }
  }

  publicState() {
    return {
      code: this.code,
      state: this.state,
      hostClientId: this.hostClientId,
      roundsPerPlayer: this.roundsPerPlayer,
      roundSeconds: this.roundSeconds,
      roundNumber: this.roundNumber,
      totalRounds: this.totalRounds,
      players: [...this.players.values()].map((p) => ({
        clientId: p.clientId,
        name: p.name,
        score: p.score,
        connected: p.connected,
        isHost: p.isHost,
      })),
    };
  }

  currentDrawer() {
    if (this.turnIndex < 0 || this.turnIndex >= this.order.length) return null;
    const clientId = this.order[this.turnIndex];
    return this.players.get(clientId) || null;
  }

  pickWord() {
    const available = PROMPTS.filter((w) => !this.usedPrompts.has(w));
    const pool = available.length > 0 ? available : PROMPTS;
    if (available.length === 0) this.usedPrompts.clear();
    const word = pool[crypto.randomInt(pool.length)];
    this.usedPrompts.add(word);
    return word;
  }

  clearTimers() {
    if (this.timer) clearTimeout(this.timer);
    if (this.revealTimer) clearTimeout(this.revealTimer);
    this.timer = null;
    this.revealTimer = null;
  }

  startGame() {
    this.order = shuffle(this.connectedPlayers.map((p) => p.clientId));
    this.turnIndex = -1;
    this.roundNumber = 0;
    this.totalRounds = this.order.length * this.roundsPerPlayer;
    this.usedPrompts.clear();
    for (const p of this.players.values()) p.score = 0;
  }

  advanceToNextDrawer() {
    for (let i = 0; i < this.order.length; i++) {
      this.turnIndex = (this.turnIndex + 1) % this.order.length;
      const p = this.players.get(this.order[this.turnIndex]);
      if (p && p.connected) return p;
    }
    return null;
  }

  beginRound() {
    const drawer = this.advanceToNextDrawer();
    if (!drawer) return null;
    this.roundNumber += 1;
    this.state = 'drawing';
    this.currentWord = this.pickWord();
    this.roundEndsAt = Date.now() + this.roundSeconds * 1000;
    this.correctClientIds = new Set();
    this.correctLog = [];
    this.skipUsedThisRound = false;
    return drawer;
  }

  awardCorrectGuess(clientId) {
    const guesser = this.players.get(clientId);
    if (!guesser || this.correctClientIds.has(clientId)) return null;
    const remainingFraction = Math.max(0, Math.min(1, (this.roundEndsAt - Date.now()) / (this.roundSeconds * 1000)));
    const points = Math.round(
      CORRECT_GUESS_MIN_POINTS + remainingFraction * (CORRECT_GUESS_MAX_POINTS - CORRECT_GUESS_MIN_POINTS)
    );
    guesser.score += points;
    this.correctClientIds.add(clientId);
    this.correctLog.push({ clientId, name: guesser.name, points });
    return { points, guesser };
  }

  allEligibleGuessersDone() {
    const drawer = this.currentDrawer();
    const eligible = this.connectedPlayers.filter((p) => p.clientId !== drawer?.clientId);
    if (eligible.length === 0) return true;
    return eligible.every((p) => this.correctClientIds.has(p.clientId));
  }

  finishRound() {
    const drawer = this.currentDrawer();
    let drawerBonus = 0;
    if (drawer && this.correctClientIds.size > 0) {
      drawerBonus = this.correctClientIds.size * DRAWER_BONUS_PER_GUESSER;
      drawer.score += drawerBonus;
    }
    this.state = 'reveal';
    return { word: this.currentWord, correctGuessers: [...this.correctLog], drawerBonus };
  }

  isGameOver() {
    return this.roundNumber >= this.totalRounds || this.connectedPlayers.length < 2;
  }

  addDrawing(roundNumber, drawerClientId, drawerName, word, dataUrl) {
    const existingIdx = this.drawings.findIndex((d) => d.roundNumber === roundNumber);
    const entry = { roundNumber, drawerClientId, drawerName, word, dataUrl };
    if (existingIdx >= 0) this.drawings[existingIdx] = entry;
    else this.drawings.push(entry);
  }

  canStartVoting() {
    return this.drawings.length >= MIN_DRAWINGS_TO_VOTE;
  }

  startVoting() {
    this.state = 'voting';
    this.votes = new Map();
  }

  castVote(voterClientId, index) {
    const drawing = this.drawings[index];
    if (!drawing) return false;
    if (drawing.drawerClientId === voterClientId) return false;
    if (!this.players.has(voterClientId)) return false;
    this.votes.set(voterClientId, index);
    return true;
  }

  // Drawer identity is withheld so voting is judged on the art, not the artist;
  // a viewer's own drawings are excluded so they can't accidentally vote for themselves.
  votingGalleryForClient(viewerClientId) {
    return this.drawings
      .filter((d) => d.drawerClientId !== viewerClientId)
      .map((d) => ({ index: this.drawings.indexOf(d), word: d.word, dataUrl: d.dataUrl }));
  }

  tallyDrawingContest() {
    if (this.drawings.length === 0) return null;
    const counts = new Map();
    for (const idx of this.votes.values()) counts.set(idx, (counts.get(idx) || 0) + 1);
    let winners = [];
    let topCount = 0;
    this.drawings.forEach((d, i) => {
      const count = counts.get(i) || 0;
      if (count > topCount) { topCount = count; winners = [i]; }
      else if (count === topCount && topCount > 0) winners.push(i);
    });
    if (winners.length === 0) return null;
    const winnerIndex = winners[crypto.randomInt(winners.length)];
    const winner = this.drawings[winnerIndex];
    return {
      drawerClientId: winner.drawerClientId,
      drawerName: winner.drawerName,
      word: winner.word,
      dataUrl: winner.dataUrl,
      votes: topCount,
      tied: winners.length > 1,
    };
  }

  finalScores() {
    return [...this.players.values()]
      .map((p) => ({ clientId: p.clientId, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);
  }

  resetForPlayAgain() {
    this.clearTimers();
    this.state = 'lobby';
    this.order = [];
    this.turnIndex = -1;
    this.roundNumber = 0;
    this.totalRounds = 0;
    this.usedPrompts.clear();
    this.currentWord = null;
    this.roundEndsAt = null;
    this.correctClientIds = new Set();
    this.correctLog = [];
    this.drawings = [];
    this.votes = new Map();
    for (const p of this.players.values()) p.score = 0;
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  createRoom() {
    const code = makeRoomCode(this.rooms);
    const room = new Room(code);
    this.rooms.set(code, room);
    return room;
  }

  getRoom(code) {
    return this.rooms.get((code || '').toUpperCase());
  }

  removeRoomIfEmpty(code) {
    const room = this.rooms.get(code);
    if (room && room.connectedPlayers.length === 0) {
      room.clearTimers();
      this.rooms.delete(code);
    }
  }
}

module.exports = { RoomManager, DEFAULT_ROUND_SECONDS, REVEAL_SECONDS, VOTING_SECONDS, isGuessCorrect };
