# Hirora

**Interview calmer, answer smarter.** A Windows 11 interview copilot that transcribes the call you approve, detects questions and streams short, résumé-grounded answer cues into a quiet translucent overlay, for interview practice, permitted live calls, coding rounds and meetings. **Everything runs on your PC**: speech recognition (whisper.cpp) and the answer model (Qwen, in a Hirora-managed Ollama runtime). No account, no keys, no server, no telemetry. On first launch the app checks the hardware and installs its engine with one click.

**Download:** https://hirora-one.vercel.app

> Formerly **VeyraCue** (renamed in 0.2.0; an existing `%APPDATA%\VeyraCue` profile is migrated on first launch). 0.3.0 removed Hirora Cloud and every bring-your-own-key provider ([ADR 0012](docs/ADR/0012-local-only-engine.md)). Use Hirora only where AI assistance and transcription are allowed, with everyone's consent.

## What works today (verified on a Windows 11 laptop, Nov 2026)

| Area | Status |
|---|---|
| **One-click engine setup**: hardware check (`nvidia-smi`), pinned downloads with SHA-256 checks and resume, unpacking, Ollama model pull, progress in the app; reuses an Ollama the user already has | **Verified** on this PC (existing files detected, nothing downloaded) and as a **fresh PC** (empty folders, no Ollama): the CPU set of the time (4.4 GB) downloaded, checked and installed in 17 min on home broadband, then answered; changing one part later downloaded only that part. GPU-tier files match the catalog's SHA-256 exactly |
| Live transcription with whisper.cpp on this PC (GPU: large-v3-turbo; CPU: base), live text while they speak | **Measured** (RTX 4060 laptop on AC): Whisper large-v3-turbo transcribes a 2.4–3.5 s spoken question in 0.14–0.25 s |
| Answers on this PC (GPU: Qwen 3.5 4B; CPU: Qwen 3 1.7B), started before the question ends and shown at the pause; the "is this for me?" check runs in a second slot | **Measured** (installed 0.3.0, RTX 4060 laptop on AC): median 0.55 s from a typed question to the first answer word (0.50–1.97 s, 12 questions); with spoken questions (TTS through the speakers), the early answer appeared 0.30 s after the speaker stopped; answers that waited for the final transcript started 1.2–2.7 s after. Processor only (all GPUs hidden, laptop on battery): spoken questions transcribed exactly with Whisper small and answered 2.3–3.6 s after the speaker stopped; typed questions 0.41–0.60 s once warm |
| Native audio (Rust + WASAPI): microphone and speaker loopback as separate 16 kHz streams, device hot-swap, sleep/resume recovery | **Verified on hardware** |
| Knowledge: PDF/DOCX/TXT/MD/CSV/JSON/code ingestion, SQLite FTS5 retrieval with source trace; missing facts flagged, not invented | **Verified live** |
| Coding mode, screenshot (preview + approve; read by the GPU tier's Qwen 3.5 4B), clipboard (preview + secret redaction) | **Verified** by e2e UI tests |
| Overlay: translucent, always-on-top, never steals focus, global hotkeys | **Verified** |
| Screen-capture exclusion (on by default) | **Measured**: left out of a real Chrome 157 / Edge 158 screen share, GDI and desktopCapturer (`capture.e2e.ts`). Live Meet/Teams/Zoom calls: *not verified*. Never "invisible". |
| Security: sandboxed renderer, Zod-validated allowlisted IPC, CSP, engine on loopback only | **Verified** by e2e + unit tests |
| Windows installer (NSIS, per-user, unsigned) and install website | **Verified**; website on Vercel (`apps/hosting`), installer on Vercel Blob |

Measured numbers and their limits are in [docs/PERF_RESULTS.md](docs/PERF_RESULTS.md); the acceptance matrix is in [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md).

## Quick start

Prerequisites: Windows 11 x64, Node 22+, pnpm 9, Rust stable (`x86_64-pc-windows-gnu` or `-msvc`).

```bash
pnpm install
pnpm dev                # builds the native helper (debug) and runs Electron with hot reload
```

```bash
pnpm lint && pnpm typecheck && pnpm test     # ESLint + tsc + Vitest + cargo test
pnpm test:e2e                                # Playwright-for-Electron against the built app (empty engine folder, real hardware)
pnpm package:win                             # → apps/desktop/release/Hirora-Setup-<version>-x64-unsigned.exe
node tools/interview-check.mjs --system keep # speaks questions, measures transcript + answer latency on a profile copy
node tools/engine-setup-check.mjs <emptyDir> --tier cpu   # a fresh PC's first-run setup, with real downloads
```

Release and deploy steps are in [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md).

## Using it

1. **Install** from the website and open Hirora. Press **Set up Hirora**: it shows your hardware, what it will download (about 6.2 GB with an NVIDIA GPU of 6 GB or more, 3.2 GB otherwise) and installs it. You can keep working; setup resumes if interrupted.
2. **Knowledge**: add your résumé and project notes (and a job description under **Profiles**).
3. **Home**: pick a mode, press **Start listening**, confirm consent. The overlay (`Ctrl+Shift+Space`) shows the labelled transcript and streams answers. `Ctrl+Shift+Enter` answers the latest question; `Ctrl+Shift+K` lets you type; `Ctrl+Shift+X` cancels. Keep a laptop plugged in: on battery the GPU slows down a lot.

## Architecture

```
mic ─┐                                          whisper-server.exe (127.0.0.1:8178)
     ├─ hirora-audio.exe (Rust, WASAPI) ──▶ Electron main: SessionController ─▶ live text, question detection
loop ┘   framed stdout, 20 ms PCM16 16 kHz              │
                                                         └─▶ AnswerEngine ─▶ ollama serve (127.0.0.1:11435, 2 slots) · Qwen
                                                                  ▲ HybridRetriever (node:sqlite FTS5)
EngineManager: hardware tier, verified downloads, server lifecycle      Renderer (sandboxed React) ◀─ allowlisted IPC (Zod)
```

```
apps/desktop          Electron main/preload (electron/, engine/ = installer + servers), React renderer (src/)
apps/website          static install site (Vite)
apps/hosting          Vercel project that serves the built site (public/); no server code
native/windows-audio  Rust WASAPI helper + framed protocol, DSP, GDI capture probe
packages/contracts    Zod schemas, IPC allowlist, settings, secret detector
packages/providers    local answer engine client (Ollama, OpenAI-compatible SSE), whisper.cpp transcriber
packages/knowledge    parsers, chunker, SQLite schema/migrations, FTS5 retrieval, history/perf/usage stores
packages/orchestration VAD, question detection, transcript assembly, prompt builder, AnswerEngine, SttStream, SessionController
packages/settings     settings store (schema 2; 0.2.x files load leniently)
packages/ui           shared React primitives
tests/                e2e (Playwright-for-Electron), fixtures
tools/                interview-check (spoken latency), engine-setup-check (fresh-PC setup), capture/audio tools
docs/                 ADRs, acceptance, performance, privacy, troubleshooting
```

## Known limitations

- **Speed depends on the PC.** The fast path needs an NVIDIA GPU with 6 GB or more and AC power. Other PCs use small models on the processor and answer more slowly (measured in `docs/PERF_RESULTS.md`). AMD and Intel GPUs use the processor tier for now.
- **Answer quality** is that of a 4B (GPU) or 1.7B (CPU) model, and the CPU model can't read screenshots; it is guarded against inventing facts that aren't in your materials, but it is not a large cloud model.
- **First run downloads 3.2–6.2 GB** from GitHub, Hugging Face and the Ollama library.
- The installer is **unsigned** (SmartScreen warning). Multi-monitor placement wasn't tested on a second physical display. OCR for scanned PDFs is not bundled.
- Screen-capture exclusion is best-effort and was measured on one machine only. Cameras and some remote-desktop or hardware capture never honour it.

See [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) and [docs/PRIVACY.md](docs/PRIVACY.md).
