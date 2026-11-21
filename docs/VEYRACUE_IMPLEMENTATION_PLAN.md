# VEYRACUE — Implementation Blueprint
**Working name:** VeyraCue  
**Product:** Windows-first, local-first, real-time AI desktop copilot  
**Target platform:** Windows 11 x64; other platforms explicitly out of scope for v1  
**Version:** Initial architecture / November 2026  
**Goal:** Working, installable application rather than a UI prototype.

## Product vision
Build an independent, original, premium desktop assistant for authorised interviews, practice, meetings, presentations, coding and knowledge-based Q&A. It listens to user-approved microphone and speaker audio sources, creates live transcripts, detects questions, retrieves useful context from user-uploaded material, and streams concise suggested answers into a lightweight desktop overlay. It must support multiple model providers, explicit source and privacy controls, and truthful status reporting. Do not copy proprietary Parakeet AI source code, trade dress, assets, branding or exact layouts.

**Product promise:** fast, useful, source-grounded, under user control. **Not a promise:** zero latency, guaranteed screen-share invisibility, unlimited model accuracy or permission to use AI in restricted evaluations. The app should respect interview/assessment rules and other participants' recording consent.

## User experience

### Onboarding and setup
1. Open application; choose language, audio devices and mode.
2. Add Gemini, xAI and/or DeepSeek key through secure Settings (the app never ships with keys).
3. Verify credentials with a lightweight, visible provider connection test. Offer a model selector using currently available provider models, not hard-coded imaginary names.
4. Upload resume, personal profile, job description and project files. Show indexing progress, parsed document preview and ability to remove files or snippets.
5. Create company/interview profiles containing company, job role, interview type, tone, length, technical depth and allowed/reference resources.
6. Enter a consent-aware session by pressing Start. Make the recording indicators and source toggles unambiguous.

### Session experience
- Collapsible/expandable, resizable, draggable, always-on-top overlay. Multiple monitors; saved placement; zoom/font scaling; keyboard-only support and no focus theft when audio streams update.
- Sources status (mic, desktop audio, STT, model, RAG), live partial transcript, question candidate, current answer streamed as it arrives, 'talking points' and optional expanded explanation.
- A clear manual Ask shortcut, Pause, Stop, New Question, Copy Answer, Pin and History.
- Optional screen-context action with an explicit screenshot/selected text/clipboard preview and confirmation before sending it to a provider. Explain when screenshots can include private information.
- Response modes: Interview Practice, Coding Assistant, Explain/Teach, General Q&A, Meeting Notes. The app should not automatically activate covert assistance in restricted assessments.
- Truthfulness: answers should distinguish direct document claims, general knowledge, and uncertain guesses. Never invent the user's projects, credentials, metrics or company research.

### Screen-capture behaviour
- Implement the platform's documented display-affinity/content-protection option as a **privacy control**, configurable and off if unsupported.
- On Electron for Windows, `setContentProtection(true)` invokes `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` when supported. This is best-effort, not guaranteed across all capture APIs, apps, remote desktop sessions or cameras.
- Provide an explicit **Capture Compatibility Check** with a local preview or guided manual tests of approved conferencing/recording software. Display `supported`, `unsupported`, or `not verified`; never `undetectable`.
- Do not implement evasion of proctoring, assessment controls, monitoring agents or security software. Do not attempt to disable third-party recording or auditing.

## v1 feature requirements

### A. Real-time audio
- Microphone input with device selection, adjustable gain, input-level visualisation and permission/error states.
- Windows WASAPI loopback capture for output device and, where supported, per-process isolation. Separate speaker and microphone streams, preserve source IDs and timestamps.
- Native Rust/Windows helper recommended for Windows-specific capture and realtime buffering. Use the current maintained `windows` crate or documented OS APIs. Prefer a stable, small native sidecar over repeatedly spawning ffmpeg for audio chunks.
- Push 20–40 ms PCM frames through bounded buffers into an audio worker / STT adapter. Convert to provider-required encoding/resampling without accumulating unbounded audio.
- Audio routing state machine: disconnected, permission-needed, connecting, ready, streaming, muted, reconnecting, failed.
- Support hot-plug device changes, output device changes, sleep/resume, sample-rate conversion, headset/Bluetooth, noise, and silent audio.
- Explicit consent; recording defaults off at app start; raw audio not persisted unless opted in.

