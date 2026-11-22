# Performance results (measured, not estimated)

Machine: Windows 11 (build 26300) laptop, Intel i9-14900HX, 16 GB RAM, Realtek mic array, OnePlus Buds 4 (Bluetooth) as default output, Electron 45.4.1. Network: home broadband, not controlled. Date: 2026-11-19. Raw data: `test-results/hardware-report*.json`, `test-results/live-report.json`.

Sample sizes are small. Treat p95 values with fewer than 20 samples as indicative only.

## 0.3.1 — one assistant, screen reading (2026-11-22)

GPU tier as below (RTX 4060 Laptop, `qwen3.5:4b`, 2 slots), laptop on AC, dev build, fresh profile (no résumé). `tools/screen-check.mjs` shows an 11-line Express router full-screen in Edge (28 px Consolas; captured at 1280×800) and asks typed questions; Hirora's windows are excluded from the capture.

| Question | Screen | First answer token (run 1 / run 2) | Names from the screen in the answer |
|---|---|---|---|
| "Can you establish an RBAC protocol in this?" | captured | 2356 / 1898 ms | `issueRefund`, `deleteOrder`, `/refunds`, `/orders/:id`, `router` |
| "What is RBAC?" | not used | 611 / 592 ms | — |
| "Which of these routes should only an admin be allowed to call?" | captured | 1663 / 1631 ms | all five routes |
| Screen capture (`desktopCapturer`, JPEG 82, 1280×800) | | 483 + 756 / 480 + 710 ms | |

Installed 0.3.1 (`--exe Desktop\Hirora\Hirora.exe`), same check: 1979 ms and 1487 ms with the screen (captures 473 and 676 ms; both answers named all five routes), 506 ms for "What is RBAC?".

