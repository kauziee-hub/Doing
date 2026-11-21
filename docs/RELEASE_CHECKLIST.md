# Release checklist

1. `pnpm lint && pnpm typecheck && pnpm test` — all green.
2. `pnpm build && npx playwright test -c tests/e2e/playwright.config.ts` — app + hardware suites on a Windows machine with audio devices.
3. With keys saved in the app: `HIRORA_LIVE_PROFILE=%APPDATA%\Hirora` live suite (add `HIRORA_LIVE_OLLAMA_MODEL=qwen3.5:4b` when Ollama is installed), then `pnpm perf:live`; update `docs/PERF_RESULTS.md` with the new numbers.
4. Bump `apps/desktop/package.json` version, update `CHANGELOG.md`.
5. `pnpm package:win`; silently install the new exe into a temp folder (`/S /D=<dir>`), run `HIRORA_E2E_EXE=<dir>\Hirora.exe` app suite, uninstall.
6. Sign the installer once a certificate is available.
7. Upload the installer to Vercel Blob (store `hirora-releases`) under a **new versioned path**, never overwriting a published file (CDN caches would then disagree with the checksum): from `apps/cloud`, `vercel blob put <exe> --pathname releases/<version>/<exe name> --access public --rw-token <BLOB_READ_WRITE_TOKEN from apps/cloud/.env.local>`. Don't print the token.
8. `HIRORA_DOWNLOAD_URL=<blob URL> HIRORA_SITE_URL=https://hirora-one.vercel.app pnpm --filter @hirora/website build`. It writes the SHA-256 from the local file and links the buttons to the hosted file, so the ~110 MB exe isn't bundled. Without the variable the exe is copied into `dist/download/`.
9. Replace `apps/cloud/public` with `apps/website/dist`, then from `apps/cloud` run `vercel deploy --prod --yes --scope omniwebora`. That deploys the site and the relay together.
10. Check `https://hirora-one.vercel.app/health` (`upstreamConfigured` and `accessCodeConfigured` should both be true) and run `cloud.e2e.ts` with `HIRORA_CLOUD_CODE` (also against the installed exe via `HIRORA_E2E_EXE`).
11. Download the installer from the live site and check `Get-FileHash` matches the SHA-256 shown on the page.
12. Run the in-app Capture Compatibility Check and record manual results for the conferencing tools you support.