### B. Speech recognition and question segmentation
- Streaming STT with partial and final transcripts, source attribution and token-alignment timestamps where supported.
- Initial streaming STT adapter: Gemini 3.5 Transcribe Live or another verified up-to-date streaming transcription API. A single live model may support transcripts, but separate STT and LLM must be possible because DeepSeek text models do not directly solve microphone streaming.
- Live microphone and loopback transcripts stay separate; never assume source speaker = interviewer.
- Detect interrogative intent from incremental transcript using cheap linguistic checks plus a lightweight classifier or provider check; always allow manual Ask and correction.
- Stabilize utterances using VAD/turn detection; avoid premature finalization when the user pauses. Support interruption, cancellation, and revised question text. Show what was actually heard.

### C. AI orchestration
- Provider-neutral typed `TextModelProvider` and `TranscriptionProvider` contracts with streaming, abort, health checks, usage, cost and structured error mappings.
- Gemini text models, xAI/Grok text models, DeepSeek chat models. Support a guarded custom OpenAI-compatible endpoint (for authorised user-configured providers only).
- Provider choice must be independent from STT choice. One provider failing must not crash the audio session.
- Preconnect/prewarm streaming sessions where supported; never send user audio until they explicitly start a session.
- Construct answers from session profile, most relevant document snippets, latest question and limited conversation memory. Minimize input context for speed.
- Streaming markdown/coded text renderer, formatted code blocks with copy action, answer summary first, progressive details second.
- Cooperative cancellation via AbortController, stale-result rejection by request ID, debouncing, backpressure and sequence-numbered event processing.
- Fast mode and Deep mode: Fast produces short cues; Deep provides richer explanation on demand. Do not claim a thinking model will always match fast-mode latency.
- No fabricated company specifics, resume achievements, citations or tool results. If the needed evidence is absent, say so.

### D. Personal knowledge (RAG)
- File types: PDF, DOCX, TXT, Markdown, CSV, JSON and plain-text code; images with opt-in vision extraction; PDF OCR where needed and available.
- Local parse, chunk, dedupe, version and index. Show exact source titles and passages in the answer context UI.
- SQLite for sessions/config/document metadata, FTS5 for keyword retrieval; vectors optional using a maintained local embedding/vector module with an exact benchmark. Start with hybrid FTS + embeddings, rerank top passages, and inspect relevance.
- Clear `my facts` vs `general background` vs `company/job inputs`; tags include source file, page/section, modification date and confidence.
- Support fact editing, project STAR stories, preference profiles, and deletion that removes original, extracted and indexed data.
- Avoid indexing or transmitting confidential employer material unless the user is authorised to do so.

### E. Coding assistance
- Coding mode supports written questions, allowed clipboard/selection context, manually supplied screenshot, pasted stack traces, SQL, Python, JavaScript/TypeScript, C++, Java and process-engineering calculations.
- Show reasoning-level explanation, algorithm, edge cases, complexities, optional code, tests and direct answers, depending on selected tone/length.
- Optional secure local workspace connector is read-only by default; do not perform automatic code execution, shell actions, file modifications or privileged access without a separate explicit permission.
- Do not copy or leak secrets from a user's editor, screenshot or workspace. Detect likely secrets in captured content and prompt for redaction.

### F. Privacy, safety, security
- No credentials in app bundles, frontend storage, analytics, stdout or crash logs. Encrypt locally and use Windows Credential Manager via a maintained trusted library/OS implementation. Never log raw API credentials.
- Electron `contextIsolation=true`, `sandbox=true`, `nodeIntegration=false`; restricted IPC allowlist, schema validate payloads, CSP, no arbitrary remote content, sanitized markdown, dependency audits and signed builds where feasible.
- Use provider-specific ephemeral tokens only if the provider supports and documents them; key-based direct communication must not expose keys in an untrusted renderer.
- Local data by default. Opt-in history recording, session retention, privacy policy and data export/delete. Give user a clear indicator while audio or screen capture is active.
- Send only the required text snippets or user-approved image to the selected model; include per-provider data sharing disclosures in Settings.
- Use explicit failure UX for network outage, provider quota, invalid key, device loss and model timeout. Do not silently fake a response.

