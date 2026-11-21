# Roadmap

## Done (v0.1.0)
- Phase 0–1: monorepo, strict TS, Electron shell, tray, hotkeys, persistence, overlay, content-protection check.
- Phase 2: Rust WASAPI helper (mic, loopback, per-process), framed IPC, Gemini 3.5 Transcribe Live + xAI STT adapters, VAD gate, reconnect/rotation.
- Phase 3: Gemini / xAI / DeepSeek / custom streaming providers, fallback, timeouts, cancellation, stale-answer protection.
- Phase 4: document ingestion, FTS5 + vector hybrid retrieval with source trace, personal/project/company profiles, grounding rules.
- Phase 5: coding mode, manual Ask, clipboard + screenshot with preview and secret redaction, quick actions.
- Phase 6: security hardening, perf instrumentation, budgets, privacy controls, logs.
- Phase 7: NSIS installer, e2e/hardware/live suites, docs, install website, redesigned UI and brand.

## Next
1. 30-minute soak + memory profile; device-switch and sleep/resume manual runs.
2. Code signing (needs a certificate) and auto-update.
3. Live verification of xAI and DeepSeek answering and xAI STT with real keys.
4. Optional local OCR for scanned PDFs; image ingestion via approved vision extraction.
5. Speaker diarization within a source (provider-dependent; Gemini Live currently has none).
6. Faster first answer: speculative answering on high-confidence interim questions, provider racing.
