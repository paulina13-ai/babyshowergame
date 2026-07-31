# 🍼 Banch (B)irtual Baby Shower Pictionary

A silly, collaborative drawing game built for a baby shower video call. Everyone
joins from their own phone/laptop with a room code (Jackbox-style) — one person
draws a silly baby-themed prompt while everyone else watches the canvas update
live and types (or shouts) their guesses. First one right wins the points.

## How it works

- One person **creates a room** and shares the 4-letter room code with the
  group (say it out loud on the call, or drop it in chat).
- Everyone else **joins** with that code and their name, from their own
  device.
- The host picks how many rounds per player and how long each round is, then
  starts the game.
- Each round, one player gets a secret prompt (e.g. "diaper blowout" or
  "3am zombie feeding") and draws it live — with no way to undo or clear it,
  so mistakes stay on screen and become part of the fun. Everyone else sees
  the canvas update in real time.
- Guessers **type their guess** in a box on their screen (typos and close
  wording are forgiven) — first correct guess scores the most points, with
  fewer points the longer it takes. Shouting it out on the call still works
  too: the drawer can manually tap a player's name to award them credit.
- The drawer also earns a bonus for every correct guesser.
- After everyone's had a turn, the final scoreboard decides the winner.

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
call can join from their own devices. [Render](https://render.com) has a free
web service tier that needs no credit card and supports WebSockets, which this
app needs — the included `render.yaml` blueprint lets Render auto-detect the
build/start commands, so deploying is just "New → Blueprint → pick this repo".

Note: a free Render service spins down after 15 minutes of no traffic, so the
first visit after a while takes ~30-60 seconds to wake up — open the link a
couple of minutes before your call starts.

Share the deployed URL + the room code at the start of the call.

No database is used — everything lives in server memory, which is perfect
for a one-off party game (just don't restart the server mid-game).

## Tech

Plain Node.js + Express + Socket.IO on the backend, vanilla HTML/CSS/JS with
an HTML5 canvas on the frontend. No build step, no framework — easy to tweak
the prompt list (`server/prompts.js`) or the look (`public/styles.css`)
before the big day.
