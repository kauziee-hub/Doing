# ADR 0001 — Electron + React shell with a Rust WASAPI sidecar

**Status:** accepted · 2026-11-19

**Context.** We need a polished desktop UI with an always-on-top overlay, global hotkeys and tray, and Windows-native audio capture (microphone, speaker loopback, per-process loopback) with timestamps and no per-chunk process spawning.

**Decision.** Electron 45 (Chromium 156, Node 24) with a sandboxed React renderer. Audio capture runs in a small long-lived Rust process (`hirora-audio.exe`, `wasapi` 0.27 + `windows` 0.62) that streams 20 ms PCM16 16 kHz frames over a framed binary stdout protocol and takes JSON-line commands on stdin. The helper exits when its pipes close, so it cannot outlive the app.

**Consequences.**
- Native event-driven WASAPI with engine autoconvert to 16 kHz mono (own windowed-sinc resampler as fallback), bounded queue with drop counters, silence padding for idle loopback, 1 s device polling, automatic reconnect with backoff.
- An audio crash cannot take down the UI; main restarts the helper (bounded).
- Two toolchains. The helper builds with the Rust GNU target on this machine (no MSVC build tools); CI uses MSVC.
