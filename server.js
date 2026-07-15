// Confidant — AI counsellor prototype server (Node 18+)
// Run: node server.js   then open http://localhost:3000

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDbEnabled, loadHistory, saveMessage, clearSession } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- tiny .env loader (no dotenv dependency) ---
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const PORT = process.env.PORT || 3000;
const PROVIDER = process.env.PROVIDER || "gemini";
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "system-prompt.txt"), "utf8");
const MAX_TURNS = 200; // cap history length sent to the AI

// --- provider fallback chain: try each "brain" in order until one answers ---
const KEY_VAR = {
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  claude: "ANTHROPIC_API_KEY",
};

async function loadProviders() {
  // If PROVIDER=claude, use only Claude. Otherwise use every free brain we have a key for.
  const names = PROVIDER === "claude" ? ["claude"] : ["gemini", "groq"];
  const chain = [];
  for (const name of names) {
    if (!process.env[KEY_VAR[name]]) continue;
    const { streamReply } = await import(`./providers/${name}.js`);
    chain.push({ name, streamReply });
  }
  return chain;
}

const providers = await loadProviders();

// --- conversation storage: Supabase if configured, else in-memory (prototype) ---
const memSessions = new Map(); // sessionId -> [{role, text}]

async function getHistory(sessionId) {
  if (isDbEnabled()) return await loadHistory(sessionId);
  return (memSessions.get(sessionId) || []).slice();
}

async function addMessage(sessionId, role, text) {
  if (isDbEnabled()) return await saveMessage(sessionId, role, text);
  if (!memSessions.has(sessionId)) memSessions.set(sessionId, []);
  const arr = memSessions.get(sessionId);
  arr.push({ role, text });
  while (arr.length > MAX_TURNS) arr.shift();
}

async function resetSession(sessionId) {
  if (isDbEnabled()) return await clearSession(sessionId);
  memSessions.delete(sessionId);
}

// --- crisis keyword check (belt-and-suspenders alongside the system prompt) ---
const CRISIS_PATTERNS = [
  /suicid/i, /kill (myself|me)/i, /end (my|it all)/i, /want to die/i,
  /don'?t want to (live|be alive)/i, /hurt (myself|someone)/i, /self.?harm/i,
  /no reason to live/i, /overdose/i,
];
const looksLikeCrisis = (text) => CRISIS_PATTERNS.some((p) => p.test(text));

// --- demo mode: lets you see the UI working before you have an API key ---
const DEMO_REPLY =
  "Hello, I'm Ms Ilona. Right now I'm running in demo mode because no API key is set up yet — " +
  "add your free Gemini key to the .env file (see README.md) and restart the server, " +
  "and I'll be able to really talk with you.";

function hasApiKey() {
  return providers.length > 0;
}

const server = http.createServer(async (req, res) => {
  // GET /api/history?sessionId=... -> past messages so the page can restore them
  if (req.method === "GET" && req.url.startsWith("/api/history")) {
    const sessionId = new URL(req.url, `http://localhost`).searchParams.get("sessionId");
    let messages = [];
    if (sessionId) {
      try {
        messages = await getHistory(sessionId);
      } catch (err) {
        console.error("[history load]", err.message);
      }
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(JSON.stringify(messages));
    return;
  }

  // POST /api/chat  { sessionId, message } -> streamed plain-text reply
  if (req.method === "POST" && req.url === "/api/chat") {
    let raw = "";
    for await (const chunk of req) raw += chunk;

    let sessionId, message;
    try {
      ({ sessionId, message } = JSON.parse(raw));
      if (!sessionId || typeof message !== "string" || !message.trim()) throw new Error();
    } catch {
      res.writeHead(400).end("Bad request");
      return;
    }
    message = message.trim().slice(0, 4000);

    // Load prior turns, then build the history we send to the AI.
    let history;
    try {
      history = await getHistory(sessionId);
    } catch (err) {
      console.error("[history load]", err.message);
      history = [];
    }
    history.push({ role: "user", text: message });
    const forAI = history.slice(-MAX_TURNS);

    // Save the user's message right away so nothing is lost.
    try {
      await addMessage(sessionId, "user", message);
    } catch (err) {
      console.error("[save user]", err.message);
    }

    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Crisis": looksLikeCrisis(message) ? "1" : "0",
    });

    if (!hasApiKey()) {
      res.end(DEMO_REPLY);
      try { await addMessage(sessionId, "assistant", DEMO_REPLY); } catch {}
      return;
    }

    let reply = "";
    let answered = false;
    for (const provider of providers) {
      try {
        for await (const text of provider.streamReply({ system: SYSTEM_PROMPT, history: forAI })) {
          reply += text;
          res.write(text);
        }
        answered = true;
        break; // this brain answered — stop here
      } catch (err) {
        console.error(`[chat error] ${provider.name}:`, err.message);
        // If this brain already streamed some text before failing, we can't
        // cleanly switch to another — stop and let the user resend.
        if (reply !== "") break;
        // Otherwise fall through and try the next brain in the chain.
      }
    }

    if (answered) {
      try {
        await addMessage(sessionId, "assistant", reply);
      } catch (err) {
        console.error("[save assistant]", err.message);
      }
    } else if (!reply) {
      res.write(
        "I'm so sorry — I'm having a little trouble connecting right now. " +
        "It's not you, and nothing you wrote was lost on my end. " +
        "Give it a few seconds and send your message again?"
      );
    }
    res.end();
    return;
  }

  // POST /api/reset  { sessionId } -> clears the conversation
  if (req.method === "POST" && req.url === "/api/reset") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const { sessionId } = JSON.parse(raw);
      if (sessionId) await resetSession(sessionId);
    } catch (err) {
      console.error("[reset]", err.message);
    }
    res.writeHead(204).end();
    return;
  }

  // --- static files from ./public ---
  const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const safe = path.normalize(urlPath).replace(/^([.][.][/\\])+/, "");
  const filePath = path.join(__dirname, "public", safe);
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403).end();
    return;
  }
  const types = {
    ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end("Not found");
    } else {
      res.writeHead(200, {
        "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-cache", // always revalidate so updates show on refresh
      });
      res.end(data);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Confidant running at http://localhost:${PORT}`);
  console.log(`Storage: ${isDbEnabled() ? "Supabase (persistent)" : "in-memory (resets on restart)"}`);
  if (providers.length) {
    console.log(`Brains (in fallback order): ${providers.map((p) => p.name).join(" -> ")}`);
  } else {
    console.log("No API key found — running in demo mode. See README.md.");
  }
});
