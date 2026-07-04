import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'openai/gpt-oss-120b'; // fast, current production model on Groq

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Retries transient network failures (e.g. "fetch failed" / socket resets that
// some Windows setups hit on flaky wifi, VPNs, or antivirus SSL inspection).
async function fetchWithRetry(url, options, retries = 3, baseDelayMs = 800) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
            try {
                const res = await fetch(url, { ...options, signal: controller.signal });
                clearTimeout(timeout);
                return res;
            } catch (err) {
                clearTimeout(timeout);
                throw err;
            }
        } catch (err) {
            console.warn(`Groq request attempt ${attempt}/${retries} failed: ${err.message}`);
            if (attempt === retries) throw err;
            await new Promise(r => setTimeout(r, baseDelayMs * attempt));
        }
    }
}

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Database (built into Node.js, no npm install needed) ----------
const db = new DatabaseSync(path.join(__dirname, 'mentor.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Migration-safe: add columns used by the progress dashboard if they don't exist yet
try { db.exec(`ALTER TABLE conversations ADD COLUMN action TEXT`); } catch (e) {}
try { db.exec(`ALTER TABLE conversations ADD COLUMN language TEXT`); } catch (e) {}

const insertMessage = db.prepare(
  `INSERT INTO conversations (session_id, role, content, action, language) VALUES (?, ?, ?, ?, ?)`
);
const countAll = db.prepare(`SELECT COUNT(*) AS total FROM conversations`);
const historyForSession = db.prepare(
  `SELECT role, content, created_at FROM conversations WHERE session_id = ? ORDER BY id ASC`
);

// ---------- Saved snippets (persisted fixed/corrected code) ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS saved_snippets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    title TEXT,
    code TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);
const insertSnippet = db.prepare(
  `INSERT INTO saved_snippets (session_id, title, code) VALUES (?, ?, ?)`
);
const snippetsForSession = db.prepare(
  `SELECT id, title, code, created_at FROM saved_snippets WHERE session_id = ? ORDER BY id DESC`
);
const deleteSnippet = db.prepare(
  `DELETE FROM saved_snippets WHERE id = ? AND session_id = ?`
);

// ---------- Mentor system prompt (Prompt Engineering) ----------
const SYSTEM_PROMPT = `You are Recursion, a patient and encouraging coding mentor. You do not just hand over fixed code — you teach.
Rules:
- Explain the reasoning behind bugs and suggestions, not just the fix.
- When reviewing code, be specific: reference line-level logic, not vague generalities.
- Use short paragraphs. Use code blocks (triple backticks) only when showing a snippet, keep snippets minimal and focused.
- Be encouraging but honest — point out real issues clearly.
- If the user's message is a general question with no code, answer as a mentor teaching a concept, with a short example if useful.
- Keep responses focused and not overly long — a mentor gives a clear, digestible answer, not an essay.`;

// ---------- Mentor endpoint ----------
app.post('/api/mentor', async (req, res) => {
    try {
        if (!GROQ_API_KEY) {
            return res.status(500).json({
                success: false,
                error: "GROQ_API_KEY missing. Add it to your .env file before starting the server."
            });
        }

        const { messages, sessionId, action, language } = req.body;

        if (!Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ success: false, error: "No conversation messages received." });
        }
        if (!sessionId) {
            return res.status(400).json({ success: false, error: "Missing sessionId." });
        }

        // Log the latest user message to the database (tagged with action + language for the progress dashboard)
        const lastUserMsg = messages[messages.length - 1];
        insertMessage.run(sessionId, lastUserMsg.role, lastUserMsg.content, action || 'chat', language || null);

        // Only send recent turns to Groq — sending the *entire* growing history on every
        // request is what was blowing past the free tier's per-minute token limit.
        const MAX_HISTORY_MESSAGES = 8;
        const trimmedMessages = messages.length > MAX_HISTORY_MESSAGES
            ? messages.slice(-MAX_HISTORY_MESSAGES)
            : messages;

        function extractRetryDelayMs(errorMessage) {
            const match = /try again in ([\d.]+)s/i.exec(errorMessage || '');
            if (match) return Math.ceil(parseFloat(match[1]) * 1000) + 300;
            return 4000;
        }

        async function callGroq() {
            const r = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${GROQ_API_KEY}`
                },
                body: JSON.stringify({
                    model: GROQ_MODEL,
                    messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...trimmedMessages],
                    max_completion_tokens: 1000
                })
            });
            const body = await r.json();
            return { ok: r.ok, status: r.status, body };
        }

        let groqRes;
        try {
            groqRes = await callGroq();
            // Free tier rate limit: wait the suggested time and retry once automatically
            if (!groqRes.ok && groqRes.status === 429) {
                const waitMs = extractRetryDelayMs(groqRes.body?.error?.message);
                console.warn(`Rate limited by Groq — waiting ${waitMs}ms before one retry.`);
                await new Promise(r => setTimeout(r, waitMs));
                groqRes = await callGroq();
            }
        } catch (networkErr) {
            console.error("Groq network error after retries:", networkErr);
            return res.status(502).json({
                success: false,
                error: "Couldn't reach Groq after several attempts. Check your internet connection (or try disabling VPN/antivirus SSL scanning) and try again."
            });
        }

        const data = groqRes.body;

        if (!groqRes.ok) {
            console.error("Groq API error:", data);
            const message = groqRes.status === 429
                ? "Groq's free-tier rate limit is still cooling down — wait about 10 seconds and try again."
                : (data?.error?.message || "Groq API request failed.");
            return res.status(groqRes.status).json({ success: false, error: message });
        }

        const reply = data?.choices?.[0]?.message?.content?.trim();

        if (!reply) {
            return res.json({
                success: true,
                reply: "I couldn't generate a response for that. Try rephrasing your question or check your code snippet."
            });
        }

        // Log the mentor's reply to the database
        insertMessage.run(sessionId, 'assistant', reply, action || 'chat', language || null);

        return res.json({ success: true, reply });

    } catch (err) {
        console.error("Mentor endpoint error:", err);
        return res.status(500).json({ success: false, error: "Server error while reaching the mentor engine." });
    }
});

// ---------- Database-backed stats & history endpoints ----------
app.get('/api/insights', (req, res) => {
    try {
        const { sessionId } = req.query;
        if (!sessionId) return res.status(400).json({ success: false, error: "Missing sessionId." });

        const total = db.prepare(
            `SELECT COUNT(*) AS total FROM conversations WHERE session_id = ? AND role = 'user'`
        ).get(sessionId).total;

        const byAction = db.prepare(
            `SELECT COALESCE(action, 'chat') AS action, COUNT(*) AS count
             FROM conversations WHERE session_id = ? AND role = 'user'
             GROUP BY action ORDER BY count DESC`
        ).all(sessionId);

        const topLanguage = db.prepare(
            `SELECT language, COUNT(*) AS count
             FROM conversations WHERE session_id = ? AND role = 'user'
               AND language IS NOT NULL AND language != '' AND language != 'auto'
             GROUP BY language ORDER BY count DESC LIMIT 1`
        ).get(sessionId);

        res.json({
            success: true,
            total,
            byAction,
            topLanguage: topLanguage ? topLanguage.language : null
        });
    } catch (err) {
        console.error("Insights endpoint error:", err);
        res.status(500).json({ success: false, error: "Could not compute insights." });
    }
});

app.get('/api/stats', (req, res) => {
    try {
        const { total } = countAll.get();
        res.json({ success: true, total });
    } catch (err) {
        res.status(500).json({ success: false, error: "Could not read stats." });
    }
});

app.get('/api/history', (req, res) => {
    try {
        const { sessionId } = req.query;
        if (!sessionId) return res.status(400).json({ success: false, error: "Missing sessionId." });
        const rows = historyForSession.all(sessionId);
        res.json({ success: true, history: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: "Could not read history." });
    }
});

// ---------- Saved snippets endpoints ----------
app.post('/api/snippets', (req, res) => {
    try {
        const { sessionId, title, code } = req.body;
        if (!sessionId || !code || !code.trim()) {
            return res.status(400).json({ success: false, error: "Missing sessionId or code." });
        }
        const result = insertSnippet.run(sessionId, title || 'Untitled snippet', code);
        res.json({ success: true, id: Number(result.lastInsertRowid) });
    } catch (err) {
        console.error("Save snippet error:", err);
        res.status(500).json({ success: false, error: "Could not save snippet." });
    }
});

app.get('/api/snippets', (req, res) => {
    try {
        const { sessionId } = req.query;
        if (!sessionId) return res.status(400).json({ success: false, error: "Missing sessionId." });
        const rows = snippetsForSession.all(sessionId);
        res.json({ success: true, snippets: rows });
    } catch (err) {
        res.status(500).json({ success: false, error: "Could not read snippets." });
    }
});

app.delete('/api/snippets/:id', (req, res) => {
    try {
        const { sessionId } = req.body;
        if (!sessionId) return res.status(400).json({ success: false, error: "Missing sessionId." });
        deleteSnippet.run(Number(req.params.id), sessionId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: "Could not delete snippet." });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Recursion mentor server running on http://localhost:${PORT}`);
    if (!GROQ_API_KEY) {
        console.warn("⚠️  GROQ_API_KEY is not set. Add it to a .env file: GROQ_API_KEY=your_key_here");
    }
});
