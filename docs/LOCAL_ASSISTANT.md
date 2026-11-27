# Local Assistant

Assistant is the default Doing page. Questions and drafting work without folder access. For file tasks, select **Allow a folder** in the native picker, then give an ordinary instruction. Access lasts for this app session; Change folder or Revoke clears the conversation and Undo records. New chat clears the conversation without revoking the current folder.

The local model chooses one validated action at a time: answer, list, read, write, create a directory, move a file or finish. Observations confirm each change before the next step. No model-generated JavaScript, shell commands or executables run. File contents are untrusted reference data, never new instructions.

Paths are relative to the selected folder. Absolute paths, traversal, Windows alternate streams, reserved names, `.git`/`.env` paths and symbolic links/junctions are refused. Existing shared hard-linked files cannot be overwritten. Moves do not overwrite destinations. Reads support common text/code, Markdown, JSON and CSV files below 60 KB. Existing files must be observed before a write; observations exceeding the local model context are rejected instead of silently truncated. Use small files or focused tasks. PDFs and Word documents belong in Library for meeting questions.

Undo reverses the last file change, keeping up to 30 changes in memory. It refuses to overwrite a file edited outside Doing after its own write. Undo is lost after restart, folder change or revocation; completed file changes remain on disk. Stop aborts the model and prevents late model results from taking another action; an already dispatched filesystem operation may finish.

Tasks stop after 30 steps or ten minutes. This release handles files, not arbitrary Windows application control. The small local model can misunderstand a request; review important changes. Browser tasks and meeting transcripts have their own pages and permission scopes.

Verification: `pnpm test:ts` covers scope restrictions, link/traversal rejection, Stop, file creation, moves and Undo with external edits. `node tools/browser-typing-check.mjs --exe <Doing.exe> --full` also uses the packaged app and real local model to create a plan, preserve and edit an existing note, Undo it and revoke access in a temporary folder. Only the native picker result is supplied by the test; model calls and disk operations are real.
