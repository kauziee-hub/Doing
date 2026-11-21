# Master build prompt for Claude Code — VEYRACUE

> **Usage:** Place this document in the root of a fresh repository. Open Claude Code in that repository and paste the contents after the separator below. Keep the companion `VEYRACUE_IMPLEMENTATION_PLAN.md` alongside it if available. You may use the product name **VeyraCue** provisionally; no trademark clearance has been completed.

---

You are the lead staff engineer, real-time systems architect, product designer, Windows native engineer, security engineer, and QA lead responsible for delivering **VEYRA CUE / VeyraCue**, a complete Windows 11 x64 real-time AI desktop copilot. You have agency to make technical decisions, review current official documentation and correct bad initial assumptions. Do not merely produce a plan, mockup or placeholder. **Build, run, test, debug, package and document the actual application** to the greatest extent the environment permits.

## Your mandate

Create an original, high-quality local-first alternative in the general category of AI interview/coding/meeting desktop assistants. Do not copy any company's copyrighted source code, logos, UI assets or trade dress. Product uses user-selected provider API keys (Gemini, Grok/xAI and DeepSeek) and personal knowledge (resume, project files, company/job profiles). On permitted audio capture it generates partial transcripts and streams short grounded responses into a floating desktop UI. It also supports manual coding questions and explicitly approved screen/clipboard context.

**Performance ambition:** near-immediate visible transcription and streamed answers, but not literal zero latency. Measure every stage and publish real p50/p95 results. **Screen sharing:** support documented Windows/Electron display-capture exclusion only as a best-effort privacy control, report compatibility honestly, never claim undetectability, and do not develop techniques to evade monitoring, proctoring or security tools. Build for consent-aware, authorised usage.

## Priority order
1. Working native audio and live model pipeline (not UI fakery).
2. Fast, reliable streaming and correct cancellation.
3. Security, privacy and accurate data grounding.
4. Beautiful low-distraction overlay and settings.
5. Multiple providers, coding mode, robustness and installer.

## Engineering freedom and anti-hallucination rules
- First inspect the repository, OS/toolchain and any existing code. Respect good working implementations; do not wipe an existing repo.
- Read `VEYRACUE_IMPLEMENTATION_PLAN.md` if present and treat it as the product specification, with freedom to improve implementation details by written ADR.
- Inspect current **official** docs for API models, audio input schemas, authentication, versions and SDK limitations before writing integrations. Do not invent model IDs, API routes or unsupported Electron flags.
- Create a concise executable roadmap, write `CLAUDE.md` with conventions and acceptance gates, and record decisions in `docs/ADR/`. Then **execute** the roadmap in working increments. Prioritise vertical slices with demonstrably real data.
- Delegate bounded research/review tasks to subagents if useful, but keep one integration owner. No parallel writes to overlapping files. Avoid ceremonial agents.
- Avoid unnecessary clarifying questions. Default to Windows 11 x64, personal BYOK, TypeScript/Electron + React, Rust native Windows audio helper, SQLite, pnpm. Ask only for genuinely indispensable user inputs (such as API credentials), via the finished application's UI; never request keys to be pasted into the transcript.
- You may run tests, create/edit code, install dependencies, manage local configuration and build artifacts. Do not deploy cloud resources, purchase services, store sensitive credentials in repo, or delete unrelated user data. Honour existing environment security boundaries.
- No fake 'working' demo: fixture tests must be clearly labelled fixtures; no synthetic transcript or canned answer in production runtime. Never mark an untested feature as complete.
- If an environment lacks Windows hardware or keys, build/test all possible parts and document precise manual Windows acceptance steps and remaining blockers rather than asserting success.

## Implement the application, not merely its marketing

### Desktop foundation
- Electron main/preload + React/TypeScript renderer with strict typing, sandboxing, context isolation, safe allowlisted IPC and CSP.
- Main dashboard with session history and profiles; settings with provider credentials, models, STT, microphones/speaker devices, privacy and hotkeys.
- Native-looking minimal premium UI, useful empty states, graceful error states, accessible fonts and keyboard navigation; no intrusive animations.
- Desktop overlay: adjustable size/position/opacity, compact/expanded, multi-monitor/DPI aware, pinned always-on-top, global keyboard shortcuts, readable streamed transcript and answer, model/source indicators, user-triggered minimize/hide/pause, focus-safe updates, tray icon and persistence.
- Capture compatibility option: use only documented Electron `win.setContentProtection(true)` where supported; expose version-specific test results and clear `not verified` state. Do not promise invisibility. No attempts to bypass proctoring or security/monitoring software.

