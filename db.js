// db.js — conversation persistence via Supabase (Postgres REST API, no dependencies).
// Conversations are keyed by user_id (a real logged-in account) so a person's
// history follows them across devices. Reads env lazily (server.js loads .env
// after this module is imported).

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

// Return prior turns for a user, oldest first: [{ role, text }, ...]
export async function loadHistory(userId) {
  const target = `${endpoint()}?user_id=eq.${encodeURIComponent(userId)}&order=id.asc&select=role,text`;
  const res = await fetch(target, { headers: headers() });
  if (!res.ok) throw new Error(`Supabase load ${res.status}: ${await res.text()}`);
  return await res.json();
}

// Append one message to a user's history.
export async function saveMessage(userId, role, text) {
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: headers({ Prefer: "return=minimal" }),
    body: JSON.stringify({ user_id: userId, role, text }),
  });
  if (!res.ok) throw new Error(`Supabase save ${res.status}: ${await res.text()}`);
}

// Delete a user's entire history (used by "New conversation").
export async function clearSession(userId) {
  const target = `${endpoint()}?user_id=eq.${encodeURIComponent(userId)}`;
  const res = await fetch(target, { method: "DELETE", headers: headers() });
  if (!res.ok) throw new Error(`Supabase clear ${res.status}: ${await res.text()}`);
}
