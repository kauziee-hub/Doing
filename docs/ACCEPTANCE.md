# Acceptance matrix (0.3.0, local-only engine)

Legend: ✅ verified (how) · 🟡 partially verified · ⏳ manual test still required · ❌ not met

## Mandatory proof requirements (master prompt, as amended by ADR 0012)

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Build, lint, typecheck, unit tests pass | ✅ | `pnpm lint`, `pnpm typecheck`, Vitest 124, cargo 15 (2026-11-22) |
| 2 | Fresh install opens with a one-click setup and no keys anywhere | ✅ | `app.e2e.ts` with an empty engine folder (no Ollama, no models): onboarding Welcome → Set up lists the four real components, hardware and download size; no "API key"/"access code" text; Home shows the setup card and Start is disabled until the engine is ready. Same suite on the packaged 0.3.0 app (`win-unpacked`): 9/9 with `capture.e2e.ts`. |
| 3 | First-run setup really installs a working engine | ✅ | `tools/engine-setup-check.mjs` on an empty folder with real downloads: CPU tier, real network: Ollama runtime 1.62 GB in 6 min, SHA-256 checked, unpacked in 6 s; whisper.cpp CPU build and model; `qwen3.5:2b` pulled; ready after 1025 s and answered typed questions. After the catalog changed (`qwen3:1.7b`, Whisper small) the same folder downloaded only the changed parts. GPU-tier files: the whisper.cpp CUDA zip and large-v3-turbo model on this PC match the catalog's size and SHA-256 exactly. |
| 4 | Real mic → STT; speaker playback captured via WASAPI loopback separately | ✅ | `hardware.e2e.ts` (tone via loopback, mic stream separate); `tools/interview-check.mjs` (spoken questions → loopback → whisper.cpp on this PC → exact transcripts). Mic → STT with a human speaker: ⏳ |
| 5 | Question asked aloud → streamed local answer | ✅ | `tools/interview-check.mjs`: installed 0.3.0, GPU tier: three SAPI questions through the speakers → exact transcripts → answers from the résumé (the early answer appeared 0.30 s after the speaker stopped; answers that waited for the final transcript started 1.2–2.7 s after); processor only (all GPUs hidden, laptop on battery): spoken questions transcribed exactly with Whisper small and answered 2.3–3.6 s after the speaker stopped; typed questions 0.41–0.60 s once warm |
| 6 | Engine missing / not running / interrupted setup | ✅ | Typed question before setup → "not set up yet … press Set up" (e2e); Start refused with a toast until ready; interrupted downloads resume via HTTP Range and bad checksums are deleted (unit tests with a fixture server); sleep/resume and device switch: code paths implemented, ⏳ manual |
| 7 | Uploaded résumé fact used; missing fact not invented | ✅ | interview-check on a profile copy: "introduce yourself" answered from the résumé; the missing-fact guard from 0.2.4 is unchanged (unit tests) |
| 8 | Coding question answered, code block copyable; screenshots need approval | ✅ | Coding answer from the local model (`tools/site-shots.mjs`); screenshot flow always opens a preview modal (e2e UI); `qwen3.5` models report vision support |
| 8b | One assistant, no modes; a question about the shared screen is answered from it | ✅ | 0.3.1: no mode picker anywhere (`app.e2e.ts` checks Settings → Answers); prompt tests cover every request type. `tools/screen-check.mjs` (dev build, AC): code shown full-screen in Edge, "Can you establish an RBAC protocol in this?" and "Which of these routes should only an admin be allowed to call?" used the screen and named `deleteOrder`, `issueRefund`, `/refunds/:orderId`; "What is RBAC?" did not capture. Same result on the final installed 0.3.1 with the test window pinned on top; with a notes page on screen instead, the route question got "I can't see any code or routes on that screen…". A live Meet/Teams share: *manual, not yet done*. |
| 9 | Overlay hotkeys, no focus theft, screen-share exclusion | 🟡 | Hotkeys ✅; `capture.e2e.ts` against a real Chrome/Edge `getDisplayMedia` share ✅; live Meet/Teams/Zoom call and a second physical monitor: ⏳ |
| 10 | Nothing leaves the PC; no secrets in bundle/logs/renderer | ✅ | Engine servers bind 127.0.0.1 only (`validateLocalBaseUrl` rejects anything else, unit-tested); no IPC channel accepts keys or provider choices (unit test); e2e checks settings on disk contain no provider/cloud/budget fields and no `secrets.json` |
| 11 | Installer installs/launches on a clean profile | ✅ | Packaged app e2e (`HIRORA_E2E_EXE=…/win-unpacked/Hirora.exe`); installing over a running Hirora is avoided |
| 12 | Document what wasn't runnable | ✅ | This file, `docs/PERF_RESULTS.md`, README limitations |

## Manual tests still required on your side

1. Plug the laptop in and use Hirora in a real Meet call: speak a question into the mic and have someone ask questions; confirm the transcript and answers, and that a phone viewing your screen share doesn't show the overlay.
2. Unplug/replug a headset and switch the Windows default device mid-session; sleep the laptop and resume.
3. A friend installs from https://hirora-one.vercel.app on their own PC (ideally one without an NVIDIA GPU) and presses Set up.
4. 30-minute soak: start listening, leave a podcast playing, then check `framesDropped` on Home and memory in Task Manager.
