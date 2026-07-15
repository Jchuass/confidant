# Confidant

A prototype AI counselling companion — a warm, supportive chat with "Ms Ilona",
an AI persona defined in [system-prompt.txt](system-prompt.txt).

To use your own portrait for Ms Ilona, save an image as `public/ilona.png` —
the app picks it up automatically (a built-in illustration is used until then).

**Not therapy.** This is a supportive-conversation app, clearly labelled as such
in the UI, with crisis-resource handling built in.

## Run it (2 minutes)

Requires Node.js 18+ (no `npm install` needed — zero dependencies).

1. **Get a free API key** at <https://aistudio.google.com/apikey> (Google account, no credit card).
2. **Copy `.env.example` to `.env`** and paste your key into `GEMINI_API_KEY=`.
3. **Start the server:**
   ```
   node server.js
   ```
4. Open <http://localhost:3000> and start talking.

No key yet? The app still runs in **demo mode** so you can see the interface.

## Shape the counsellor's personality

Everything about how Mira talks — tone, length, ethics, crisis handling — lives in
[system-prompt.txt](system-prompt.txt). Edit it, restart the server, and chat again.
This is where most of the tuning work happens.

## Switch to Claude later (better conversation quality)

The AI provider is swappable — the app code doesn't change:

1. `npm install @anthropic-ai/sdk`
2. Get an API key at <https://platform.claude.com> and set a monthly spend cap.
3. In `.env`: set `PROVIDER=claude` and `ANTHROPIC_API_KEY=your-key`.
4. Restart the server.

## Project layout

| File | What it is |
|---|---|
| `server.js` | Web server: serves the page, keeps conversation history, streams AI replies, crisis keyword check |
| `system-prompt.txt` | The counsellor persona and ethical rules (edit freely) |
| `providers/gemini.js` | Google Gemini adapter (free tier) |
| `providers/claude.js` | Anthropic Claude adapter (paid) |
| `public/index.html` | The chat interface |

## Prototype limitations (before real users)

- Conversations are stored **in memory only** — restarting the server forgets them. Add a database.
- No user accounts or authentication.
- Free-tier Gemini may use conversations to improve Google's models — fine for
  your own testing, **not acceptable for real users' private conversations**.
  Move to a paid tier (or Claude) before launch, and add encryption + a privacy policy.
