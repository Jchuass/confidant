// Claude provider — for when you upgrade from the free tier to Anthropic's API.
// Setup:
//   1. npm install @anthropic-ai/sdk
//   2. Set ANTHROPIC_API_KEY in .env (get one at https://platform.claude.com)
//   3. Set PROVIDER=claude in .env

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-4-8";

export async function* streamReply({ system, history }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. See README.md for setup.");
  }

  let Anthropic;
  try {
    ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
  } catch {
    throw new Error(
      "The Anthropic SDK is not installed. Run: npm install @anthropic-ai/sdk"
    );
  }

  const client = new Anthropic();

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 2048,
    system: [
      { type: "text", text: system, cache_control: { type: "ephemeral" } },
    ],
    messages: history.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.text,
    })),
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      yield event.delta.text;
    }
  }

  // Surface safety refusals gracefully instead of ending with silence.
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    yield "I'm sorry — I can't continue with that. Is there something else on your mind you'd like to talk about?";
  }
}
