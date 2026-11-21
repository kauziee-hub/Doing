# ADR 0006 — Overlay translucency without Windows acrylic

**Status:** accepted · 2026-11-19

**Context.** The overlay should read as translucent glass over Meet, Teams or any app, yet never take focus.

**Experiment.** Three frameless windows over a striped background, captured with desktopCapturer (Electron 45.4.1, Windows 11 build 26300): `transparent + backgroundMaterial: 'acrylic'`, `backgroundColor: '#00000000' + acrylic`, and `transparent` only. Both acrylic variants rendered as an opaque grey slab — Windows' fallback for unfocused windows — and our overlay is deliberately unfocused.

**Decision.** Transparent window + tinted ink panel (`rgba(21, 20, 39, 0.95)` by default; "Translucent glass" off → 0.97) plus the window Opacity slider. Text keeps high contrast while the app behind stays faintly visible.

**Consequences.** No blur behind the overlay (CSS `backdrop-filter` cannot sample other windows). Users who want more see-through can lower Opacity in Settings.
