# Live speech path: SAVA turns and LocalAgreement text (opt-in)

Off by default (`stt.streamingTranscription: false`): the 0.3.1 path (`SttStream` + `LocalWhisperTranscriber`, energy VAD with a 300 ms pause) is still what everyone uses, because the live path is accurate but not faster on the hardware we measured (below). Turn it on in `settings.json` (`"stt": { "streamingTranscription": true }`) to try it. CHANGELOG "Unreleased" has the history.

## Flow

1. 20 ms PCM frames from `hirora-audio.exe` (unchanged). `LiveCapture` (one per source) keeps the last 500 ms while nobody speaks (pre-roll), and inside a turn sends every frame to that turn's transcriber.
2. **Start of a turn.** A frame the energy VAD hears as loud counts as speech, as does a 40 ms block SAVA scores as speech. Measured live, SAVA alone sometimes took 0.6–0.75 s to call clear speech at the start of a question, and the first word was lost.
3. **End of a turn.** SAVA (`apps/desktop/electron/main/stt/savaOnnx.ts`, onnxruntime-node, CPU, one thread, 4.4 ms per block) scores each block in order, since its state carries from block to block; `TurnDetector` ends the turn once it is quiet and SAVA's end-of-turn probability holds (81–99 ms after the voice stops, live). Without SAVA the energy VAD decides (220 ms hangover + 80 ms guard, about the 0.3.1 pause; 272–290 ms live), and a toast says so once.
4. **Live text.** `StreamingTranscriber` re-decodes the whole turn every 350 ms (plain json, `-nt` as in 0.3.1), and 60 ms into any pause (at once, or right after a decode in flight). LocalAgreement-2: words two decodes in a row agree on are committed and never change; the rest is tentative (grey in the overlay). Whisper's prompt is the vocabulary (Settings + profile skills/company) and the previous turn's text, never this turn's own words.
5. **Final text.** At the end of the turn the transcriber waits for a decode in flight; if the last decode heard audio at least 40 ms past the end of speech, its text is the final one, otherwise the whole turn is decoded once more. If that fails, the last decode's words are kept. `WhisperLane`: one request per source; ticks are skipped while busy (mic gives way to system audio), the final decode waits its turn.
6. **Answers.** Early answers start from the whole latest decode (committed + tentative), as in 0.3.1, and are shown when the final text arrives if it is the same question (`sameQuestion`, unchanged); the live path doesn't show them at the pause, because its live text can be a tick old. Your own mic gets no ticks, one decode per turn; it is never auto-answered unless Settings say so, and a question on it is still the candidate for Ctrl+Shift+Enter.

## Why whole turns and not sliding windows

Measured with the replay: a whisper.cpp decode takes ~0.2 s whether it gets 0.5 s or 15 s of audio (the encoder always runs a 30 s block), so shorter windows save nothing; and `token_timestamps` are too rough to cut audio on (zero-length words, "you" dropped at a cut, "a process" heard as "the process" when a window started mid-word, "Thank you." from a mostly silent tail). Turns are decoded whole up to 28 s; `TurnDetector` ends a turn at 27 s.

## Measurements (RTX 4060 laptop, AC power)

`tools/stt-trace.mjs`, two alternating rounds of three spoken questions, live path with SAVA vs the 0.3.1 path:

| | Live path (SAVA) | 0.3.1 path |
|---|---|---|
| Transcripts word for word | 6 of 6 | 6 of 6 |
| End of speech → end of turn detected | 81–99 ms | (300 ms pause) |
| End of speech → final text | 259–539 ms, median ~470 | 239–513 ms, median ~410 |
| End of speech → first answer token | 1.04–1.46 s, median ~1.24 | 0.88–1.55 s, median ~0.93 |
| One Whisper decode while the answer model runs | 190–380 ms | same engine |

Why SAVA's earlier end of turn doesn't make answers faster here: the 0.3.1 path already decodes as soon as the speaker goes quiet (its final text is that decode), so both paths wait on the same thing, a Whisper decode on a GPU the answer model is also using, and then the answer model's first token. Where SAVA could still help: on hardware where decodes are much faster than the pause, or to avoid ending a turn at a mid-sentence pause (in one trace the energy VAD ended a turn mid-question and an early answer started for "what is this?" before the whole question arrived).

## Checking it

- `HIRORA_STT_REPLAY=1 pnpm vitest run tests/integration/stt-replay.test.ts`: silent. SAPI writes three questions to WAV (TTS fixture), fed in real time through `LiveCapture` with the real whisper-server (started like the app) and SAVA. Expects every question word for word with both detectors (~40 s).
- `node tools/stt-trace.mjs [profile] --live on|off --detector sava|energy`: speaks the questions (plays sound) and prints, per question, when it played, the system-audio level, every live transcript update, the timings and the answer timing, and which path actually ran. `TRACE_BLOCKS=1` adds SAVA's per-block numbers (from `HIRORA_STT_DEBUG=1`, numbers only, never audio or text).

## SAVA packaging

Official [inworld-ai/sava](https://github.com/inworld-ai/sava) ships PyTorch only; Hirora uses the unofficial Apache-2.0 ONNX export `matthiastl/sava-onnx` (`sava-int8.onnx`), pinned in `tools/fetch-sava-onnx.mjs` (revision, size, SHA-256; a mismatch is deleted and stops the build). `pnpm package:win` fetches it into `apps/desktop/resources/sava/` (gitignored), and the installer ships it with only onnxruntime-node's Windows x64 CPU files (`electron-builder.yml`). The model is loaded only when the live path is on. `resources/sava/NOTICE` carries the attribution.

## Debug KPIs (Performance page, timings only)

`stt_decode` (label `source:tick|final|final-reused`), `stt_final_wait`, `turn_end_detect` (label: detector), `speech_end_to_final` (label `source:live`), `stt_window`, `last_word_to_first_token`.
