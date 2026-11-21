# ADR 0002 — Streaming STT: Gemini 3.5 Transcribe Live by default, xAI STT as alternative

**Status:** accepted · 2026-11-19

**Context.** Live interim + final transcripts per source are required, independent of the answer model. Verified docs (Nov 2026): `gemini-3.5-transcribe-live` over the Live API WebSocket (`setup.inputAudioTranscription`, `realtimeInput.audio` base64 PCM16 16 kHz, `interimInputTranscription` / `inputTranscription`, 10-minute session limit); xAI `wss://api.x.ai/v1/stt` (binary PCM, `transcript.partial` with `is_final` / `speech_final`, server endpointing).

**Decision.** One STT WebSocket per audio source (mic and system never mix). `SttStream` adds 20→100 ms chunking, an adaptive energy-VAD noise gate with 300 ms pre-roll (to avoid paying for silence), hybrid end-of-speech hints for Gemini (`audioStreamEnd`), a bounded backlog while connecting, reconnect with exponential backoff (stops on invalid key / quota), and rotation before Gemini's 10-minute limit at a speech pause.

**Consequences.** Live-verified with Gemini: exact transcript of loopback speech, first words ≈ 0.58 s after onset. Gemini occasionally appends stray words after a pause; question extraction trims short non-question tails after the last "?". xAI STT is verified only against protocol fixtures (no key available).
