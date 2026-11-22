# Hirora — project conventions & status

Windows 11 x64 interview copilot that runs **entirely on the PC** since 0.3.0 (formerly **VeyraCue**, renamed in 0.2.0). Original specs (kept verbatim, still say VeyraCue): `docs/CLAUDE_CODE_MASTER_PROMPT.md`, `docs/VEYRACUE_IMPLEMENTATION_PLAN.md`. The repo folder is still `VEYRACUE`.

## Layout
- `apps/desktop` — Electron 45 (main/preload in `electron/`, React renderer in `src/`), electron-vite 6, electron-builder 26 (`electron-builder.yml`, appId `app.hirora.desktop`).
- `apps/hosting` — Vercel project `hirora` (team `omniwebora`), live at https://hirora-one.vercel.app: serves only the built website (`public/` = copy of `apps/website/dist`, gitignored). No server code since 0.3.0 (the Hirora Cloud relay was deleted). The installer is on Vercel Blob (store `hirora-releases`).
- `apps/website` — multi-page static site (Vite MPA): `index`, `features`, `download`, `guide`, `privacy`, `faq`, `changelog` (.html), shared `partials/header.html` + `footer.html` injected by the `hirora-partials` plugin in `vite.config.ts`. Positioned as a **free local meeting assistant**; interview practice is one use case lower on Home with the responsible-use note. `scripts/prepare-release.mjs` copies the installer info + screenshots (`tools/site-shots.mjs`) and writes `src/release.json` (SHA-256). Hero: the Higgsfield portrait on concentric rings + soft glow (no floating chips — the owner disliked them). `tools/make-og.py` makes the social card.
- `native/windows-audio` — Rust WASAPI helper (`hirora-audio.exe`): mic + loopback + per-process loopback, 16 kHz mono PCM16 20 ms frames, framed stdout protocol (`src/protocol.rs`, mirrored by `electron/main/audioHelper.ts`), JSON-line stdin commands.
- `apps/desktop/electron/main/engine/` — **the only engine** (ADR 0012): `catalog.ts` (pinned URLs/sizes/SHA-256 per tier), `download.ts` (resumable verified downloads, `tar.exe` unzip), `servers.ts` (whisper-server on 127.0.0.1:8178, `ollama serve` on 127.0.0.1:11435 with 2 parallel slots), `index.ts` (`EngineManager`: nvidia-smi tier, setup, start/stop, reuse of a user-installed Ollama and its models).
- `packages/contracts` (Zod schemas, IPC allowlist incl. `engine:*`, settings schema 2, secret detector) · `providers` (Ollama answer client + whisper.cpp transcriber only) · `knowledge` · `orchestration` · `settings` · `ui`.
- `electron/main/migrate.ts` — copies `%APPDATA%\VeyraCue` → `%APPDATA%\Hirora` before Chromium reads `Local State` (keeps DPAPI keys decryptable); retries every launch until a marker `.migrated-from-veyracue` is written; never overwrites a Hirora profile that has its own keys (ADR 0009).
- `tests/e2e` (Playwright-for-Electron: `app.e2e.ts`, `capture.e2e.ts`, `hardware.e2e.ts`; all run with an empty engine folder; `HIRORA_E2E_EXE=<exe>` targets a packaged build), `tests/fixtures`.

