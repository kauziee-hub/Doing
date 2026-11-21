# Troubleshooting

**"Windows protected your PC" when installing.** The installer is not code-signed yet. Compare the SHA-256 shown on the download page with `Get-FileHash .\Hirora-Setup-*.exe`, then choose More info → Run anyway.

**"Wrong or missing Hirora Cloud access code".** Ask whoever shared Hirora for the current code and paste it again in Settings → Providers → Hirora Cloud → Save code. The owner can rotate codes (`HIRORA_ACCESS_CODE` in the Vercel project), after which old codes stop working.

**Hirora Cloud says "rate limit" or answers slow down.** Everyone with the code shares Groq's free tier (about 30 answers/min and 1,000/day; about 20 transcriptions/min). Wait a minute, or add your own Gemini/xAI key (or Ollama) as a fallback so answers keep flowing.

**Hirora Cloud transcript appears only after the speaker stops.** That's expected: Whisper transcribes whole sentences after a short pause (about 1.5–2 s after the sentence ends). For word-by-word text, use Gemini Live or xAI STT with your own key.

**"This Hirora Cloud server is not connected / has no access code configured".** The owner's relay is missing `GROQ_API_KEY` or `HIRORA_ACCESS_CODE`; check `https://hirora-one.vercel.app/health`.

**Answers say "No response within … ms".** The provider didn't send its first token in time. Gemini Flash-Lite was measured at 8–9 s to first byte during busy periods (and returns HTTP 503 "high demand" at times). Raise *Settings → Answers → First-token timeout*, pick another model, or add a fallback provider.

**"No API key saved for the selected transcription provider".** Hirora Cloud Whisper uses the access code; Gemini Live uses your Gemini key; xAI STT uses your xAI key. DeepSeek and Ollama cannot transcribe audio.

**System audio shows "streaming" but no transcript.** Check that audio is actually playing through the selected output device (Settings → Audio → Test system audio). Bluetooth headsets in "hands-free" mode switch to a different output endpoint — select it or leave "Windows default".

**Microphone is silent.** Windows Settings → Privacy & security → Microphone → allow desktop apps. Then Settings → Audio → Test microphone.

**Echo / both sources transcribe the same words.** Use headphones; with laptop speakers the mic hears the other side too.

**Hotkey does nothing.** Another app owns that shortcut. Change it in Settings → Hotkeys (failures are listed in the log).

**Overlay is hard to read over a bright app.** Settings → Overlay & capture: raise Opacity or turn off "Translucent glass".

**"Native audio helper not found" (development).** Run `pnpm native:build` (needs Rust; `rustup` with the GNU or MSVC toolchain).

**`pnpm package:win` fails with an NSIS `!include: could not open file`.** Keep `virtual-store-dir-max-length=40` in `.npmrc` and run `pnpm install --force`. If Electron then fails to launch, re-run `node node_modules/electron/install.js` inside `apps/desktop`.

**Where are the logs?** `%APPDATA%\Hirora\logs\hirora.log` (no transcripts, answers or keys).
