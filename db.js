// db.js — conversation persistence via Supabase (Postgres REST API, no dependencies).
// If SUPABASE_URL + SUPABASE_SERVICE_KEY are set, conversations are saved to the
// database and survive restarts. If not, server.js falls back to in-memory storage.
//
// NOTE: read the env vars lazily (inside functions), not at import time — server.js
// loads the .env file AFTER this module is imported, so reading them at the top level
// would always see them as empty.

const url = () => process.env.SUPABASE_URL;          // e.g. https://abcxyz.supabase.co
const key = () => process.env.SUPABASE_SERVICE_KEY;  // the service_role / secret key

export const isDbEnabled = () => Boolean(url() && key());

const endpoint = () => `${url()}/rest/v1/messages`;
const headers = (extra = {}) => ({
  apikey: key(),
  Authorization: `Bearer ${key()}`,
  "Content-Type": "application/json",
  ...extra,
});

// Return prior turns for a session, oldest first: [{ role, text }, ...]
export async function loadHistory(sessionId) {
  const target = `${endpoint()}?session_id=eq.${encodeURIComponent(sessionId)}&order=id.asc&select=role,text`;
  const res = await fetch(target, { headers: headers() });
  if (!res.ok) throw new Error(`Supabase load ${res.status}: ${await res.text()}`);
  return await res.json();
}

// Append one message to a session's history.
export async function saveMessage(sessionId, role, text) {
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: headers({ Prefer: "return=minimal" }),
    body: JSON.stringify({ session_id: sessionId, role, text }),
  });
  if (!res.ok) throw new Error(`Supabase save ${res.status}: ${await res.text()}`);
}

// Delete a session's entire history (used by "New conversation").
export async function clearSession(sessionId) {
  const target = `${endpoint()}?session_id=eq.${encodeURIComponent(sessionId)}`;
  const res = await fetch(target, { method: "DELETE", headers: headers() });
  if (!res.ok) throw new Error(`Supabase clear ${res.status}: ${await res.text()}`);
}