## Commands
`pnpm dev` · `pnpm lint` · `pnpm typecheck` · `pnpm test` (Vitest + cargo) · `pnpm test:e2e` · `pnpm build` · `pnpm package:win` → `apps/desktop/release/Hirora-Setup-<v>-x64-unsigned.exe` · `node tools/interview-check.mjs --system keep [--tier cpu]` (speaks questions into a profile copy; measure on AC power) · `node tools/engine-setup-check.mjs <emptyDir> --tier cpu|gpu [--keep]` (fresh-PC setup with real downloads) · `node tools/site-shots.mjs` (website screenshots, fresh profile) · `node tools/audio-smoke.mjs` · `node tools/check-migration.mjs <exe>` · `pnpm --filter @hirora/website build` · deploy: copy website `dist` → `apps/hosting/public`, then `vercel deploy --prod --yes --scope omniwebora` from `apps/hosting` (full steps in `docs/RELEASE_CHECKLIST.md`).
Engine env overrides (tests): `HIRORA_ENGINE_DIR`, `HIRORA_ENGINE_MODELS`, `HIRORA_ENGINE_NO_SYSTEM_OLLAMA=1`, `HIRORA_ENGINE_FORCE_CPU=1`, `HIRORA_ENGINE_WHISPER_PORT`, `HIRORA_ENGINE_OLLAMA_PORT`, `HIRORA_ENGINE_PARALLEL`.
Rust toolchain: stable **x86_64-pc-windows-gnu** (no MSVC build tools on this machine); add `%USERPROFILE%\.cargo\bin` to PATH.
Website preview: launch config `website-4318` (port 4317 may be held by another session's preview).

## Rules
- Public repo: https://github.com/kauziee-hub/hirora (`origin`, branch `main` = local `hirora-0.3.0`). Commits use the GitHub no-reply email (set in this repo's git config). Never commit personal data (real names, résumé details) — tests use fictional ones.
- Never fake provider output, latency, audio or capture results. Fixture servers live only in tests and are labelled FIXTURE. Website numbers must be measured ones.
- **One local engine only** (owner's decision, 2026-11-22): no cloud providers, API keys, access codes, provider pickers or budgets. Don't reintroduce them. Engine downloads must stay pinned (URL + size + SHA-256) and verified.
- Renderer: sandbox + contextIsolation, allowlisted IPC validated with Zod in main, CSP, no remote content.
- No audio capture before explicit consent; raw audio never persisted; history opt-in.
- Content protection (overlay left out of screen shares) is on by default since 0.2.1 at the owner's request (ADR 0008); it stays best-effort: never claim undetectability or add evasion. Website/FAQ keep the "check the interview's rules" guidance. `capture.e2e.ts` checks it against a real Edge/Chrome screen share (`HIRORA_SHARE_CHANNEL=chrome`).
- Engine servers are loopback-only (`validateLocalBaseUrl`); Hirora's Ollama uses port 11435 and never touches the user's 11434 except to unload Hirora's model from it.
- `apps/hosting/.env.local` holds Vercel CLI tokens (OIDC, Blob read-write): never commit or print it. The Vercel project still has the old `GROQ_API_KEY`/`HIRORA_ACCESS_CODE` env vars unless the owner removed them; nothing uses them.
- Never overwrite a published Blob installer; upload each build to a new versioned path so cached copies match the page's SHA-256.
- `.npmrc` `virtual-store-dir-max-length=40` is required (NSIS fails on long pnpm paths).

## Status (2026-11-22, 0.3.1)
See `docs/PERF_RESULTS.md` (0.3.1 and 0.3.0 sections), `docs/ACCEPTANCE.md`, `CHANGELOG.md` 0.3.1, ADR 0012 and 0013.
**One assistant, no modes** (owner's decision, 0.3.1, ADR 0013): don't reintroduce mode pickers. `prompt.ts` `requestRules` covers every request type; `isAskedOfTheUser` / `isCodeTask` add first-person and code-layout lines because the 4B model slipped without them. **Screen reading**: `refersToScreen` (`packages/orchestration/src/screen.ts`) + `electron/main/screenCapture.ts` (display under the cursor, 1280 px JPEG, in memory only); setting `answer.screen` auto/always/off, GPU tier only. Check with `node tools/screen-check.mjs [--exe …]`: it pins a code page full-screen and topmost in Edge for about a minute, so run it when the owner isn't using the PC. Without the pin, the window active when the check started stayed in front and was captured instead.
Deployed: static site at https://hirora-one.vercel.app (no API: `/v1/*` and `/health` return 404 since 0.3.0); installer 0.3.1 (sha256 `68100de5…f7ea40`, `releases/0.3.1/`) on Blob; older versions keep their own paths. 0.3.1 is installed on this PC in `Desktop\Hirora` (an NSIS install with no uninstall registry entry; update with `Hirora-Setup-<v>.exe /S /D=%USERPROFILE%\Desktop\Hirora` after closing the app). Settings backups: `settings.json.before-0.3.0`, `settings.json.before-0.3.1`.
This PC's engine (GPU tier): whisper.cpp b5454 CUDA in `%LOCALAPPDATA%\Hirora\whisper\bin\Release` + `models\ggml-large-v3-turbo-q5_0.bin`; answers through the user's own Ollama 0.40.16 binary (`%LOCALAPPDATA%\Programs\Ollama`) run by Hirora on 127.0.0.1:11435 with `qwen3.5:4b` from `%USERPROFILE%\.ollama\models`. The user's Ollama tray app still runs on 11434. Measure on AC power: on battery the GPU throttles hard.
Tiers: GPU (NVIDIA ≥ 5.8 GB) = large-v3-turbo + `qwen3.5:4b` + early answers; CPU = Whisper small + `qwen3:1.7b` (not the hybrid `qwen3.5:2b`: no prompt-cache reuse on llama.cpp), no early answers, lean prompts, no screenshots or screen reading.
Measure with `node tools/quiet-check.mjs --exe <Hirora.exe>` (silent; a run that spoke questions aloud at night was interrupted by the owner, so prefer this one) or `node tools/interview-check.mjs --system keep` (speaks questions through the speakers).
The Vercel project still has the unused `GROQ_API_KEY` / `HIRORA_ACCESS_CODE` env vars unless the owner removed them.

## Design system
Light: warm canvas `#f3f2ef`, white cards (radius 22–28), ink `#1d1c35` rail and pill buttons, pastel tiles (peach/blush/lilac/mint/sky), Outfit Variable (bundled via @fontsource). Dark theme via `appearance.theme`. Overlay is always dark translucent ink glass (ADR 0006). Logo: ink squircle, white lowercase "h" whose shoulder is an arch, blush dot. Geometry lives in `src/shared/Logo.tsx`, `tools/make-icons.mjs`, the website's inline SVGs and `tools/make-og.py` (keep them in sync). Website: white page, ink pill buttons, download card modelled on the brief's search card.

## Next
- Manual tests in `docs/ACCEPTANCE.md` (human mic speech, device switch, sleep/resume, second monitor, Meet/Teams share, 30-min soak).
- Code signing needs a certificate. xAI/DeepSeek live verification needs keys. Hirora Cloud under concurrent use / near Groq's free limits isn't measured; heavy use needs a paid Groq plan or users' own keys.
