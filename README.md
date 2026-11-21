# Hirora

**Interview calmer, answer smarter.** A Windows 11 interview copilot that transcribes the call you approve, detects questions and streams short, résumé-grounded answer cues into a quiet translucent overlay, for interview practice, permitted live calls, coding rounds and meetings. Works on any Windows 11 PC through **Hirora Cloud**, a free always-on relay (Vercel → Groq open models and Whisper) unlocked with a shared access code: no key, no GPU, no payment. You can also bring your own key (Gemini, xAI/Grok, DeepSeek, any OpenAI-compatible endpoint) or run answers on your own GPU with Ollama. No telemetry.

**Download:** https://hirora-one.vercel.app

> Formerly **VeyraCue** (renamed in 0.2.0; an existing `%APPDATA%\VeyraCue` profile is migrated on first launch, keys included). Name check on 2026-11-19: no app or AI product named Hirora turned up in web searches, and `hirora.app`, `hirora.ai` and `gethirora.com` were unregistered. No trademark clearance has been done. Use Hirora only where AI assistance and transcription are allowed, with everyone's consent.

## What works today (verified on a Windows 11 laptop, Nov 2026)

| Area | Status |
|---|---|
| Native audio (Rust + WASAPI): microphone and speaker loopback as separate 16 kHz streams, 20 ms frames, device hot-swap, default-device following, sleep/resume recovery | **Verified on hardware** — a 440 Hz tone played through Bluetooth headphones was recovered at 440 Hz from loopback with 0 dropped frames |
| **Hirora Cloud** (default for new installs): answers from `openai/gpt-oss-20b` (in-depth: `gpt-oss-120b`) and per-sentence Whisper transcription through `https://hirora-one.vercel.app/v1`, with an access code, model allowlist, size caps and a per-IP limit | **Verified live** on a fresh install and on the installed build: typed question → first token p50 551 ms (n=35); spoken question via loopback → exact transcript 1.6–2.0 s after speech ended → answer first token 0.6–0.7 s later; wrong code → clear `invalid_key` |
| Live transcription: Gemini 3.5 Transcribe Live and xAI streaming STT (optional, own key); interim + final text per source; hybrid VAD end-of-speech; 10-min session rotation | **Verified live (Gemini)** — spoken question played through the speakers → loopback → exact transcript, first words ~0.58 s after speech onset. xAI STT verified against protocol fixtures only (no xAI key) |
| Question detection → automatic answer (configurable sources), manual Ask, follow-ups, cancel, stale-answer protection | **Verified live** |
| Answer providers: Gemini (streamGenerateContent SSE), xAI, DeepSeek, custom OpenAI-compatible; model list from the live API; visible fallback; timeouts; one safe retry; structured errors | **Gemini verified live**; wrong-key handling verified live against xAI; DeepSeek/custom verified against wire-format fixtures only |
| Knowledge: PDF/DOCX/TXT/MD/CSV/JSON/code ingestion, dedupe, preview, delete, SQLite FTS5 + optional Gemini embeddings (hybrid RRF), source trace (file/page/chunk), project cards, company/job profiles | **Verified live** — resume fact answered with `[S1] resume p.1`; a missing GPA was flagged instead of invented |
| Coding mode, screenshot (preview + approve), clipboard (preview + secret redaction), copyable code blocks, Expand / Beginner / Concise | **Verified** (coding answer live; screenshot/clipboard flows by e2e UI tests) |
| Overlay: translucent, always-on-top, drag/resize, compact mode, multi-monitor move, never steals focus, global hotkeys (hotkey→paint p50 ≈ 7 ms) | **Verified** (single-monitor machine: multi-monitor code path not physically tested) |
| Screen-capture exclusion (Electron `setContentProtection`, **on by default** since 0.2.1) + in-app Capture Compatibility Check | **Measured** on this machine: with protection on, the overlay was left out of a real browser screen share (`getDisplayMedia` in Edge 158 and Chrome 157, `capture.e2e.ts`), GDI BitBlt and Chromium desktopCapturer. The Meet call itself, Teams/Zoom apps and OBS: *not verified*. Never "invisible". |
| Security: sandboxed renderer, contextIsolation, Zod-validated allowlisted IPC, CSP, no remote content, DPAPI-encrypted keys, key redaction in logs/errors | **Verified** by e2e + unit tests |
| Windows installer (NSIS, per-user, unsigned) | **Verified** — silent install → launch → full e2e suite on the installed build → uninstall |
| Install website (`apps/website`) + relay (`apps/cloud`) | **Deployed** on Vercel at https://hirora-one.vercel.app; the installer is on Vercel Blob, and a full download matched the SHA-256 shown on the page |

Measured numbers and their limits are in [docs/PERF_RESULTS.md](docs/PERF_RESULTS.md); the full acceptance matrix is in [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md).

## Quick start

Prerequisites: Windows 11 x64, Node 22+, pnpm 9, Rust stable (`x86_64-pc-windows-gnu` or `-msvc`).

```bash
pnpm install
pnpm dev                # builds the native helper (debug) and runs Electron with hot reload
```

