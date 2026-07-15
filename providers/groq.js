// Groq provider — free-tier backup brain from a different company than Google,
// so Ms Ilona keeps working even if all Gemini models are down.
// Get a free key at https://console.groq.com/keys

const MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

export async function* streamReply({ system, history }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY is not set. See README.md for setup.");

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      max_tokens: 1024,
      messages: [
        { role: "system", content: system },
        ...history.map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.text,
        })),
      ],
    }),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const err = await res.json();
      detail = err?.error?.message || "";
    } catch {}
    throw new Error(`Groq API error ${res.status}: ${detail}`);
  }

  // Parse the SSE stream: lines of `data: {...json...}`, ending with `data: [DONE]`
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const data = JSON.parse(payload);
        const text = data?.choices?.[0]?.delta?.content;
        if (text) yield text;
      } catch {
        // ignore malformed keep-alive lines
      }
    }
  }
}
