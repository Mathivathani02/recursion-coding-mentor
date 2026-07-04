# Recursion — Coding Mentor Agent

A full-stack coding mentor agent for a college project.

- **Frontend:** HTML, CSS, JavaScript (blueprint/annotation themed chat UI)
- **Backend / web framework:** Node.js + Express
- **LLM API:** Groq (OpenAI-compatible `chat/completions`, model `openai/gpt-oss-120b`)
- **Prompt engineering:** a dedicated system prompt makes the model behave like a mentor
  (explains reasoning, not just fixes) instead of a generic chatbot
- **Database:** SQLite, via Node's built-in `node:sqlite` module — every question and
  mentor reply is logged with a session id. No external DB server, no npm install for
  the database layer.

## Setup (VS Code)

1. Open this folder in VS Code.
2. Terminal → New Terminal, then:
   ```
   npm install
   ```
3. Get a free Groq API key: go to https://console.groq.com/keys, sign in, click
   "Create API Key". It looks like `gsk_...`.
4. Open `.env` and paste it:
   ```
   GROQ_API_KEY=gsk_your_actual_key_here
   ```
5. Start the server:
   ```
   npm start
   ```
6. Open http://localhost:3000 in your browser.

**Node version:** you need Node.js 22.13+ for the built-in SQLite module. Check with
`node --version`. If you're on an older version, download the latest LTS from
https://nodejs.org.

## How it works

- `server.js` — Express server. Serves the frontend, and exposes:
  - `POST /api/mentor` — forwards the conversation to Groq and returns the mentor's
    reply; logs both the question and the reply into a local SQLite file (`mentor.db`).
  - `GET /api/stats` — total messages ever logged (shown live in the UI header).
  - `GET /api/history?sessionId=...` — full stored conversation for a session.
- `public/index.html` — the UI. Paste code, use the quick actions
  (Explain / Find bugs / Optimize / Review style), or chat with the mentor directly.
  Each browser tab gets a random session id used to group its messages in the database.
- `mentor.db` — created automatically on first run, in the project folder.

## Project checklist mapping

- ✅ Unique individual project — AI coding mentor agent
- ✅ Language of choice — JavaScript (Node.js/Express backend + vanilla JS frontend)
- ✅ Prompt engineering — dedicated mentor system prompt in `server.js`
- ✅ LLM API integration — Groq
- ✅ Database — SQLite (`node:sqlite`), logs every conversation turn
- ✅ Web framework — Express
- ✅ Frontend — HTML/CSS/JavaScript

## Troubleshooting

- **"GROQ_API_KEY missing"** — set the key in `.env`, then restart (`npm start`).
- **"Couldn't reach the server"** in the browser — the Node server isn't running, or you
  opened `index.html` directly as a file instead of via `http://localhost:3000`.
- **401 from Groq** — double check you copied the full key from
  https://console.groq.com/keys.
- **`node:sqlite` error / "No such built-in module"** — your Node version is too old.
  Update to Node 22.13+ from https://nodejs.org and re-run `npm start`.
