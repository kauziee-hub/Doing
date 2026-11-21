# Acceptance matrix

Legend: ✅ verified (how) · 🟡 partially verified · ⏳ manual test still required · ❌ not met

## Mandatory proof requirements (master prompt)

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Build, lint, typecheck, unit tests pass | ✅ | `pnpm lint`, `pnpm typecheck` (7 projects), Vitest 78, cargo 13 (2026-11-21) |
| 2 | Fresh install opens without keys and shows onboarding | ✅ | `app.e2e.ts` on dev build **and** on the silently installed NSIS build (fresh temp profile). With only the Hirora Cloud access code, a fresh install answers and transcribes (`cloud.e2e.ts`, dev + installed build) |
| 3 | Real mic → STT; speaker playback captured via WASAPI loopback separately | ✅ | `hardware.e2e.ts` (tone via loopback, mic stream separate); `live.e2e.ts` (spoken sentence → loopback → Gemini Live exact transcript). Mic → STT with a human speaker: ⏳ |
| 4 | Question asked aloud → streamed provider text with user key | ✅ | `live.e2e.ts` speaker→loopback→transcript→auto-answer `done` (played TTS audio, not a human voice); same path on Hirora Cloud in `cloud.e2e.ts` (exact Whisper transcript, answer `done`) |
| 5 | Wrong key, quota, timeout, network loss, sleep/resume, device switch | 🟡 | Wrong key ✅ live (xAI `invalid_key`; wrong Hirora Cloud code → `invalid_key`); timeout ✅ live (8 s first-token timeouts observed and surfaced); provider 503 mid-stream ✅ observed live; quota/network loss ✅ fixture tests only; sleep/resume and device switch: code paths implemented, ⏳ manual |
| 6 | Uploaded resume fact retrieved with source; missing fact not invented | ✅ | `live.e2e.ts` — `[S1] fixture-resume p.1`, GPA question answered with "(not in your materials …)" placeholders |
| 7 | Pasted coding question answered, code block copyable; screenshots need approval | ✅ | `live.e2e.ts` coding answer with fenced code; Copy button in renderer; screenshot flow always opens a preview modal (e2e UI) |
| 8 | Overlay hotkeys/drag/multi-monitor, no focus theft | 🟡 | Hotkeys ✅ (real key events, p95 10 ms); `showInactive` everywhere except the explicit "type a question" hotkey; drag/resize ✅ manual; second physical monitor ⏳ |
| 9 | Capture privacy setting tested against available capture paths | ✅ | In-app check: GDI BitBlt and Chromium desktopCapturer both excluded with protection on (Windows build 26300, Electron 45.4.1). Teams/Zoom/Meet/OBS: ⏳ (record results in Settings → Overlay & capture) |
| 10 | Secrets not in bundle/logs/renderer; history deletion works | ✅ | e2e: renderer has no Node/`require`, bridge exposes 4 functions, remote fetch blocked, log/settings scan; asar listing (19 entries, no keys); unit tests for vault + history delete |
| 11 | Installer installs/launches on a clean profile | ✅ | Silent per-user install → e2e suite against installed exe → silent uninstall (registry entry removed). Clean *Windows account*: ⏳ |
| 12 | Document what wasn't runnable | ✅ | This file, `docs/PERF_RESULTS.md`, README limitations |

## QA matrix (implementation plan)

| # | Scenario | Status |
|---|---|---|
| 1 | Fresh install → setup, not blank | ✅ |
| 2 | One key → validated; invalid → clear error, no leakage | ✅ (Gemini valid live; xAI invalid live; error text redacts keys) |
| 3 | USB/Bluetooth mic levels + STT | 🟡 Bluetooth *output* verified; Bluetooth mic selection listed, ⏳ live STT with it |
| 4 | Authorised audio via speakers → loopback transcribes | ✅ |
| 5 | Two sources labelled, no echo loop | 🟡 separate labelled streams ✅; echo when using laptop speakers + mic ⏳ (use headphones) |
| 6 | Ask → stream; cancel and ask again | ✅ live |
| 7 | Resume PDF → grounded detail with reference | ✅ live |
| 8 | Switch provider / invalid condition | 🟡 routing + fallback ✅ unit; only Gemini live |
| 9 | Code/error → explanation, code, tests | ✅ live |
| 10 | Screen context preview + approval; redaction | ✅ (preview modal; secret detector unit-tested) |
| 11 | Capture exclusion vs ≥2 methods with OS/Electron versions | ✅ |
| 12 | Device switch, suspend/resume, network drop | ⏳ manual (auto-pause on suspend, helper restart, STT reconnect with backoff implemented) |
| 13 | Installer on clean profile, no dev tools needed | ✅ (no node_modules packaged; helper bundled) |
| 14 | No raw audio/keys in logs; document delete removes chunks | ✅ |
| 15 | Unit, integration, e2e, perf recorded | ✅ |

## Manual tests still required on your side

1. Speak a question into the mic (headset) during a real call; confirm "Mic" transcript and that auto-answer stays off for mic unless enabled.
2. Unplug/replug a headset and switch the Windows default device mid-session; sleep the laptop and resume.
3. Run the Capture Compatibility Check, then share your screen in Meet/Teams/Zoom with protection on and record what the other side sees (Settings → Overlay & capture → Record manual result).
4. 30-minute soak: start listening, leave a podcast playing, then check `framesDropped` on Home and memory in Task Manager.
5. Add xAI/DeepSeek keys and run `pnpm perf:live`.
6. Have a friend install from https://hirora-one.vercel.app on their own PC, paste the access code, and ask a question while you use it too (concurrent Hirora Cloud use is not measured yet).
