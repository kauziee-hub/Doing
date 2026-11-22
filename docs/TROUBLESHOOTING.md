# Troubleshooting

**"Windows protected your PC" when installing.** The installer is not code-signed yet. Compare the SHA-256 shown on the download page with `Get-FileHash .\Hirora-Setup-*.exe`, then choose More info → Run anyway.

**Setup stops with "failed its checksum".** The download was corrupted or replaced in transit; the bad file was deleted. Press *Resume setup*. If it keeps failing, a proxy or antivirus may be altering downloads.

**Setup stops part-way (network drop, PC asleep, Cancel).** Press *Resume setup*: finished parts are kept and the interrupted download continues where it stopped.

**"Not enough free disk space".** Setup needs about 1.6× the download size free on the drive holding `%LOCALAPPDATA%` while it unpacks, then less.

**Answers or transcripts are slow.** Plug the laptop in: on battery the GPU throttles hard (a model load took 177 s on battery once). Press Start a few seconds before the call so the model is loaded. On PCs without an NVIDIA GPU (6 GB or more) Hirora uses smaller models on the processor and is slower; Settings → Engine shows which one you have.

**"Speech recognition did not start" / "The answer engine did not start".** Settings → Engine → the status shows what is missing; *Resume setup* reinstalls it. An old NVIDIA driver can stop the CUDA build: update the driver, or choose *Processor only* in Settings → Engine.

**I already use Ollama.** Hirora reuses its program and model folder, and runs its own server on port 11435 so your Ollama on 11434 is untouched. When Hirora starts listening it asks your Ollama to unload Hirora's model if it holds it, so both don't fill the GPU.

**System audio shows "streaming" but no transcript.** Check that audio is actually playing through the selected output device (Settings → Audio → Test system audio). Bluetooth headsets in "hands-free" mode switch to a different output endpoint — select it or leave "Windows default".

**Microphone is silent.** Windows Settings → Privacy & security → Microphone → allow desktop apps. Then Settings → Audio → Test microphone.

**Echo / both sources transcribe the same words.** Use headphones; with laptop speakers the mic hears the other side too.

**Hotkey does nothing.** Another app owns that shortcut. Change it in Settings → Hotkeys (failures are listed in the log).

**Overlay is hard to read over a bright app.** Settings → Overlay & capture: raise Opacity or turn off "Translucent glass".

**"Native audio helper not found" (development).** Run `pnpm native:build` (needs Rust; `rustup` with the GNU or MSVC toolchain).

**`pnpm package:win` fails with an NSIS `!include: could not open file`.** Keep `virtual-store-dir-max-length=40` in `.npmrc` and run `pnpm install --force`. If Electron then fails to launch, re-run `node node_modules/electron/install.js` inside `apps/desktop`.

**Where are the logs?** `%APPDATA%\Hirora\logs\hirora.log` (no transcripts or answers). The answer engine's own log is `%LOCALAPPDATA%\Hirora\ollama\server.log`.
