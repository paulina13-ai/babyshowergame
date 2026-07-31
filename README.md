# 🍼 Baby Shower Pictionary

A silly, collaborative drawing game built for a baby shower video call. Everyone
joins from their own phone/laptop with a room code (Jackbox-style) — one person
draws a silly baby-themed prompt while everyone else watches the canvas update
live and shouts their guesses out loud over the call. The drawer taps a
guesser's name to award them points when they get it right.

## How it works

- One person **creates a room** and shares the 4-letter room code with the
  group (say it out loud on the call, or drop it in chat).
- Everyone else **joins** with that code and their name, from their own
  device.
- The host picks how many rounds per player and how long each round is, then
  starts the game.
- Each round, one player gets a secret prompt (e.g. "diaper blowout" or
  "3am zombie feeding") and draws it live. Everyone else sees the canvas
  update in real time and yells out guesses on the call.
- When someone gets it, the **drawer taps that player's name** in the list to
  award them points (faster guesses = more points). The drawer also earns a
  bonus for every correct guesser.
- After everyone's had a turn, the final scoreboard decides the winner.

No typing guesses, no chat spam — the video call is already the guessing
channel, so the app just handles the shared canvas, the prompts, the timer,
and the scorekeeping.

## Running it locally

```bash
npm install
npm start
```

Then open `http://localhost:3000` in a browser. To test multiplayer locally,
open the same URL in a few browser tabs (or on your phone over the same
Wi-Fi using your computer's local IP, e.g. `http://192.168.1.23:3000`).

## Playing it during the actual shower

You'll want the app reachable over the internet so remote guests on the video
call can join from their own devices. The easiest options:

- **Deploy for free** to a host like [Render](https://render.com),
  [Railway](https://railway.app), or [Fly.io](https://fly.io) — all support
  plain Node.js + WebSocket apps out of the box. Point them at this repo,
  set the start command to `npm start`, and you'll get a public URL.
- Share that URL + the room code at the start of the call.

No database is used — everything lives in server memory, which is perfect
for a one-off party game (just don't restart the server mid-game).

## Tech

Plain Node.js + Express + Socket.IO on the backend, vanilla HTML/CSS/JS with
an HTML5 canvas on the frontend. No build step, no framework — easy to tweak
the prompt list (`server/prompts.js`) or the look (`public/styles.css`)
before the big day.
