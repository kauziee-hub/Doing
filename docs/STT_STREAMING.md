# Sliding-window STT, SAVA turns, and role separation (0.3.2)

Flags (Settings → Engine → Transcription), each restores the previous path when off:

| Setting | Default | Off means |
|---------|---------|-----------|
| `stt.streamingTranscription` | on | Re-send the whole utterance to whisper-server every 350 ms (`WhisperUtteranceSession`) |
| `stt.sttTurnDetector` | `sava` | Energy VAD + 300 ms pause (`SttStream`) |
| `stt.roleSeparation` | on | `answer.autoAnswerSources` as before (system/app, not mic) |
| `stt.captureMode` | `two-stream` | `single-mic` answers every turn |

## Flow when flags are on

1. 20 ms PCM from `hirora-audio.exe` (unchanged).
2. **Turn:** SAVA ONNX (40 ms frames, speech lookahead 120 ms) or energy VAD fallback. Reveal speculative answers on `turnEnd`, not a fixed 300 ms pause. Speech back within 400 ms → `resumed` drops an uncommitted prefetch.
3. **Transcribe:** LocalAgreement-2 sliding window (≤ 15 s, 200 ms overlap) to `POST /inference` with `response_format=verbose_json`, `prompt` (vocab + last 200 committed chars, ≤ 224 tokens). One request in flight per source; system beats mic.
4. **Answer:** Prefetch from **committed** text only. Final LLM question = stitched committed text. Optional high-beam full decode (`highBeamHistory`) is off and never retriggers the LLM.
5. **Roles:** system → Interviewer, mic → Me. Only interviewer finals triage/prefetch. Mic is one decode at turn end. Echo bleed (token overlap > 0.8 within 1.5 s) drops the mic line.

## whisper-server

- Word times: `verbose_json` + `token_timestamps` + `split_on_word`. Tokens are merged on leading space. If `words` is missing, commit at **segment** granularity.
- Prompt field name: **`prompt`**. Limit: **224 tokens** (whisper.cpp initial prompt).

## SAVA packaging

Official [inworld-ai/sava](https://github.com/inworld-ai/sava) ships **PyTorch only**. Hirora uses the unofficial Apache-2.0 ONNX at `matthiastl/sava-onnx` (`sava-int8.onnx`, ~27 MB) in-process via `onnxruntime-node` when present. There is **no extra process** to orphan.

```
pnpm exec node tools/fetch-sava-onnx.mjs
```

copies weights into `apps/desktop/resources/sava/` (gitignored). Installer extraResources `sava/`. If the file or runtime is missing, the energy VAD is used and Settings shows a short notice.

## Debug KPI

Perf stage `last_word_to_first_token` (and `stt_window` for per-tick audio length). Performance page / logs.

## Flags off

`SessionController` does not construct `LiveCapture`; `SttStream` + `LocalWhisperTranscriber` behave as in 0.3.1.
