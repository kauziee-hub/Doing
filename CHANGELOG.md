# Changelog

## 0.2.1 — 2026-11-21 (unsigned)
- **The overlay is hidden from screen sharing by default.** You see it; a Meet/Teams/Zoom screen share (and screenshots) leave it out, via Windows' capture exclusion (ADR 0008). Measured with a real `getDisplayMedia` screen share in Edge 158 and Chrome 157 (new `capture.e2e.ts`). Existing profiles keep their setting: turn it on in Settings → Overlay & capture → "Hide the overlay from screen sharing and screenshots". Best-effort: cameras, some remote-desktop and hardware capture never honour it.
- The "Question end → first answer paint" metric is recorded only while the overlay is visible. A hidden overlay used to report 2–2.5 s "paints" that never reached the screen; with the overlay visible the answer paints 25–73 ms after its first token.

## 0.2.0 — 2026-11-21 (unsigned)
- **Hirora Cloud**, the new default: a free, always-on relay (Vercel Functions in `apps/cloud`, `https://hirora-one.vercel.app/v1`) to Groq's open models (`openai/gpt-oss-20b`, `gpt-oss-120b`) and Whisper. Friends install Hirora, paste the shared access code, and get answers and transcription with no key, no GPU and no cost. The relay checks the code in constant time, allowlists models, caps request and output size, rate-limits per IP and strips account ids from upstream errors (ADR 0010).
- New `cloud-whisper` transcriber, the default for new installs. The local VAD cuts each utterance, sends it as a 16 kHz WAV, and drops silence and segments Whisper marks as no speech. There's no interim text.
- Migration from VeyraCue now waits when either profile is in use (Chromium `lockfile` held) instead of copying a live profile.
- Website deployed at https://hirora-one.vercel.app, with the installer hosted on Vercel Blob, new screenshots of a fresh cloud install and measured cloud latency.
- e2e: new opt-in `cloud.e2e.ts` (fresh profile, access code only). Paint flags stop Chromium's occlusion tracking from hanging screenshots.

First 0.2.0 build (2026-11-19):
- **Renamed VeyraCue → Hirora** (an interview copilot), with a new mark: a white "h" whose shoulder is a rising arch, plus the pink cue dot. App id `app.hirora.desktop`, installer `Hirora-Setup-<v>-x64-unsigned.exe`, helper `hirora-audio.exe`, env vars `HIRORA_*`.
- First launch copies an existing `%APPDATA%\VeyraCue` profile (keys, settings, documents, history) to `%APPDATA%\Hirora` before Electron loads `Local State`, so DPAPI-encrypted keys keep working. The old folder is left untouched.
- **Local answers with Ollama**: new "Ollama (runs on this PC)" provider, with no key, loopback-only endpoint, models listed from the local server, reasoning off for fast cues, and the model preloaded (kept for 30 min) when listening starts.
- `pnpm perf:live` can bench a local model (`HIRORA_BENCH_OLLAMA_MODEL`, `HIRORA_BENCH_PROVIDERS`, `HIRORA_BENCH_SKIP_STT`); the live e2e suite exercises the profile migration and, with `HIRORA_LIVE_OLLAMA_MODEL`, local answers end to end.
- New install website in the style of the brief: hero with a Higgsfield-generated photo, download card, measured stats, local-model section, FAQ, social card. `HIRORA_DOWNLOAD_URL` points downloads at a release host.

## 0.1.0 — 2026-11-19 (first build, unsigned)
- Native Windows audio helper (Rust/WASAPI): microphone, speaker loopback and per-app loopback as separate labelled 16 kHz streams.
- Live transcription with Gemini 3.5 Transcribe Live (default) or xAI streaming STT; question detection; automatic and manual answering.
- Answer providers: Google Gemini, xAI Grok, DeepSeek, custom OpenAI-compatible; live model lists; fallback; cancellation.
- Personal knowledge: PDF/DOCX/text/code ingestion, SQLite FTS5 + optional embeddings, cited answers, no invented personal facts.
- Coding mode, clipboard and screenshot context with preview and secret redaction.
- Translucent always-on-top overlay, global hotkeys, tray, light/dark themes, new VeyraCue brand.
- Privacy: DPAPI-encrypted keys, opt-in history, consent prompt, no telemetry; measured screen-capture exclusion check.
- NSIS per-user installer and a static install website.
