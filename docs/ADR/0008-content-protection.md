# ADR 0008 — Screen-capture exclusion is a measured, best-effort privacy setting

**Status:** accepted · 2026-11-19 · amended 2026-11-21 (on by default)

**Decision.** Only Electron's documented `win.setContentProtection(enabled)` (→ `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`) is used. The in-app Capture Compatibility Check paints a probe colour in the overlay and samples it through (1) Chromium desktopCapturer and (2) GDI `BitBlt(SRCCOPY | CAPTUREBLT)` in the native helper, first with protection off (the baseline must see the probe, otherwise the result is "not verified") and then on. Users can record manual results for other tools.

**Amendment (0.2.1).** The owner wants the overlay visible to the user but left out of what a meeting shares, so the setting is now **on by default** for new profiles (existing profiles keep their stored value; the toggle stays in Settings → Overlay & capture). Nothing else changed: same documented API, no claims of invisibility.

The UI never says "invisible" or "undetectable", and Hirora contains no logic to detect, disable or evade proctoring, monitoring or recording software.

**Measured.**
- 2026-11-19, Windows 11 build 26300 + Electron 45.4.1: both in-app paths excluded the overlay with protection on.
- 2026-11-21, same machine: a real browser screen share (`getDisplayMedia`, "Entire screen") in Edge 158 and Chrome 157 showed the probe with protection off and only the content behind the overlay with it on, by default, after toggling, and after hiding and showing the overlay (`tests/e2e/capture.e2e.ts`). The person's own Meet test before this change showed the overlay because the setting was off.
