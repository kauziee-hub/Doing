# ADR 0004 — API keys in Electron safeStorage (Windows DPAPI)

**Status:** accepted · 2026-11-19

**Decision.** Keys are entered only in Settings, sent once over validated IPC, encrypted with `safeStorage` (DPAPI, current Windows user) into `%APPDATA%\Hirora\secrets.json`, decrypted only in the main process, and never returned to the renderer (it only sees `hasKey`). Saving is refused when OS encryption is unavailable. Logs and provider errors pass through redaction (Google `AIza…` and `AQ.…`, `xai-…`, `sk-…`, Bearer tokens, `key=`). keytar was not used (archived).

**Consequences.** Keys survive updates and are unreadable to other Windows users. Malware running as the same user could still decrypt them — true of any DPAPI design.
