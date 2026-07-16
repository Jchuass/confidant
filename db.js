// db.js — persistence via Supabase (Postgres REST API, no dependencies).
// Each user has many conversations; each conversation has many messages.
// Everything is scoped to the logged-in user_id so people only touch their own.

const url = () => process.env.SUPABASE_URL;          // https://xxx.supabase.co
const key = () => process.env.SUPABASE_SERVICE_KEY;  // service_role / secret key
const enc = encodeURIComponent;

export const isDbEnabled = () => Boolean(url() && key());

const rest = (table) => `${url()}/rest/v1/${table}`;
const headers = (extra = {}) => ({
  apikey: key(),
  Authorization: `Bearer ${key()}`,
  "Content-Type": "application/json",
  ...extra,
});

async function req(method, target, body, extraHeaders) {
  const opts = { method, headers: headers(extraHeaders) };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(target, opts);
  if (!res.ok) throw new Error(`Supabase ${method} ${res.status}: ${await res.text()}`);
  return res;
}

// ---- Conversations ----
export async function listConversations(userId) {
  const t = `${rest("conversations")}?user_id=eq.${enc(userId)}&order=updated_at.desc&select=id,title,updated_at`;
  return (await req("GET", t)).json();
}

export async function createConversation(userId, title = null) {
  const res = await req("POST", rest("conversations"), { user_id: userId, title }, { Prefer: "return=representation" });
  return (await res.json())[0];
}

// Returns the conversation row if it belongs to the user, else null (ownership check).
export async function getConversation(userId, convId) {
  const t = `${rest("conversations")}?id=eq.${enc(convId)}&user_id=eq.${enc(userId)}&select=id,title`;
  return (await (await req("GET", t)).json())[0] || null;
}

export async function updateConversation(userId, convId, fields) {
  const t = `${rest("conversations")}?id=eq.${enc(convId)}&user_id=eq.${enc(userId)}`;
  await req("PATCH", t, fields, { Prefer: "return=minimal" });
}

export async function deleteConversation(userId, convId) {
  await req("DELETE", `${rest("messages")}?conversation_id=eq.${enc(convId)}&user_id=eq.${enc(userId)}`, undefined, { Prefer: "return=minimal" });
  await req("DELETE", `${rest("conversations")}?id=eq.${enc(convId)}&user_id=eq.${enc(userId)}`, undefined, { Prefer: "return=minimal" });
}

// ---- Messages (within a conversation) ----
export async function loadHistory(userId, convId) {
  const t = `${rest("messages")}?conversation_id=eq.${enc(convId)}&user_id=eq.${enc(userId)}&order=id.asc&select=role,text`;
  return (await req("GET", t)).json();
}

export async function saveMessage(userId, convId, role, text) {
  await req("POST", rest("messages"), { user_id: userId, conversation_id: convId, role, text }, { Prefer: "return=minimal" });
}
