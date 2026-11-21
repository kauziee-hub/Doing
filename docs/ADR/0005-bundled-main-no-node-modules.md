# ADR 0005 — Fully bundled main/preload, sandboxed renderer, no remote content

**Status:** accepted · 2026-11-19

**Decision.** electron-vite bundles main (CJS) and preload (`.cjs`, required by the sandbox) including all JS dependencies; only `electron` and Node built-ins stay external. UI windows use a separate session partition that denies every permission and cancels all http(s)/ws requests except the dev server; a strict CSP is injected into production HTML. Provider calls use `net.fetch` in main (system-proxy aware). The preload exposes exactly four functions; every channel is allowlisted and Zod-validated in main, and senders must be the app's own pages.

**Consequences.** The packaged `app.asar` holds 19 files and no `node_modules`. pnpm needs `virtual-store-dir-max-length=40` because NSIS cannot open includes from very long paths.