## Technical architecture

```
Windows microphone ─┐
                    ├─> Rust audio helper (WASAPI, ring buffers, timestamping)
Windows loopback ───┘                │
                                    ▼
                           local framed IPC
                                    │
                  ┌─────────────────┴─────────────────┐
                  ▼                                   ▼
             audio meters                 streaming STT adapter
                                                      │
                                             partial/final text
                                                      │
                                            utterance detector
                                                      │
                                 ┌────────────────────┴────────────┐
                                 ▼                                 ▼
                         manual Ask input                   mode classifier
                                 └────────────────────┬────────────┘
                                                      ▼
               SQLite/FTS + vectors -> retrieval -> answer orchestrator
                                                      │
                                  Gemini | Grok | DeepSeek | Custom
                                                      │
                                              streamed answer
                                                      ▼
                                 Electron main -> restricted IPC
                                                      ▼
                                     React floating overlay
```

### Recommended repository
```
veyracue/
├── CLAUDE.md
├── README.md
├── package.json
├── pnpm-workspace.yaml
├── apps/
│   └── desktop/
│       ├── electron/             # main/preload, window manager, security
│       ├── src/                  # React UI, routes, settings, overlay
│       └── resources/            # icons/installer assets
├── native/
│   └── windows-audio/            # Rust WASAPI helper + IPC framing
├── packages/
│   ├── contracts/                # TypeScript interfaces + schemas
│   ├── providers/                # STT/LLM provider adapters
│   ├── knowledge/                # ingestion, FTS5, embeddings, retrieval
│   ├── orchestration/            # VAD turns, Q detection, RAG+LLM stream
│   ├── settings/                 # config, secrets, migrations
│   └── ui/                       # shared accessible components
├── tests/
│   ├── fixtures/                 # prerecorded authorized sample audio
│   ├── integration/
│   ├── e2e/
│   └── performance/
├── tools/                         # release, diagnostics, benchmark scripts
└── docs/
    ├── ADR/                     # architecture decision records
    ├── PRIVACY.md
    ├── TROUBLESHOOTING.md
    ├── ACCEPTANCE.md
    └── PERF_RESULTS.md
```

- Toolchain: TypeScript strict, Electron + React + Vite/electron-vite, pnpm, Zod, SQLite, Vitest, Playwright/Electron automation where supported, electron-builder, Rust stable + cargo, Windows 11 CI runner.
- Packaging: signed if credentials available; if not, build clearly marked unsigned Windows installer and document SmartScreen effects.
- No separate cloud backend is required for first-run BYOK local mode. Add FastAPI/PostgreSQL only if there is an actual server feature that justifies it.

## Latency engineering (targets, not promises)

| Signal | Design target | How measured |
|---|---:|---|
| Hotkey -> visible UI | p95 <100 ms | instrumentation from OS event to paint |
| Audio frame duration | 20–40 ms | timestamped source frames |
| Partial transcript after audible content | p50 <500 ms where provider/network permit | fixture reference timing + capture/log boundaries |
| Question final -> first useful text | p50 <1.5 s, p95 <3.5 s under defined test network | 50+ full end-to-end runs |
| Audio drop/overrun rate | <0.1% during 30-min load run | capture helper counters |
| UI freezing | no >100 ms main-thread tasks in ordinary streaming | Electron profiling |

Techniques: preconnect, small capture chunks, VAD, incremental partial transcripts, parallel lightweight retrieval, cache index in memory, cached company/profile summary, no repeated document parsing during a live session, short first answer, stream updates in batches at ~30–60 Hz, compute work outside renderer, abort stale requests, bounded queue and jitter buffer, structured timing spans for each pipeline stage. No fake cached answers in live benchmark. Include slow network, provider quota, and model changes.

## Delivery plan and gates

### Gate 0 — Discovery and decisions
- Inspect starting repo; check environment and current SDK/OS docs; verify official provider API shapes and model availability.
- Record ADRs for Electron/Rust, STT provider and offline RAG; create UI flow and reliable minimal architecture.
- Scaffold project, add formatting, strict types, builds, CI, launch skeleton.
**Gate:** `pnpm install`, `pnpm dev`, `pnpm typecheck` succeed on Windows; actual Electron app launches.

