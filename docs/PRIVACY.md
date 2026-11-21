# Privacy

Hirora has no account system, no analytics and no telemetry. The only server involved is **Hirora Cloud** — a small relay the owner runs on Vercel that forwards answer requests and spoken sentences to Groq — and only when you use it (it's the default for new installs). Everything below describes what the app and that relay do.

## What is stored on your PC (`%APPDATA%\Hirora`)

| Data | Where | When |
|---|---|---|
| Settings | `settings.json` | Always |
| API keys | `secrets.json`, encrypted with Windows DPAPI via Electron safeStorage | Only keys you save |
| Documents | `hirora.db` — extracted text chunks, search index, optional embeddings (never a copy of the original file) | Only files you add |
| Profiles, project cards | `hirora.db` | Only what you enter |
| Session history (transcripts, answers) | `hirora.db` | **Off by default**; retention period configurable |
| Timings and usage counters | `hirora.db` (no content) | Always; clearable on the Performance page |
| Logs | `logs/hirora.log` — metadata only, keys redacted | Always (rotated at 5 MB) |

Raw audio is never written to disk. Screenshots are held in memory for up to 5 minutes while you preview them, then discarded.

## What leaves your PC

- **Audio**: only after you press Start *and* confirm the consent prompt; only to the transcription provider you selected (Hirora Cloud → Groq Whisper by default, one finished sentence at a time; Google for Gemini Live; xAI for xAI STT). Silence below the noise gate is not sent.
- **Hirora Cloud relay**: forwards requests to Groq and returns the response. It checks the access code, never logs request or response content, and stores nothing. Groq's own data policy applies to what it processes.
- **Answer requests**: the question, up to a few retrieved document passages (labelled as data), your profile summary (can be disabled), the recent transcript and a short memory of previous answers → your selected answer provider only.
- **Clipboard / screenshots**: only after preview and your explicit Send; possible secrets are flagged and can be redacted first.
- **Embeddings** (optional, off by default): document chunks → Google, once per chunk.

Each provider's own data policy applies to what you send them.

## Deleting data

- A document: Knowledge → trash icon (removes text, index rows and embeddings).
- A session or all history: History page.
- Everything: Settings → Privacy & data → Delete all data (keys, documents, profiles, history, timings, settings).
- Uninstalling keeps `%APPDATA%\Hirora` so a reinstall keeps your setup; delete the folder to remove it.

## Consent and acceptable use

Transcribing other people requires their consent in many places. Many interviews and assessments forbid AI assistance. The screen-capture exclusion setting is a best-effort privacy convenience that some capture paths ignore; it is not a way to hide the use of AI from anyone entitled to know.