### Audio capture and STT (critical path)
- Create a small robust Windows Rust native audio process using WASAPI for microphone capture and speaker loopback capture, with bounded ring buffers and a framed IPC protocol to the Electron backend. Preserve each stream's source ID and monotonic timestamp. Use current maintained Windows APIs/crates. If per-process audio loopback is available, allow it; support device-level fallback.
- Audio device list, switch, meters, noise handling, mute, start/stop, fault recovery, default-device changes, Bluetooth/headset support, laptop sleep/resume.
- Stream ~20–40ms frames; resample to API-required format without per-chunk process spawn. Use backpressure and resource counters. No audio streaming before explicit user start. Do not persist raw audio by default.
- Implement a true streaming transcription provider with interim and final text. Verify latest Google Gemini streaming transcription integration, and ensure adapter interface accommodates other providers. Keep microphone and speaker transcripts distinguishable. Include explicit consent/recording indicator.
- Incremental utterance detection/question detection with VAD, false-start handling, follow-up question grouping and manual 'Ask' fallback. Use abortable request IDs to ensure late old answers cannot overwrite new ones.

### Fast model pipeline
- Interfaces: `TextModelProvider`, `StreamingTranscriptionProvider`, `EmbeddingProvider`, `KnowledgeRetriever`, `SessionController`; typed events and Zod validation at IPC boundaries.
- Implement Gemini, xAI/Grok and DeepSeek text provider adapters, with real token streaming, model selection, key validation and structured errors. STT choice independent of answer model. Optional custom OpenAI-compatible text endpoint with secure configuration.
- Add provider health/backoff, timeout, cancellation, one retry where safe, visible fallback strategy, quota/cost tracker and explicit error badges. No silent fabricated fallback responses.
- Preconnect at session start; cache validated profile summary and search index; use fast short prompt first and let the user expand for in-depth explanation. Stream partial tokens immediately. Performance events for capture -> STT partial/final -> question candidate -> RAG retrieval -> LLM request -> first token -> answer completion -> UI paint.
- Maintain context for follow-up questions without growing indefinitely. Include confidence and provenance, and decline to invent missing CV/project facts. Ensure user-supplied document content is treated as data, not untrusted instructions that can override system or tool policies.

### Knowledge upload / personalisation
- Supported file ingestion: PDF, DOCX, MD, TXT, CSV, JSON and code/text. Provide previews, validation, ingestion errors, dedupe and deletion. For images, explicit vision approval.
- SQLite for profile/document/session/metadata with migrations; full-text retrieval via FTS5; add a maintained vector approach if practical after relevance and latency benchmarks, with hybrid retrieval/reranking. Store source trace (file/page/chunk) for each retrieved fact. Retrieval should work even if embedding service is unavailable.
- Add personal profile and reusable project cards: project, role, technologies, measurable outcomes, evidence, STAR story and privacy visibility. Company + job description, desired tone, speaking style, answer length, response format, language, technical difficulty and whether coding answer should include tests.
- Answer engine should prefer user-uploaded evidence for first-person experience; distinguish external knowledge from profile facts; surface sources to user. Do not fabricate achievements, dates or employer details.

### Coding and general-purpose assistance
- Modes: Interview Practice / Live Authorised Copilot / Coding / Explain / General Q&A / Meeting Notes.
- Manual Ask works with text typed or selected, optionally user-reviewed clipboard and user-approved screenshot. Do not scrape screens silently or transmit unrelated window content. Detect possible secrets and enable redaction.
- Coding outputs: brief answer, algorithm explanation, code block, complexity, test cases and debugging steps. Support Python/SQL/JS/TS/C++/Java among others. Offer 'Explain to beginner' and 'Make concise' quick actions.
- File-system/code workspace access read-only by default and must require explicit permission before writing/running anything.

### Production security and privacy
- Electron main process handles secrets, OS credential vault, model networking and filesystem; do not expose credentials to renderer. Do not put secrets in source, bundled settings, log output or session files.
- Restrict/sanitize markdown and IPC; enforce content security policy; do not load arbitrary remote HTML. Check dependencies for vulnerabilities.
- First run without API key must still be fully navigable and should show actionable setup. Key test UI. Provider failures must not freeze UI.
- Local-first storage, opt-in transcript/history persistence, explicit deletion, no audio recording by default, consent indicators, data send preview/controls.
- Add user-visible cost/budget controls; default conservative. No unnecessary cloud backend for v1.