### Gate 1 — Desktop shell
- Dashboard, profiles, settings, movable overlay, hotkeys, tray, persistence, notification and keyboard focus.
- Include capture compatibility setting and verify documented API; do not promise invisibility.
**Gate:** multi-monitor manual test; no focus theft; hotkeys actionable; restart restores state.

### Gate 2 — Audio and transcription
- Rust microphone and WASAPI loopback, local IPC, levels, source selection, STT adapter and transcript rendering.
**Gate:** recorded real input + output-device playback transcribe correctly; errors actionable; 30-min soak without leaks; no fake demo transcript.

### Gate 3 — Answers, profiles, retrieval
- Provider routing, streamed answer, cancel/retry/failover, PDF/DOCX/etc ingestion, FTS+vector retrieval, profile settings, citations.
**Gate:** new document influences answer with source reference; missing fact not invented; real streaming works with user-supplied key.

### Gate 4 — Coding and context
- Ask hotkey, code formatting, selection/clipboard import, optional screen snapshot review, coding prompt modes.
**Gate:** solution and explanation for a known offline coding fixture; no unapproved capture or file writes.

### Gate 5 — Polish and stability
- Loading/error design, keyboard accessibility, privacy/export/delete, billing guardrails, tests, installer, CI, performance reports.
**Gate:** complete Windows installer that starts outside development; all essential journeys demonstrated with proof.

## QA / acceptance matrix
1. Fresh install -> app launches with no API keys, shows setup, not a blank screen.
2. Enter one key -> validated connection; invalid key -> clear error and no leakage.
3. Attach USB/Bluetooth microphone -> select and show actual levels; speech causes live STT.
4. Play authorized sample audio through speakers/headphones -> loopback captures and transcribes; not just microphone pickup.
5. Two sources active -> ordered, labelled transcripts; no duplicate/echo loop.
6. Ask question -> overlay receives streamed text; cancel and ask again works.
7. Upload resume/project PDF -> query retrieves source-grounded detail with reference.
8. Switch model provider -> model adapter works, or unsupported/invalid condition shows correctly.
9. Paste code/error -> coding answer includes explanation, code and test cases.
10. Screen context requires preview and approval; redaction available.
11. Capture exclusion tested against at least two accessible capture methods; report pass/fail and OS/Electron versions; never claim universal invisible status.
12. Switch devices mid-session; suspend/resume laptop; drop network -> app recovers or gives clear error.
13. Installer runs on clean Windows user profile; no server, Docker or development tools required at runtime unless explicitly documented.
14. No raw audio or API keys in normal logs; document delete removes source and extracted chunks; history disabled persists nothing beyond settings/necessary metadata.
15. Run unit, integration, e2e, performance tests; record command outputs and actual limitations.

## Claude Code execution policy
Claude should plan briefly, then implement gate by gate. It can make design decisions under the vision, write tests, run commands, debug failures, and change architecture when evidence supports it. It must **not** substitute mocked interfaces for working native audio or API connectivity, misrepresent screenshots as tested capture exclusion, claim 'production ready' without an installer and tests, or claim zero delay. If API credentials, physical audio devices, Windows or signing certificates are unavailable, it must complete all testable parts, produce reproducible setup instructions, and explicitly list the remaining end-user tests. Never commit secrets or destroy unrelated files.

## Official source references (verify latest at implementation time)
- Electron BrowserWindow: https://www.electronjs.org/docs/latest/api/browser-window/
- Electron security: https://www.electronjs.org/docs/latest/tutorial/security
- Windows WASAPI loopback: https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording
- Windows capture affinity: https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity
- Google Gemini Live: https://ai.google.dev/gemini-api/docs/live
- Google Gemini audio: https://blog.google/innovation-and-ai/technology/developers-tools/build-real-time-voice-applications-gemini-audio/
- xAI Voice: https://docs.x.ai/developers/model-capabilities/audio/voice
- DeepSeek API: https://api-docs.deepseek.com/api/create-chat-completion/
- Claude Code guidance: https://claude.com/resources/articles/steering-claude-code-skills-hooks-rules-subagents-and-more
