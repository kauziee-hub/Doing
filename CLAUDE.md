# Hirora — project conventions & status

Windows 11 x64, local-first interview copilot (formerly **VeyraCue**, renamed in 0.2.0). Original specs (kept verbatim, still say VeyraCue): `docs/CLAUDE_CODE_MASTER_PROMPT.md`, `docs/VEYRACUE_IMPLEMENTATION_PLAN.md`. The repo folder is still `VEYRACUE`.

## Layout
- `apps/desktop` — Electron 45 (main/preload in `electron/`, React renderer in `src/`), electron-vite 6, electron-builder 26 (`electron-builder.yml`, appId `app.hirora.desktop`).
- `apps/cloud` — **Hirora Cloud**: Vercel project `hirora` (team `omniwebora`), live at https://hirora-one.vercel.app. `lib/relay.mjs` is an OpenAI-compatible relay to Groq (`openai/gpt-oss-20b`/`-120b`, Whisper) behind a shared access code; `api/` holds thin Function entry points; `public/` is a copy of `apps/website/dist` (gitignored). The installer is on Vercel Blob (store `hirora-releases`). ADR 0010.
- `apps/website` — static install site (Vite). `scripts/prepare-release.mjs` copies the installer + real screenshots and writes `src/release.json` (SHA-256). `HIRORA_DOWNLOAD_URL` links downloads to a release host; `HIRORA_SITE_URL` makes OG/canonical URLs absolute. Hero photo was generated with Higgsfield (`public/img/hero-person*.webp`); social card from `tools/make-og.py`.
- `native/windows-audio` — Rust WASAPI helper (`hirora-audio.exe`): mic + loopback + per-process loopback, 16 kHz mono PCM16 20 ms frames, framed stdout protocol (`src/protocol.rs`, mirrored by `electron/main/audioHelper.ts`), JSON-line stdin commands.
- `packages/contracts` (Zod schemas, IPC allowlist, secret detector; `KEYLESS_PROVIDERS`) · `providers` (**Hirora Cloud** `cloud` + `cloud-whisper` (default), Gemini/xAI/DeepSeek/**Ollama**/custom text, Gemini 3.5 Transcribe Live + xAI STT, embeddings) · `knowledge` · `orchestration` · `settings` · `ui`.
- `electron/main/migrate.ts` — copies `%APPDATA%\VeyraCue` → `%APPDATA%\Hirora` before Chromium reads `Local State` (keeps DPAPI keys decryptable); retries every launch until a marker `.migrated-from-veyracue` is written; never overwrites a Hirora profile that has its own keys (ADR 0009).
- `tests/e2e` (Playwright-for-Electron: `app.e2e.ts`, `hardware.e2e.ts`, opt-in `live.e2e.ts`; `HIRORA_E2E_EXE=<installed exe>` targets an installed build), `tests/fixtures`.

## Commands
`pnpm dev` · `pnpm lint` · `pnpm typecheck` · `pnpm test` (Vitest + cargo) · `pnpm test:e2e` · `pnpm build` · `pnpm package:win` → `apps/desktop/release/Hirora-Setup-<v>-x64-unsigned.exe` · `pnpm perf:live` (real provider bench; `HIRORA_BENCH_OLLAMA_MODEL`, `HIRORA_BENCH_PROVIDERS`, `HIRORA_BENCH_SKIP_STT`) · `node tools/audio-smoke.mjs` · `node tools/check-migration.mjs <exe>` (migration check on a copied profile) · `pnpm --filter @hirora/website build` · `cloud.e2e.ts` (needs `HIRORA_CLOUD_CODE`) · deploy: copy website `dist` → `apps/cloud/public`, then `vercel deploy --prod --yes --scope omniwebora` from `apps/cloud` (full steps in `docs/RELEASE_CHECKLIST.md`).
Rust toolchain: stable **x86_64-pc-windows-gnu** (no MSVC build tools on this machine); add `%USERPROFILE%\.cargo\bin` to PATH.
Website preview: launch config `website-4318` (port 4317 may be held by another session's preview).

## Rules
- Never fake provider output, latency, audio or capture results. Fixture servers live only in tests and are labelled FIXTURE. Website numbers must be measured ones.
- Keys only via the app's Settings (Electron safeStorage/DPAPI vault in main). Never in repo, logs, settings or renderer. Don't echo keys.
- Renderer: sandbox + contextIsolation, allowlisted IPC validated with Zod in main, CSP, no remote content.
- No audio capture before explicit consent; raw audio never persisted; history opt-in.
- Content protection is best-effort; never claim undetectability or add evasion. Website/FAQ keep the "check the interview's rules" guidance.
- Ollama endpoint is loopback-only (`validateLocalBaseUrl`).
- Hirora Cloud secrets live only in the Vercel project's encrypted env: `GROQ_API_KEY` (Production + Preview, sensitive) and `HIRORA_ACCESS_CODE` (comma-separated codes). `apps/cloud/.env.local` holds CLI tokens (OIDC, Blob read-write): never commit or print it. The relay never logs request/response content.
- Never overwrite a published Blob installer; upload each build to a new versioned path so cached copies match the page's SHA-256.
- `.npmrc` `virtual-store-dir-max-length=40` is required (NSIS fails on long pnpm paths).

## Status (2026-11-21)
See `docs/PERF_RESULTS.md` (measured numbers), `docs/ACCEPTANCE.md`, `CHANGELOG.md` 0.2.0.
Deployed: site + relay at https://hirora-one.vercel.app; installer 0.2.0 (sha256 `139af23d…0c798`) on Blob. The user's own profile is set to Hirora Cloud (gpt-oss-20b, Whisper), with Ollama as fallback and Gemini disabled (its key is still in the vault). `CHANGELOG.md` Unreleased has a fix that isn't in the hosted installer yet.

The user's Gemini key is in the legacy DPAPI vault `%APPDATA%\VeyraCue` (and, once migrated, `%APPDATA%\Hirora`). Live tests copy the profile to a temp folder (`HIRORA_LIVE_PROFILE`, migrated via `HIRORA_MIGRATE_FROM`), never modify it, and never print the key. Ollama 0.40 is installed per-user on this machine with `qwen3.5:4b` (RTX 4060 Laptop, 8 GB).

## Design system
Light: warm canvas `#f3f2ef`, white cards (radius 22–28), ink `#1d1c35` rail and pill buttons, pastel tiles (peach/blush/lilac/mint/sky), Outfit Variable (bundled via @fontsource). Dark theme via `appearance.theme`. Overlay is always dark translucent ink glass (ADR 0006). Logo: ink squircle, white lowercase "h" whose shoulder is an arch, blush dot. Geometry lives in `src/shared/Logo.tsx`, `tools/make-icons.mjs`, the website's inline SVGs and `tools/make-og.py` (keep them in sync). Website: white page, ink pill buttons, download card modelled on the brief's search card.

## Next
- Manual tests in `docs/ACCEPTANCE.md` (human mic speech, device switch, sleep/resume, second monitor, Meet/Teams share, 30-min soak).
- Code signing needs a certificate. xAI/DeepSeek live verification needs keys. Hirora Cloud under concurrent use / near Groq's free limits isn't measured; heavy use needs a paid Groq plan or users' own keys.
