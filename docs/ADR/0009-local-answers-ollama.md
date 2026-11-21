# ADR 0009 — Local answers through Ollama, and the rename to Hirora

**Status:** accepted · 2026-11-19

**Context.** Measured Gemini 3.5 Flash-Lite time-to-first-token was 3–22 s during busy periods (see `docs/PERF_RESULTS.md`), far from the 1.5 s target, and the delay was the provider's, not the pipeline's. The product was also renamed from VeyraCue to Hirora to read as an interview copilot.

**Decision (local answers).** Add `ollama` as a first-class, keyless answer provider that talks to Ollama's OpenAI-compatible API on the loopback interface (`http://127.0.0.1:11434/v1` by default; non-loopback hosts and embedded credentials are rejected in main). Fast cues send `reasoning_effort: "none"` (retried without it if a model rejects the field). When listening starts, the app calls Ollama's native `/api/generate` with an empty prompt and `keep_alive: 30m` so the first question doesn't pay the model-load cost. Transcription stays on Gemini/xAI: no local streaming STT was added.

We did not train or fine-tune "our own LLM". A small instruct model served locally gives the latency win; training a model would add cost and risk without addressing latency.

**Decision (rename).** Everything user-visible, the app id, executable, helper binary, env vars and package scope moved to Hirora. On first launch the main process copies `%APPDATA%\VeyraCue` to `%APPDATA%\Hirora` **before** Chromium reads `Local State`. That file holds the DPAPI-wrapped key `safeStorage` uses, so saved API keys stay decryptable. `veyracue.db` is renamed to `hirora.db`, and the legacy folder is never modified.

**Consequences.** On a PC with a GPU, answers no longer depend on a cloud provider's queue, and nothing in the question leaves the machine. Answer quality is that of a small local model, so users can still pick a cloud model (or keep one as fallback). Users without a capable GPU should keep a cloud provider. The legacy profile stays on disk until the user deletes it.
