# Performance results (measured, not estimated)

Machine: Windows 11 (build 26300) laptop, Intel i9-14900HX, 16 GB RAM, Realtek mic array, OnePlus Buds 4 (Bluetooth) as default output, Electron 45.4.1. Network: home broadband, not controlled. Date: 2026-11-19. Raw data: `test-results/hardware-report*.json`, `test-results/live-report.json`.

Sample sizes are small. Treat p95 values with fewer than 20 samples as indicative only.

## Hirora Cloud (free relay → Groq) — 2026-11-21

This is the default for new installs. A fresh temp profile was used, with only the access code entered: no keys, no GPU work, no Ollama. Path: app → `https://hirora-one.vercel.app/v1` (Vercel Function) → Groq. Machine and network as above (home broadband, India; Vercel region auto). Raw data: `test-results/cloud-report.json`.

| Stage | Result | Notes |
|---|---|---|
| Connect (save code → `/v1/models` check) | 391 ms (dev build), 432 ms (installed build) | `providers:test` |
| Typed question → first answer token (`openai/gpt-oss-20b`) | **p50 551 ms, p95 811 ms, range 416–815 ms (n=35)** | 5 installed-build questions (cloud e2e) + 30 dev-build questions (paint check), mixed modes |
| Same, in-app perf row (installed build, cloud e2e) | p50 585 ms, p95 939 ms (n=6) | includes the spoken question |
| First token → first painted overlay frame | +25 to +73 ms (n=15, overlay visible) | question → painted answer 489–878 ms |
| Whole answer, installed build | 509–630 ms for 120–464 chars; 893 ms for a 913-char explanation; 1.4 s for a 1633-char coding answer with code | |
| Spoken question: end of speech → final transcript (`speech_end_to_final`, Whisper) | 1608 ms (dev), 1958 ms (installed) | one SAPI sentence per run, played through the speakers and captured by loopback; transcript exact both times; includes the 350 ms end-of-speech debounce and the upload |
| Same, measured from the TTS process exit | 1485 ms (dev), 1806 ms (installed) | test-side clock |
| Spoken question → answer first token | 590 ms (dev), 672 ms (installed) | auto-answer on system audio |
| Groq direct, no Hirora (raw `fetch`) | first token 371–445 ms | the relay plus app add ≈ 0.1 s |
| Wrong access code | `invalid_key` in 1 round trip | HTTP 401 from the relay |

Transcription has **no interim text**: Whisper returns each utterance once the local VAD sees the speaker pause (`stt_first_partial` therefore equals the whole sentence length plus ~1.6–2 s, e.g. 5.4 s for a 5 s sentence). Groq free-tier limits are shared by every user of the server; numbers under load were not measured.

**Correction (2026-11-21):** "Question end → first answer paint" was recorded even when the overlay window was hidden. A hidden window still runs `requestAnimationFrame` on a slow schedule, so those samples read 2.0–2.5 s for frames nobody saw (measured: 5 hidden vs 5 visible questions in one session, first token 450–815 ms in both). Since the fix it is recorded only while the overlay is visible. The Gemini first-paint row below predates the fix and may include such samples.

## Local pipeline

| Stage | Result | Target | Notes |
|---|---|---|---|
| Global hotkey → overlay painted | p50 6.8–7.8 ms, p95 10.0–10.5 ms (n=12, two runs) | p95 < 100 ms ✅ | Real OS key events (SendKeys) → `globalShortcut` → renderer double-rAF paint report |
| Audio frame size | 20 ms (320 samples @ 16 kHz) | 20–40 ms ✅ | |
| Dropped frames (helper queue) | 0 of ~250–1760 frames per run | < 0.1 % ✅ | **30-minute soak not yet run** — see Acceptance |
| Loopback fidelity | 440 Hz tone recovered at 440 Hz | — | Bluetooth output device |
| Retrieval (FTS5) | p50 0.25 ms, p95 1.5 ms in the app; 0.03–0.09 ms micro-bench | — | Small knowledge base |
| Question detection / prompt assembly / helper decode | 0.001–0.03 ms p50 | — | Local benchmark (`Performance → Run local benchmarks`) |
| App cold start → dashboard ready | 563–1920 ms (n=2) | — | dev build |

## Live providers (Gemini key)

| Stage | Result | Target |
|---|---|---|
| STT session open (Gemini Live) | 427–825 ms | — |
| Speech onset → first transcript text | 557, 583, 586 ms | p50 < 500 ms ❌ (close) |
| End of speech → final transcript | 329 ms (one run), 2632 ms (earlier run) | — |
| Final transcript → question dispatched | 258–265 ms (includes 250 ms merge debounce) | — |
| Model request → first token (gemini-3.5-flash-lite) | p50 8348 ms, p95 11657 ms (n=5); 3.19 s at a quieter moment | — |
| Question end → first token | p50 8685 ms, p95 21798 ms (n=5) | p50 < 1.5 s, p95 < 3.5 s ❌ |
| Question end → first answer paint | p50 10374 ms (n=4) — recorded before the hidden-overlay fix, see the correction above | — |

**Why the answer target is missed:** a stand-alone script using plain `fetch` (no Hirora code) measured Gemini `streamGenerateContent` time-to-first-byte at 7981–9261 ms for both one-sentence and long answers on `gemini-3.5-flash-lite`, and `gemini-3.6-flash` returned HTTP 503 "experiencing high demand" at the same time. The delay is the provider's, not the pipeline's (Hirora adds ~0.3 s locally). Faster providers/models or quieter periods are needed to approach 1.5 s. Because of this measurement the default first-token timeout was raised from 8 s to 20 s.

## Local answers (Ollama, qwen3.5:4b) — 2026-11-19

Machine as above. GPU: NVIDIA RTX 4060 Laptop (8 GB), Ollama 0.40.16, model `qwen3.5:4b` (3.3 GB, all 33 layers on GPU). **The laptop was on battery** (Balanced plan, GPU in P5 at 465 MHz). On AC power, expect equal or better numbers. System RAM was nearly full (1.9 GB free of 16 GB) because of other apps.

Raw OpenAI-compatible `/v1/chat/completions` streaming, short system prompt, "What is the difference between TCP and UDP?", `max_tokens` 200:

| Stage | Result | Notes |
|---|---|---|
| Very first load after install | 177 s, then 161 s to the first token | One-time GPU warm-up on a throttled, memory-starved laptop. Not repeated afterwards |
| Model load (cold, from disk) | 11.3 s | Hirora does this when you press **Start listening** (`/api/generate`, `keep_alive: 30m`) so questions don't wait for it |
| First token, first question after load | 805 ms | |
| First token, warm | 244 ms, 257 ms | |
| Full 200-token answer | 2.9 s | |
| Same request **without** `reasoning_effort: "none"` | no answer text within 200 tokens (737 characters of reasoning first) | why the Ollama adapter turns reasoning off for fast cues |

In-app numbers (real prompts with résumé evidence, AnswerEngine, IPC) are in the next section.

## Not yet measured

- 30-minute audio soak; weak-network and provider-failover timings; xAI/DeepSeek latency (no keys); packaged-build cold start.
- Hirora Cloud under concurrent use (several friends at once) and near Groq's daily limits; mic (human voice) through Whisper.

Run `pnpm perf:live` (uses keys saved in the app) to append fresh numbers; the in-app **Performance** page shows p50/p95 from your own usage.
