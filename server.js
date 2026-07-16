// Confidant — AI counsellor prototype server (Node 18+)
// Run: node server.js   then open http://localhost:3000

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isDbEnabled, loadHistory, saveMessage,
  listConversations, createConversation, getConversation, updateConversation, deleteConversation,
} from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Keep the server alive if an unexpected error slips through (e.g. a network
// blip talking to Supabase) — log it instead of crashing the whole app.
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

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

// Storage is Supabase-backed (reaching chat requires being logged in, which
// requires Supabase Auth — so the database is always configured here).

// Turn the first user message into a short conversation title.
function titleFrom(message) {
  const clean = message.replace(/\s+/g, " ").trim();
  return clean.length > 40 ? clean.slice(0, 40) + "…" : clean || "New conversation";
}

// ---------------------------------------------------------------------------
// Authentication via Supabase Auth (GoTrue) — the server talks to Supabase so
// the browser never handles keys directly. Sessions live in HttpOnly cookies.
// ---------------------------------------------------------------------------
const SUPA_URL = () => process.env.SUPABASE_URL;
const SUPA_ANON = () => process.env.SUPABASE_ANON_KEY;
const authEnabled = () => Boolean(SUPA_URL() && SUPA_ANON());

async function supaAuth(pathAndQuery, body) {
  const res = await fetch(`${SUPA_URL()}/auth/v1/${pathAndQuery}`, {
    method: "POST",
    headers: { apikey: SUPA_ANON(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// Update the logged-in (or password-recovery) user, e.g. set a new password.
async function supaUpdateUser(accessToken, body) {
  const res = await fetch(`${SUPA_URL()}/auth/v1/user`, {
    method: "PUT",
    headers: {
      apikey: SUPA_ANON(),
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function friendlyAuthError(data) {
  const raw = data.error_description || data.msg || data.message || data.error || "";
  if (/already registered/i.test(raw)) return "There's already an account with that email — try logging in instead.";
  if (/invalid login|invalid grant|credentials/i.test(raw)) return "That email or password doesn't match. Please try again.";
  if (/password.*(6|characters|short)/i.test(raw)) return "Password must be at least 6 characters.";
  if (/email.*invalid|valid email/i.test(raw)) return "Please enter a valid email address.";
  return raw || "Something went wrong. Please try again.";
}

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookies(res, session) {
  const common = "HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000"; // 30 days
  res.setHeader("Set-Cookie", [
    `sb_access=${session.access_token}; ${common}`,
    `sb_refresh=${session.refresh_token}; ${common}`,
  ]);
}

function clearSessionCookies(res) {
  const expired = "HttpOnly; Path=/; SameSite=Lax; Max-Age=0";
  res.setHeader("Set-Cookie", [`sb_access=; ${expired}`, `sb_refresh=; ${expired}`]);
}

// Resolve the logged-in user for a request. Refreshes the token if expired
// (which sets new cookies on `res`). Returns { id, email } or null.
// MUST be called before res.writeHead (it may setHeader).
async function getUser(req, res) {
  const cookies = parseCookies(req);
  const access = cookies.sb_access;
  const refresh = cookies.sb_refresh;
  const now = Math.floor(Date.now() / 1000);

  const payload = access ? decodeJwt(access) : null;
  if (payload && payload.exp && payload.exp > now + 5) {
    return { id: payload.sub, email: payload.email };
  }
  if (refresh) {
    const { ok, data } = await supaAuth("token?grant_type=refresh_token", { refresh_token: refresh });
    if (ok && data.access_token) {
      setSessionCookies(res, data);
      const p = decodeJwt(data.access_token);
      if (p) return { id: p.sub, email: p.email };
    }
  }
  return null;
}

// --- crisis keyword check (belt-and-suspenders alongside the system prompt) ---
const CRISIS_PATTERNS = [
  /suicid/i, /kill (myself|me)/i, /end (my|it all)/i, /want to die/i,
  /don'?t want to (live|be alive)/i, /hurt (myself|someone)/i, /self.?harm/i,
  /no reason to live/i, /overdose/i,
];
const looksLikeCrisis = (text) => CRISIS_PATTERNS.some((p) => p.test(text));

const DEMO_REPLY =
  "Hello, I'm Ms Ilona. Right now I'm running in demo mode because no AI key is set up yet — " +
  "add your free Gemini key to the .env file (see README.md) and restart the server.";

function hasApiKey() {
  return providers.length > 0;
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw);
}

const server = http.createServer(async (req, res) => {
  // --- Auth: sign up ---
  if (req.method === "POST" && req.url === "/api/signup") {
    if (!authEnabled()) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Accounts aren't set up yet. Add SUPABASE_ANON_KEY to the server." })); }
    let email, password, agreed;
    try { ({ email, password, agreed } = await readJson(req)); } catch { res.writeHead(400).end("Bad request"); return; }
    if (!agreed) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Please tick the box to agree before creating an account." })); }
    // Record the consent (timestamped) in the user's account for our records.
    const { ok, data } = await supaAuth("signup", {
      email,
      password,
      data: { agreed_to_terms: true, agreed_at: new Date().toISOString() },
    });
    // Set cookies (via setHeader) BEFORE writeHead, or Node throws headers-sent.
    let body;
    if (!ok) body = { error: friendlyAuthError(data) };
    else if (data.access_token) { setSessionCookies(res, data); body = { ok: true, email }; }
    else body = { ok: true, needsConfirmation: true }; // email confirmation on
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  // --- Auth: request a password-reset email ---
  if (req.method === "POST" && req.url === "/api/forgot") {
    let email;
    try { ({ email } = await readJson(req)); } catch { res.writeHead(400).end("Bad request"); return; }
    if (authEnabled() && email) {
      const proto = req.headers["x-forwarded-proto"] || "http";
      const redirectTo = `${proto}://${req.headers.host}`;
      // Don't await the result closely / don't reveal whether the email exists.
      await supaAuth(`recover?redirect_to=${encodeURIComponent(redirectTo)}`, { email }).catch(() => {});
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- Auth: set a new password using a recovery token from the email link ---
  if (req.method === "POST" && req.url === "/api/reset-password") {
    let access_token, password;
    try { ({ access_token, password } = await readJson(req)); } catch { res.writeHead(400).end("Bad request"); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    if (!access_token || !password) return res.end(JSON.stringify({ error: "Missing information — please use the link from your email again." }));
    const { ok, data } = await supaUpdateUser(access_token, { password });
    if (!ok) return res.end(JSON.stringify({ error: friendlyAuthError(data) }));
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- Auth: log in ---
  if (req.method === "POST" && req.url === "/api/login") {
    if (!authEnabled()) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "Accounts aren't set up yet." })); }
    let email, password;
    try { ({ email, password } = await readJson(req)); } catch { res.writeHead(400).end("Bad request"); return; }
    const { ok, data } = await supaAuth("token?grant_type=password", { email, password });
    // Set cookies (via setHeader) BEFORE writeHead, or Node throws headers-sent.
    let body;
    if (!ok || !data.access_token) body = { error: friendlyAuthError(data) };
    else { setSessionCookies(res, data); body = { ok: true, email: data.user?.email || email }; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  // --- Auth: start "Continue with Google" (redirect to Supabase → Google) ---
  if (req.method === "GET" && req.url === "/api/oauth/google") {
    if (!authEnabled()) { res.writeHead(302, { Location: "/" }); return res.end(); }
    const proto = req.headers["x-forwarded-proto"] || "http";
    const origin = `${proto}://${req.headers.host}`;
    const target = `${SUPA_URL()}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(origin)}`;
    res.writeHead(302, { Location: target });
    res.end();
    return;
  }

  // --- Auth: establish a cookie session from OAuth tokens (from the URL hash) ---
  if (req.method === "POST" && req.url === "/api/session") {
    let access_token, refresh_token;
    try { ({ access_token, refresh_token } = await readJson(req)); } catch { res.writeHead(400).end("Bad request"); return; }
    // Verify the token is genuine by asking Supabase who it belongs to.
    let user = null;
    if (access_token) {
      try {
        const r = await fetch(`${SUPA_URL()}/auth/v1/user`, {
          headers: { apikey: SUPA_ANON(), Authorization: `Bearer ${access_token}` },
        });
        if (r.ok) user = await r.json();
      } catch {}
    }
    let body;
    if (user && user.id) { setSessionCookies(res, { access_token, refresh_token }); body = { ok: true, email: user.email }; }
    else body = { error: "Could not verify sign-in. Please try again." };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }

  // --- Auth: log out ---
  if (req.method === "POST" && req.url === "/api/logout") {
    clearSessionCookies(res);
    res.writeHead(204).end();
    return;
  }

  // --- Auth: who am I? ---
  if (req.method === "GET" && req.url === "/api/me") {
    const user = await getUser(req, res);
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(JSON.stringify(user ? { loggedIn: true, email: user.email } : { loggedIn: false }));
    return;
  }

  // --- List this user's conversations ---
  if (req.method === "GET" && req.url === "/api/conversations") {
    const user = await getUser(req, res);
    if (!user) { res.writeHead(401, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "not logged in" })); }
    let convs = [];
    try { convs = await listConversations(user.id); } catch (err) { console.error("[conversations list]", err.message); }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(JSON.stringify(convs));
    return;
  }

  // --- Create a new conversation ---
  if (req.method === "POST" && req.url === "/api/conversations") {
    const user = await getUser(req, res);
    if (!user) { res.writeHead(401).end(); return; }
    let conv = null;
    try { conv = await createConversation(user.id, null); } catch (err) { console.error("[conversation create]", err.message); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(conv ? { id: conv.id, title: conv.title } : { error: "Could not create conversation." }));
    return;
  }

  // --- Rename a conversation ---
  if (req.method === "POST" && req.url === "/api/conversations/rename") {
    const user = await getUser(req, res);
    if (!user) { res.writeHead(401).end(); return; }
    let id, title;
    try { ({ id, title } = await readJson(req)); } catch { res.writeHead(400).end("Bad request"); return; }
    title = (typeof title === "string" ? title.trim().slice(0, 80) : "") || "Untitled";
    try { await updateConversation(user.id, id, { title }); } catch (err) { console.error("[conversation rename]", err.message); }
    res.writeHead(204).end();
    return;
  }

  // --- Delete a conversation (and its messages) ---
  if (req.method === "POST" && req.url === "/api/conversations/delete") {
    const user = await getUser(req, res);
    if (!user) { res.writeHead(401).end(); return; }
    let id;
    try { ({ id } = await readJson(req)); } catch { res.writeHead(400).end("Bad request"); return; }
    try { await deleteConversation(user.id, id); } catch (err) { console.error("[conversation delete]", err.message); }
    res.writeHead(204).end();
    return;
  }

  // --- History for one conversation (requires login) ---
  if (req.method === "GET" && req.url.startsWith("/api/history")) {
    const user = await getUser(req, res);
    if (!user) { res.writeHead(401, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "not logged in" })); }
    const convId = new URL(req.url, "http://localhost").searchParams.get("conversationId");
    let messages = [];
    try { if (convId) messages = await loadHistory(user.id, convId); } catch (err) { console.error("[history load]", err.message); }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(JSON.stringify(messages));
    return;
  }

  // --- Chat within a conversation (requires login) ---
  if (req.method === "POST" && req.url === "/api/chat") {
    const user = await getUser(req, res);
    if (!user) { res.writeHead(401, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "not logged in" })); }

    let message, conversationId;
    try {
      ({ message, conversationId } = await readJson(req));
      if (typeof message !== "string" || !message.trim()) throw new Error();
    } catch { res.writeHead(400).end("Bad request"); return; }
    message = message.trim().slice(0, 4000);

    // Verify the conversation exists and belongs to this user.
    let conv = null;
    try { conv = await getConversation(user.id, conversationId); } catch (err) { console.error("[conversation get]", err.message); }
    if (!conv) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "conversation not found" })); }

    let history;
    try { history = await loadHistory(user.id, conversationId); } catch (err) { console.error("[history load]", err.message); history = []; }
    const isFirst = history.length === 0;
    history.push({ role: "user", text: message });
    const forAI = history.slice(-MAX_TURNS);

    try { await saveMessage(user.id, conversationId, "user", message); } catch (err) { console.error("[save user]", err.message); }
    // Bump the conversation to the top of the list, and name it from the first message.
    try {
      const fields = { updated_at: new Date().toISOString() };
      if (isFirst && (!conv.title || conv.title === "New conversation")) fields.title = titleFrom(message);
      await updateConversation(user.id, conversationId, fields);
    } catch (err) { console.error("[conversation touch]", err.message); }

    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Crisis": looksLikeCrisis(message) ? "1" : "0",
    });

    if (!hasApiKey()) {
      res.end(DEMO_REPLY);
      try { await saveMessage(user.id, conversationId, "assistant", DEMO_REPLY); } catch {}
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
        break;
      } catch (err) {
        console.error(`[chat error] ${provider.name}:`, err.message);
        if (reply !== "") break;
      }
    }

    if (answered) {
      try { await saveMessage(user.id, conversationId, "assistant", reply); } catch (err) { console.error("[save assistant]", err.message); }
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
    ".webmanifest": "application/manifest+json", ".json": "application/json",
  };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end("Not found");
    } else {
      res.writeHead(200, {
        "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(data);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Confidant running at http://localhost:${PORT}`);
  console.log(`Storage: ${isDbEnabled() ? "Supabase (persistent)" : "in-memory (resets on restart)"}`);
  console.log(`Accounts: ${authEnabled() ? "Supabase Auth (login required)" : "NOT configured — add SUPABASE_ANON_KEY"}`);
  if (providers.length) {
    console.log(`Brains (in fallback order): ${providers.map((p) => p.name).join(" -> ")}`);
  } else {
    console.log("No AI key found — running in demo mode. See README.md.");
  }
});