### App architecture / files
Default monorepo unless existing project dictates otherwise:
```
apps/desktop          Electron + React + Vite
native/windows-audio  Rust WASAPI helper
packages/contracts    types/schemas/events
packages/providers    STT + text models
packages/knowledge    file parsing, SQLite, FTS, embeddings
packages/orchestration session/question/RAG/LLM routing
packages/settings     configuration and secrets
packages/ui           reusable UI components
tests/{fixtures,integration,e2e,performance}
docs/{ADR,ACCEPTANCE,PERF_RESULTS,PRIVACY,TROUBLESHOOTING}
```
Use maintained tools verified against 2026 docs, e.g. pnpm, strict TypeScript, Zod, Vitest, Playwright for Electron where supported, `electron-builder`, cargo tests and a Windows CI workflow. If a proposed tool is unsupported, replace it and document the trade-off. Build scripts should include `pnpm dev`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm package:win`, `pnpm perf` (or clearly documented equivalent commands).

## Mandatory build order (do not stop at planning)
**Phase 0:** inspect the repo/toolchain and official docs; ADRs, architecture diagram, acceptance tests and scaffold. Launch genuine Electron shell.
**Phase 1:** tray/overlay/dashboard/settings/profiles/hotkeys, persistence and content-protection capability checks. Verify multi-monitor/focus.
**Phase 2:** native Windows mic/loopback helper and real STT. Show source-labelled actual transcripts. Soak test.
**Phase 3:** connected real provider with stream token output. Add provider switching and robust cancellation/error states.
**Phase 4:** working upload/parser/RAG and company+personal profiles. Source-grounded answers and first-person fact constraints.
**Phase 5:** coding mode, manual Ask, opt-in screen/clipboard context, code renderer and answer styles.
**Phase 6:** finish multi-provider adapters, security, performance instrumentation, logs, recovery, privacy controls.
**Phase 7:** test entire installable app, build unsigned installer (or signed if cert provided), docs, release checklist, changelog, actual benchmark report.

Each phase must end with runnable code and automated checks. Fix regressions before continuing. If time or tooling is constrained, deliver working vertical slices rather than a broad fake UI.

## Numerical performance aspirations
- UI hotkey-to-paint p95 <100ms.
- Audio 20–40ms chunks with bounded queue and <0.1% dropped chunks under a 30min local soak.
- Interim transcript p50 <500ms where network/provider permit.
- From question end to first useful streamed answer p50 <1.5s, p95 <3.5s under well-defined connectivity. Do not hard-code this as a guaranteed SLA.
- Log timings for real repeated tests, including cold startup, warm provider, simple query, RAG query, long technical/coding query, provider failover and weak network. The performance dashboard must show actual observed data, never invented figures.

## Mandatory test and proof requirements
1. Build, lint, typecheck and unit tests actually pass.
2. Fresh install opens without keys and reveals onboarding.
3. Real microphone recording causes audible STT update; actual speaker playback via WASAPI loopback captured separately.
4. Ask a sample question aloud and see actual streamed provider text with a user-entered key.
5. Wrong key, quota, timeout, network loss, sleep/resume and device switch behave gracefully.
6. Uploaded resume/PDF fact is retrieved in response with source, and missing fact is not made up.
7. Pasted coding question is answered and its code block is copyable; screenshots require approval.
8. Overlay supports hotkeys/drag/multi-monitor and does not steal focus during normal updates.
9. Capture privacy setting is tested against available capture paths and results accurately documented. No universal invisibility claims.
10. Secrets cannot be read from bundled assets, logs or renderer devtools; history deletion works.
11. Windows installer actually installs/launches on a clean profile with documented prerequisites.
12. Document test evidence, command output, and which parts were not runnable in the current environment. No claims of verification for missing physical Windows, API key or conferencing test.

## Deliverable report to user (only after building)
- What is truly implemented and which parts are experimental.
- Current application architecture + file tree.
- Exact commands for development, testing and building the Windows installer.
- How to add Gemini/xAI/DeepSeek keys and start an authorised live session.
- Known limitations, security/capture compatibility and measured actual latency.
- Installer path and screenshots/test artifacts if produced in the environment.
- Remaining manual Windows/API-specific tests required; any unfinished critical features should be clearly flagged.

**Start now:** inspect the working directory and environment, create the roadmap and `CLAUDE.md`, then implement Phase 0 and continue autonomously phase by phase. Make decisions as an experienced engineer rather than repeatedly asking me what to do. Do not finish with a plan alone.
