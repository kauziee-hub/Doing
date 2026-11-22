# Privacy

Hirora has no account system, no server, no analytics and no telemetry. Since 0.3.0 speech recognition and answers run on your PC ([ADR 0012](ADR/0012-local-only-engine.md)): nothing you say, type or upload is sent anywhere.

## What is stored on your PC

| Data | Where | When |
|---|---|---|
| Settings | `%APPDATA%\Hirora\settings.json` | Always |
| Documents | `%APPDATA%\Hirora\hirora.db`: extracted text chunks and a search index (never a copy of the original file) | Only files you add |
| Profiles, project cards | `hirora.db` | Only what you enter |
| Session history (transcripts, answers) | `hirora.db` | **Off by default**; retention period configurable |
| Timings and usage counters | `hirora.db` (no content) | Always; clearable on the Performance page |
| Logs | `%APPDATA%\Hirora\logs\hirora.log`: metadata only | Always (rotated at 5 MB) |
| Engine files | `%LOCALAPPDATA%\Hirora\` (whisper.cpp, Whisper model, Ollama runtime, answer model). If you already use Ollama, its program and model folder (`%USERPROFILE%\.ollama\models`) are shared instead | After setup |

Raw audio is never written to disk. Screenshots are held in memory for up to 5 minutes while you preview them, then discarded.

## What leaves your PC

- **Nothing you say, type or upload.** Audio is captured only after you press Start *and* confirm the consent prompt, and is transcribed by whisper.cpp on `127.0.0.1`. Answers are written by the local model on `127.0.0.1`.
- **The one-time engine download**: whisper.cpp and Ollama from GitHub, the Whisper model from Hugging Face, the Qwen 3.5 model from the Ollama library. These are plain file downloads; no account, key or personal data is involved. Each file is checked against its published SHA-256.

## Deleting data

- A document: Knowledge → trash icon (removes its text and index rows).
- A session or all history: History page.
- Everything: Settings → Privacy & data → Delete all data (documents, profiles, history, timings, settings, and any API keys an older version saved).
- Uninstalling keeps `%APPDATA%\Hirora` and the engine files so a reinstall keeps your setup; delete `%APPDATA%\Hirora` and `%LOCALAPPDATA%\Hirora` to remove them.

## Consent and acceptable use

Transcribing other people requires their consent in many places. Many interviews and assessments forbid AI assistance. The screen-capture exclusion setting is a best-effort privacy convenience that some capture paths ignore; it is not a way to hide the use of AI from anyone entitled to know.
