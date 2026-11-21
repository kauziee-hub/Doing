# ADR 0008 — Screen-capture exclusion is a measured, best-effort privacy setting

**Status:** accepted · 2026-11-19

**Decision.** Only Electron's documented `win.setContentProtection(enabled)` (→ `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`) is used, off by default. The in-app Capture Compatibility Check paints a probe colour in the overlay and samples it through (1) Chromium desktopCapturer and (2) GDI `BitBlt(SRCCOPY | CAPTUREBLT)` in the native helper, first with protection off (the baseline must see the probe, otherwise the result is "not verified") and then on. Users can record manual results for other tools.

The UI never says "invisible" or "undetectable", and Hirora contains no logic to detect, disable or evade proctoring, monitoring or recording software.

**Measured.** Windows 11 build 26300 + Electron 45.4.1: both paths excluded the overlay with protection on.
