// Gemini provider — uses Google's free-tier Generative Language API via plain fetch.
// Get a free key at https://aistudio.google.com/apikey
//
// Resilience: if the primary model is overloaded (503) or rate-limited (429),
// we retry briefly, then fall back to the lighter model, which usually has
// spare capacity.

// "gemini-flash-latest" always points to Google's current Flash model,
// so it keeps working when Google retires older model versions.
const MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-flash-lite-latest";
const RETRIES_PER_MODEL = 2;

export async function* streamReply({ system, history }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set. See README.md for setup.");

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.text }],
    })),
    generationConfig: { maxOutputTokens: 1024 },
  });

  const models = MODEL === FALLBACK_MODEL ? [MODEL] : [MODEL, FALLBACK_MODEL];
  let lastError;

  for (const model of models) {
    for (let attempt = 1; attempt <= RETRIES_PER_MODEL; attempt++) {
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      if (res.ok) {
        yield* parseSse(res);
        return;
      }

      let detail = "";
      try {
        const err = await res.json();
        detail = err?.error?.message || "";
      } catch {}
      lastError = new Error(`Gemini API error ${res.status} on ${model}: ${detail}`);

      // Only retry when the problem is temporary (overload / rate limit / server error)
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable) throw lastError;

      console.warn(`[gemini] ${model} attempt ${attempt} failed (${res.status}) — ${
        attempt < RETRIES_PER_MODEL ? "retrying" : "moving on"
      }`);
      await new Promise((r) => setTimeout(r, 700 * attempt));
    }
  }

  throw lastError;
}

async function* parseSse(res) {
  // Parse the SSE stream: lines of `data: {...json...}`
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep the last partial line in the buffer
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const data = JSON.parse(payload);
        const parts = data?.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.text) yield part.text;
        }
      } catch {
        // ignore malformed keep-alive lines
      }
    }
  }
}
