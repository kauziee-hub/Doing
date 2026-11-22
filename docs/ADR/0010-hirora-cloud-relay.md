# ADR 0010 — Hirora Cloud: a free, always-on shared relay to Groq

**Status:** superseded by ADR 0012 (0.3.0: one local engine, no cloud, no keys) · originally accepted 2026-11-20

**Context.** The owner wants Hirora to work on any PC — including friends' laptops without a GPU — with no paid keys and nothing running on the owner's laptop. Local Ollama answers were fast (~0.6 s) but only on a GPU machine; Gemini answers swung between 0.8 s and 37 s with intermittent HTTP 503 "high demand". Free always-on servers with GPUs don't exist; free CPU hosts would take 10 s+ per answer with our prompt sizes.

**Decision.** Deploy a tiny OpenAI-compatible relay as Vercel Functions in the same project as the install website (`apps/cloud`, `https://hirora-one.vercel.app/v1`). It holds the owner's Groq API key (free tier) as an encrypted Vercel environment variable and exposes:

- `POST /v1/chat/completions` → Groq (`openai/gpt-oss-20b` default, `openai/gpt-oss-120b` for in-depth answers; the Llama models listed in Groq's docs returned 404 for this free account), streaming passed through with `reasoning_effort: low` and hidden reasoning;
- `POST /v1/audio/transcriptions` → Groq Whisper (`whisper-large-v3-turbo`), `verbose_json`;
- `GET /v1/models`, `GET /health`.

Every call needs a shared **access code** (`HIRORA_ACCESS_CODE`, constant-time compared) so strangers who find the URL can't drain the free quota. The relay allowlists models, caps request size (200 KB chat, 4 MB audio) and output tokens (4096), applies a best-effort 60 req/min per-IP limit, strips the owner's Groq organisation id from upstream errors, and never logs request or response content.

In the app, `cloud` is a provider whose "key" is the access code (DPAPI vault), and `cloud-whisper` is the default transcriber for new installs: the local VAD segments speech, each utterance (after a 350 ms debounce, ≥ 250 ms voiced) is sent as a 16 kHz WAV, and segments Whisper marks `no_speech_prob ≥ 0.6` are dropped. There is no interim text.

**Consequences.**
- Friends install Hirora, paste the access code, and it works: no GPU, no keys, no cost.
- Free-tier limits are shared by everyone using the server (Groq, Nov 2026: about 30 requests/min, 1,000 requests/day and 8K tokens/min for gpt-oss; Whisper about 20 requests/min, 2,000/day, 2 h of audio per hour). Heavy use needs the owner to upgrade Groq or friends to add their own keys.
- Questions, retrieved résumé snippets and spoken sentences pass through the owner's Vercel function and Groq. Nothing is stored on the relay; Groq's data policy applies.
- Transcripts arrive per utterance (≈ when the speaker pauses) rather than word by word.
- Gemini, xAI, DeepSeek, custom endpoints and local Ollama remain available as optional providers.