**Typed questions, installed 0.3.1** (`tools/quiet-check.mjs`, copy of the owner's profile, AC, two runs with the first-person and code-layout lines; the final build adds one sentence to the system prompt, which is pre-read at warm-up): p50 **0.45 s**; 416, 425, 441, 444, 445, 453, 456, 458, 461, 483, 1174, 1320 ms (n=12; the owner was using the PC during these runs). Every question about the user answered in the first person. Whisper large-v3-turbo on the WAV questions: 116–168 ms once warm (first request 585–588 ms). First question after launch: 11–12 s. Earlier runs: before the first-person line 410–465 ms (n=6), and it answered "What are your strengths and weaknesses?" with "Your main strength is…"; with it but before the code line 497–762 ms (n=12).

**Code layout** (dev build with the code line, AC): "Write a function that checks whether a string has balanced brackets." → **Answer**/**Approach**/**Complexity**/**Tests** with a code block, first token 476 ms (592 ms installed); before the line it was prose with no code. "Can you establish an RBAC protocol in this?" with the router on screen → **Answer**/**Approach**/**Code** naming `issueRefund`, `deleteOrder`, `/orders/:id`, first token 1977 ms.

**Screen while the PC was in use** (installed, the owner's chat window in front of the test page, so the capture showed that window): screen questions 2.2–5.1 s to the first token with 1.0–1.5 s captures. Before the "not visible" line the model invented routes (`/admin/config`, `/users/manage`); with it, it said the routes can't be told from that window. Not re-run with the code page in front on the final build (the PC was in use).

Capture width vs first token, raw Ollama with the same image (laptop on battery): 1600 px 2.9 s, 1280 px 1.3 s, 1024 px 0.85 s; the same image again 0.25–0.35 s. 1280 px keeps 28 px code legible. Once, at 1600 px, the first image request stalled in Ollama's image step after a context-checkpoint restore until the 30 s first-token timeout (the retry on the other slot answered); not reproduced at 1280 px, and image requests now time out after 15 s so the retry comes sooner.

## 0.3.0 — one local engine (2026-11-22)

Installed 0.3.0 (`Desktop\Hirora`) or the dev build, as noted. GPU tier: RTX 4060 Laptop 8 GB, whisper.cpp b5454 CUDA + `ggml-large-v3-turbo-q5_0`, Hirora's own `ollama serve` (0.40.16 binary, 2 slots) with `qwen3.5:4b`. CPU tier: whisper.cpp CPU build + `ggml-small-q5_1`, `qwen3:1.7b`, every GPU hidden from Ollama (`CUDA_VISIBLE_DEVICES`, `GGML_VK_VISIBLE_DEVICES`, `HIP_VISIBLE_DEVICES` = -1). Profile: a copy of the owner's (résumé loaded) unless noted.

**GPU tier, laptop on AC** (`tools/quiet-check.mjs`, installed app, two runs; no sound played):

| Stage | Result |
|---|---|
| Typed question → first answer token | **p50 0.55 s**; 496, 499, 509, 513, 514, 546, 555, 573, 604, 697, 916, 1971 ms (n=12) |
| Whisper transcription of a SAPI question saved as WAV (2.4–3.5 s of audio) | 142–252 ms once warm; first request after start 865–1171 ms |
| First question right after launch (model load + résumé pre-read, the question waits) | 16–19 s |
| Raw `ollama serve`, no Hirora, 2 slots vs 1 slot (short prompt, battery) | ~0.3 s first token either way: two slots don't slow answers |

**GPU tier, spoken** (`tools/interview-check.mjs`, installed app, TTS through the speakers and loopback; power state during this run not recorded, the laptop was being plugged in): the early answer appeared **0.30 s** after the speaker stopped; answers that waited for the final transcript started 1.2, 1.7 and 2.7 s after; final transcript 0.58 s after speech ended (p50). All three transcripts exact, all answers from the résumé.

**On battery** the same GPU path measured 0.7–4.8 s to the first token and 0.5–0.8 s to the final transcript: keep a laptop plugged in.

**CPU tier, laptop on battery** (dev build):

| Stage | Result |
|---|---|
| Spoken question → first answer token (no early answers on CPU) | 2.3, 2.9, 3.6 s; transcripts exact with Whisper small |
| Speech end → final transcript (Whisper small, CPU) | p50 1.47 s |
| Typed question → first token, fresh profile | 3.6 s for the first, then 0.41–0.60 s |
| Résumé pre-read at warm-up (3,036 tokens) | 14–16 s, once |
| Why not `qwen3.5:2b` | hybrid model: llama.cpp re-reads the whole prompt each time (`forcing full prompt re-processing`), 4.1–4.5 s to the first token for a 530-token prompt; `qwen3:1.7b` reuses the cache: 0.16–0.18 s after the first question |
| Why not Whisper base | misheard "thread" as "threat" and produced misheard live text that started wrong early answers |

**Fresh-PC setup** (`tools/engine-setup-check.mjs`, empty folders, no Ollama, home broadband, CPU tier as it was then): Ollama runtime 1.62 GB downloaded in 6 min (~4.4 MB/s), SHA-256 verified in 2 s, unpacked in 6 s; whisper.cpp CPU build and base model in 16 s; `qwen3.5:2b` (2.68 GB) pulled in 10.5 min; ready after 1025 s. After the catalog changed, the same folder downloaded only Whisper small (190 MB, 39 s).

The sections below describe paths that were **removed in 0.3.0** (Hirora Cloud, Gemini, xAI); they are kept as history.

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

## Not yet measured (0.3.0)

- A spoken run on the GPU tier with the laptop confirmed on AC, a human voice on the mic, and a real Meet/Teams call.
- The CPU tier on AC power and on a PC that really has no NVIDIA GPU (the CPU numbers above hide the GPU on this laptop); AMD/Intel GPUs.
- The GPU-tier first-run download on a fresh PC (its files were verified against the catalog on this PC instead); a 30-minute soak.

Run `node tools/quiet-check.mjs` (silent) or `node tools/interview-check.mjs --system keep` (speaks questions) to append fresh numbers; the in-app **Performance** page shows p50/p95 from your own usage.