```bash
pnpm lint && pnpm typecheck && pnpm test     # ESLint + tsc (7 projects) + Vitest + cargo test
pnpm test:e2e                                # Playwright-for-Electron against the built app (incl. real-hardware checks)
pnpm package:win                             # → apps/desktop/release/Hirora-Setup-<version>-x64-unsigned.exe
pnpm perf                                    # local, no-network benchmarks
pnpm perf:live                               # real provider + STT benchmark with the keys saved in the app
pnpm --filter @hirora/website build        # install website (copies the latest installer + SHA-256)
```

Hirora Cloud (owner only; secrets `GROQ_API_KEY` and `HIRORA_ACCESS_CODE` live in the Vercel project's encrypted env):

```bash
npx playwright test -c tests/e2e/playwright.config.ts cloud.e2e.ts   # with $env:HIRORA_CLOUD_CODE set: live relay test on a fresh profile
```

Release and deploy steps are in [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md); the design is in [ADR 0010](docs/ADR/0010-hirora-cloud-relay.md).

Live tests that use your saved keys (they copy your profile to a temp folder and never modify it):

```bash
$env:HIRORA_LIVE_PROFILE="$env:APPDATA\Hirora"; npx playwright test -c tests/e2e/playwright.config.ts live.e2e.ts
# add local-model tests (Ollama running, model pulled):
$env:HIRORA_LIVE_OLLAMA_MODEL="qwen3.5:4b"
```

## Using it

1. **Setup** (or **Settings → Providers → Hirora Cloud**): paste the access code → **Save code**. That's all: answers and transcription now run on Hirora Cloud.
   - **Your own quota instead:** paste a Gemini, xAI or DeepSeek key → **Save key** (encrypted with Windows DPAPI) → the app tests it and loads the live model list. Gemini or xAI keys can also do live transcription with interim text.
   - **Faster, private answers on a GPU:** install [Ollama](https://ollama.com/download), run `ollama pull qwen3.5:4b`, then **Settings → Providers → Ollama → Test connection** and pick it as the primary answer provider. No key needed; the model loads when you start listening.
2. **Knowledge**: add your resume / project notes (and a job description under **Profiles**).
3. **Home**: pick a mode, press **Start listening**, confirm consent. The overlay (`Ctrl+Shift+Space`) shows the labelled transcript (Mic vs System) and streams answers. `Ctrl+Shift+Enter` answers the latest question; `Ctrl+Shift+K` lets you type; `Ctrl+Shift+X` cancels.

## Architecture

```
                                           ┌─ Hirora Cloud Whisper (per utterance, HTTPS) | Gemini Live / xAI STT (WebSocket)
mic ─┐                                     │
     ├─ hirora-audio.exe (Rust, WASAPI) ─┤
loop ┘   framed stdout, 20 ms PCM16 16 kHz │   Electron main: SessionController → TranscriptAssembler
                                           └─▶ → question detection → AnswerEngine ─▶ Hirora Cloud | Gemini | xAI | DeepSeek | custom | Ollama (SSE)
                                                        ▲ HybridRetriever (node:sqlite FTS5 + vectors)
Renderer (sandboxed React): dashboard + translucent overlay ◀── allowlisted IPC (Zod) ── main
```

```
apps/desktop          Electron main/preload (electron/), React renderer (src/), electron-builder config
apps/website          static install site (Vite)
apps/cloud            Hirora Cloud: Vercel Functions relay to Groq (api/, lib/relay.mjs) + the built site in public/
native/windows-audio  Rust WASAPI helper + framed protocol, DSP, GDI capture probe
packages/contracts    Zod schemas, IPC allowlist, settings, secret detector
packages/providers    text providers, STT adapters, embeddings, SSE, error mapping
packages/knowledge    parsers, chunker, SQLite schema/migrations, FTS5 + hybrid retrieval, history/perf/usage stores
packages/orchestration VAD, question detection, transcript assembly, prompt builder, AnswerEngine, SttStream, SessionController
packages/settings     settings store, DPAPI secret vault
packages/ui           shared React primitives
tests/                e2e (Playwright-for-Electron), fixtures (synthetic PDF/DOCX builders)
docs/                 ADRs, acceptance, performance, privacy, troubleshooting, roadmap
```

## Known limitations

- **Hirora Cloud is shared and free-tier.** Everyone using the access code shares Groq's free limits (about 30 requests/min and 1,000 requests/day for answers; about 2,000 transcriptions/day). Behaviour under concurrent use wasn't measured. Questions, résumé snippets and spoken sentences pass through the owner's Vercel function and Groq (nothing is stored on the relay). Transcripts arrive per sentence, with no interim text.
- **Gemini latency is provider-bound.** Gemini 3.5 Flash-Lite first-token latency was ~8–9 s during a busy period (measured with raw `fetch`, independent of Hirora), 3 s at a quieter moment.
- The installer is **unsigned** (SmartScreen warning). xAI/DeepSeek answering and xAI STT were not tested live (no keys). Multi-monitor placement wasn't tested on a second physical display. OCR for scanned PDFs is not bundled.
- Screen-capture exclusion is best-effort and was measured on one machine only (browser screen share, GDI, desktopCapturer). Cameras and some remote-desktop or hardware capture never honour it.

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) and [docs/PRIVACY.md](docs/PRIVACY.md).
