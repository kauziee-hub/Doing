# Release checklist

1. `pnpm lint && pnpm typecheck && pnpm test` — all green (add `%USERPROFILE%\.cargo\bin` to PATH).
2. `pnpm build && npx playwright test -c tests/e2e/playwright.config.ts` — app, capture and hardware suites on a Windows machine with audio devices. They run with an empty engine folder, like a new user.
3. On AC power: `node tools/interview-check.mjs --system keep` (GPU tier, a copy of your profile) and, with a CPU engine installed by step 4, the same with `--tier cpu` and `DOING_ENGINE_FORCE_CPU=1`. Update `docs/PERF_RESULTS.md` and the website numbers with what was measured.
4. If the engine catalog changed (`apps/desktop/electron/main/engine/catalog.ts`): run `node tools/engine-setup-check.mjs <empty dir> --tier cpu` (and `--tier gpu` on an NVIDIA PC) to download, verify and run every pinned file for real.
5. Bump `apps/desktop/package.json` version, update `CHANGELOG.md`.
6. `pnpm package:win`; run `DOING_E2E_EXE=apps/desktop/release/win-unpacked/Doing.exe` app + capture suites against the packaged app. Don't silent-install over a Hirora that is running.
7. Sign the installer once a certificate is available.
8. Publish the installer as a GitHub release of `kauziee-hub/Doing`: tag `v<version>` on the commit it was built from, the user-facing changelog lines and the SHA-256 in the notes, the `.exe` attached. Never replace a published asset; a new build gets a new version. Without the `gh` CLI, use the REST API with the token from the git credential manager (`printf 'protocol=https
host=github.com

' | git credential fill`), never printed: `POST https://api.github.com/repos/kauziee-hub/Doing/releases`, then `POST https://uploads.github.com/repos/kauziee-hub/Doing/releases/<id>/assets?name=<exe name>` with `Content-Type: application/octet-stream`. Check the asset's `digest` is the local SHA-256. (0.3.5 and older were on Vercel Blob, store `hirora-releases`, which was suspended on 2026-11-26 and serves 403s.)
9. `DOING_DOWNLOAD_URL=https://github.com/kauziee-hub/Doing/releases/download/v<version>/<exe name> DOING_SITE_URL=https://doing-pc.vercel.app pnpm --filter @doing/website build`. It writes the SHA-256 from the local file and links the buttons to the hosted file.
10. Replace `apps/hosting/public` with `apps/website/dist`, then from `apps/hosting` run `vercel deploy --prod --yes --scope omniwebora`. The project serves only static files.
11. Download the installer from the live site and check `Get-FileHash` matches the SHA-256 shown on the page.
