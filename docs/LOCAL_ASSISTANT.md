# Local Assistant

Assistant is the default Doing page. Questions and drafting work without folder access. For file tasks, select **Allow a folder** in the native picker, then give an ordinary instruction. Access lasts for this app session; Change folder or Revoke clears the conversation and Undo records. New chat clears the conversation without revoking the current folder.

The local model chooses one validated action at a time: answer, list, read, write, create a directory, move a file or folder or finish. Observations confirm each change before the next step. No model-generated JavaScript, shell commands or executables run. File contents are untrusted reference data, never new instructions.

Paths are relative to the selected folder. Absolute paths, traversal, Windows alternate streams, reserved names, `.git`/`.env` paths and symbolic links/junctions are refused. Existing shared hard-linked files cannot be overwritten. Moves do not overwrite destinations. Reads support common text/code, Markdown, JSON and CSV files below 60 KB. Existing files must be observed before a write; observations exceeding the local model context are rejected instead of silently truncated. Use small files or focused tasks. PDFs and Word documents belong in Library for meeting questions.

Undo reverses the last file change, keeping up to 30 changes in memory. It refuses to overwrite a file edited outside Doing after its own write. Undo is lost after restart, folder change or revocation; completed file changes remain on disk. Stop aborts the model and prevents late model results from taking another action; an already dispatched filesystem operation may finish.

Tasks stop after 30 steps or ten minutes. The small local model can misunderstand a request; review important changes. Browser tasks and meeting transcripts have their own pages and permission scopes.

Verification: `pnpm test:ts` covers scope restrictions, link/traversal rejection, Stop, file creation, moves and Undo with external edits. `node tools/browser-typing-check.mjs --exe <Doing.exe> --full` also uses the packaged app and real local model to create a plan, preserve and edit an existing note, Undo it and revoke access in a temporary folder. Only the native picker result is supplied by the test; model calls and disk operations are real.

0.5.0 adds whole-folder moves and renames with Undo. Nested files are preserved. A folder cannot be moved into itself, over an existing destination, outside the allowed folder or from the permission root.

0.5.1 adds deletion through Windows Recycle Bin. The host verifies that the source path is absent before reporting success. Similar names require explicit confirmation, and the selected folder itself cannot be deleted. Restore recycled items using Windows Recycle Bin; in-app Undo remains for edits, moves and created folders. Completion text comes from the operations actually performed, not a model's unverified claim.

## PC actions (0.5.2)

The Assistant also works outside the allowed folder through a fixed set of PC actions. The local model picks one; fixed host code carries it out with validated arguments and the reply is built from what actually happened (`electron/main/local/pc.ts`). Model text never becomes a command: arguments reach PowerShell only as JSON in an environment variable.

| Ask | What happens |
| --- | --- |
| "Where is my resume?", "find report.pdf" | Windows Search (about a second), then the Desktop, Documents, Downloads, Pictures, Music, Videos and OneDrive folders if it finds nothing. App data and developer folders (`node_modules`, `.git`, `venv`…) are left out. Up to 20 results. Plain find requests search without asking the model first. |
| "Open it", "show it in the folder" | Only paths found in this chat (or inside the allowed folder). Programs, scripts, installers and shortcuts are shown in File Explorer, never run. |
| "Open Spotify" | An installed app from the Start menu (`Get-StartApps`), launched through `shell:AppsFolder`. Several matches: it asks which. Shells and admin tools (PowerShell, Command Prompt, Terminal, Registry Editor, Task Scheduler, Control Panel, security tools…) are refused. |
| "Play Shape of You on Spotify" | Opens Spotify's search for the song (the web player's search if Spotify isn't installed). Starting a specific track needs Spotify's online API, so you press play. |
| "Next song", "pause", "mute" | Media keys. |
| "Volume 30", "brightness 60", "dark mode on" | Set and read back (Core Audio, WMI, the Personalize registry values plus a theme broadcast). Brightness works on built-in laptop screens only. |
| "Turn on Bluetooth / Wi-Fi", notifications, display… | Opens that Settings page; you change it there. |
| "WhatsApp +91 98765 43210: running late" | Opens WhatsApp Desktop with the message drafted to that number. **Doing never sends it: you press Enter.** Without a number it asks for one (WhatsApp doesn't let other apps find contacts by name). |

Not available, by design: sending messages, email or payments; installing or uninstalling; running commands; changing security, password, account or protection settings. Local doesn't mean risk-free: the model can misread a request, and text in files or web pages can try to steer it, so actions are limited to this list and anything that reaches another person stays a draft.

Verification: `pnpm test:ts` (`local/pc.test.ts`: argument safety, app matching, programs never run, made-up paths refused, drafts only, repeated actions stopped). `node tools/pc-actions-check.mjs` runs plain requests through the real local model on a fresh profile and restores dark mode, volume and brightness afterwards. Measured 2026-11-27 (RTX 4060 laptop): find, find-and-show, open Calculator, Bluetooth and Wi-Fi pages, Spotify search, volume, brightness, dark mode on/off and the refusals (PowerShell, installing VLC, deleting C:\Windows) all behaved as above, 0.0–7.2 s each.
