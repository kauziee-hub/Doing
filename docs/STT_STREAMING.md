# Live speech path: SAVA turns and LocalAgreement text (opt-in)

Off by default (`stt.streamingTranscription: false`): the 0.3.1 path (`SttStream` + `LocalWhisperTranscriber`, energy VAD with a 300 ms pause) is still what everyone uses. Turn it on in `settings.json` (`"stt": { "streamingTranscription": true }`) to try this one. CHANGELOG "Unreleased" has the history and the numbers.

## Flow

1. 20 ms PCM frames from `hirora-audio.exe` (unchanged). `LiveCapture` (one per source) keeps the last 500 ms while nobody speaks (pre-roll), and inside a turn sends every frame to that turn's transcriber.
2. **End of turn.** SAVA (`apps/desktop/electron/main/stt/savaOnnx.ts`, onnxruntime-node, CPU, one thread) scores each 40 ms block, one at a time and in order, since its state carries from block to block (4.4 ms per block on this laptop). `TurnDetector` turns that into speechStart / turnEnd / resumed. If SAVA isn't loaded or fails, the energy VAD decides (220 ms hangover + 80 ms guard, about the 0.3.1 pause), and a toast says so once.
3. **Live text.** `StreamingTranscriber` re-decodes the whole turn every 350 ms (plain json, `-nt` as in 0.3.1). LocalAgreement-2: the words two decodes in a row agree on are committed and never change; the rest is tentative (grey in the overlay). Whisper's prompt is the vocabulary (Settings + profile skills/company) and the previous turn's text, never this turn's own words.
4. **End of turn, final.** `onPause` fires with the end of speech (the pause mark used for latency), then the transcriber waits for a decode in flight and decodes the whole turn once more; that text is the final segment. If it fails, the last tick's words are kept. `WhisperLane`: one request per source; ticks are skipped while busy (mic gives way to system audio), the final decode waits its turn.
5. **Answers.** Early answers start from the whole latest decode (committed + tentative), as in 0.3.1, and are shown at the pause if the final is the same question (`sameQuestion`, unchanged). Your own mic gets no ticks, one decode per turn; it is never auto-answered unless Settings say so, and a question on it is still the candidate for Ctrl+Shift+Enter.

## Why whole turns and not sliding windows

Measured with the replay: a whisper.cpp decode takes ~0.2 s whether it gets 0.5 s or 15 s of audio (the encoder always runs a 30 s block), so shorter windows save nothing; and `token_timestamps` are too rough to cut audio on (zero-length words, "you" dropped at a cut, "a process" heard as "the process" when a window started mid-word, "Thank you." from a mostly silent tail). Turns are decoded whole up to 28 s; `TurnDetector` ends a turn at 27 s.

## Checking it

- `HIRORA_STT_REPLAY=1 pnpm vitest run tests/integration/stt-replay.test.ts`: silent. SAPI writes three questions to WAV (TTS fixture), fed in real time through `LiveCapture` with the real whisper-server (started like the app) and SAVA. Expects every question word for word with both detectors (~40 s).
- `node tools/interview-check.mjs <profile copy with the flag on> --system keep`: speaks through the speakers; compare with the installed app (`--exe`) in alternating runs on AC power.

## Open issues (why it is off by default)

- Live, the final text arrived ~1.04 s after the end of speech vs 0.42–0.52 s on the default path, and first answer tokens were not faster (p50 0.91 s vs 0.84–0.93 s).
- In 3 of 5 live runs the first question lost its first word ("Introduce yourself."); never in the replay, so it is something in the live audio path (device start, loopback level) that the replay doesn't reproduce.
- SAVA ends turns 170–200 ms before the energy VAD on the replay; that gain doesn't show in live numbers yet.

## SAVA packaging

Official [inworld-ai/sava](https://github.com/inworld-ai/sava) ships PyTorch only; Hirora uses the unofficial Apache-2.0 ONNX export `matthiastl/sava-onnx` (`sava-int8.onnx`), pinned in `tools/fetch-sava-onnx.mjs` (revision, size, SHA-256; a mismatch is deleted and stops the build). `pnpm package:win` fetches it into `apps/desktop/resources/sava/` (gitignored), and the installer ships it with only onnxruntime-node's Windows x64 CPU files (`electron-builder.yml`). The model is loaded only when the live path is on. `resources/sava/NOTICE` carries the attribution.

## Debug KPI

Perf stages `last_word_to_first_token` and `stt_window` (audio length per decode).
