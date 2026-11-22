# Release checklist

1. `pnpm lint && pnpm typecheck && pnpm test` — all green (add `%USERPROFILE%\.cargo\bin` to PATH).
2. `pnpm build && npx playwright test -c tests/e2e/playwright.config.ts` — app, capture and hardware suites on a Windows machine with audio devices. They run with an empty engine folder, like a new user.
3. On AC power: `node tools/interview-check.mjs --system keep` (GPU tier, a copy of your profile) and, with a CPU engine installed by step 4, the same with `--tier cpu` and `HIRORA_ENGINE_FORCE_CPU=1`. Update `docs/PERF_RESULTS.md` and the website numbers with what was measured.
4. If the engine catalog changed (`apps/desktop/electron/main/engine/catalog.ts`): run `node tools/engine-setup-check.mjs <empty dir> --tier cpu` (and `--tier gpu` on an NVIDIA PC) to download, verify and run every pinned file for real.
5. Bump `apps/desktop/package.json` version, update `CHANGELOG.md`.
6. `pnpm package:win`; run `HIRORA_E2E_EXE=apps/desktop/release/win-unpacked/Hirora.exe` app + capture suites against the packaged app. Don't silent-install over a Hirora that is running.
7. Sign the installer once a certificate is available.
8. Upload the installer to Vercel Blob (store `hirora-releases`) under a **new versioned path**, never overwriting a published file: from `apps/hosting`, `vercel blob put <exe> --pathname releases/<version>/<exe name> --access public --rw-token <BLOB_READ_WRITE_TOKEN from apps/hosting/.env.local>`. Don't print the token.
9. `HIRORA_DOWNLOAD_URL=<blob URL> HIRORA_SITE_URL=https://hirora-one.vercel.app pnpm --filter @hirora/website build`. It writes the SHA-256 from the local file and links the buttons to the hosted file.
10. Replace `apps/hosting/public` with `apps/website/dist`, then from `apps/hosting` run `vercel deploy --prod --yes --scope omniwebora`. The project serves only static files.
11. Download the installer from the live site and check `Get-FileHash` matches the SHA-256 shown on the page.
