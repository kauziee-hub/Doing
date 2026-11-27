# Privacy

Doing has no account system, no server, no analytics and no telemetry. Since 0.3.0 speech recognition and answers run on your PC ([ADR 0012](ADR/0012-local-only-engine.md)): prompts are not sent to a cloud model. Browser actions you request can send information to their websites.

## What is stored on your PC

| Data | Where | When |
|---|---|---|
| Settings | `%APPDATA%\Hirora\settings.json` | Always |
| Remembered browser credential | `%APPDATA%\Hirora\browser-connection.bin` (Windows DPAPI encrypted); companion's restricted local storage (never sync) | Only after approving a browser connection; removed by Forget browser / Forget connection |
| Documents | `%APPDATA%\Hirora\hirora.db`: extracted text chunks and a search index (never a copy of the original file) | Only files you add |
| Assistant files | The folder you allow; real edits on disk | Only when requested; Undo in memory for the session |
| Profiles, project cards | `hirora.db` | Only what you enter |
| Session history (transcripts, answers) | `hirora.db` | **Off by default**; retention period configurable |
| Timings and usage counters | `hirora.db` (no content) | Always; clearable on the Performance page |
| Logs | `%APPDATA%\Hirora\logs\hirora.log`: metadata only | Always (rotated at 5 MB) |
| Engine files | `%LOCALAPPDATA%\Hirora\` (whisper.cpp, Whisper model, Ollama runtime, answer model). If you already use Ollama, its program and model folder (`%USERPROFILE%\.ollama\models`) are shared instead | After setup |

Raw audio is never written to disk. Screenshots are held in memory for up to 5 minutes while you preview them, then discarded.

Assistant and browser conversations, observations and file Undo records stay in memory. Folder access is granted through a native picker and is not restored after restart. Closing the app or revoking the folder clears that access.

## What leaves your PC

**Optional browser chat:** approve and remember the companion once, then allow individual tabs in its side panel (up to eight). Chrome may request permission for each site's origin; Doing reads only the tabs you explicitly add, until access is revoked or the browser/worker restarts. Visible text and form/editor state go only to the model on your PC. Questions are answered in chat; requests to fill, click or type authorize a task. Submission requires an instruction in the current message or later chat approval. This is separate from audio/screenshot settings. Conversation, observations and task progress stay in memory, not on disk. If you request submission, entered answers/application details are sent to that website. **Forget browser & revoke access** closes the local bridge and removes the remembered credential and task state. Chrome's separately granted site permissions can be removed in extension settings. See [browser permissions and limits](BROWSER_ASSISTANT.md).

- **Local model processing.** Audio is captured only after you press Start *and* confirm the consent prompt, and is transcribed by whisper.cpp on `127.0.0.1`. Answers are written by the local model on `127.0.0.1`.
- **The one-time engine download**: whisper.cpp and Ollama from GitHub, the Whisper model from Hugging Face, the Qwen 3.5 model from the Ollama library. These are plain file downloads; no account, key or personal data is involved. Each file is checked against its published SHA-256.

- **Optional updates:** a daily GitHub release check sends the app version; updates download only when requested and are checked against their SHA-256. Disable checks in Settings → Updates.

## Deleting data

- A document: Library → Documents → trash icon (removes its text and index rows).
- A session or all history: History page.
- Everything: Settings → Privacy & data → Delete all data (documents, profiles, history, timings, settings, and any API keys an older version saved).
- Uninstalling keeps `%APPDATA%\Hirora` and the engine files so a reinstall keeps your setup; delete `%APPDATA%\Hirora` and `%LOCALAPPDATA%\Hirora` to remove them.

## Consent and acceptable use

Transcribing other people requires their consent in many places. Many interviews and assessments forbid AI assistance. The screen-capture exclusion setting is a best-effort privacy convenience that some capture paths ignore; it is not a way to hide the use of AI from anyone entitled to know.
