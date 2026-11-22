# ADR 0007 — Gemini answers via `streamGenerateContent` (SSE), not the Interactions API

**Status:** superseded by ADR 0012 (0.3.0: one local engine, no cloud, no keys) · originally accepted 2026-11-19

**Context.** Since June 2026 Google recommends the Interactions API for new agentic work; `generateContent` remains fully supported. We need simple low-latency token streaming with system instructions and inline images.

**Decision.** `POST /v1beta/models/{model}:streamGenerateContent?alt=sse` with `x-goog-api-key`. Fast answers request `thinkingConfig.thinkingLevel = minimal`, falling back to `low` and then the provider default when a model rejects a level (remembered per model; triggered by an HTTP 400 that mentions thinking). Models are listed live (`GET /v1beta/models`); image/music/robotics/agent/live/transcribe models are filtered out; suggested defaults are pre-selected only if the key's list contains them.

**Consequences.** Verified live with an `AQ.`-format key. Revisit if a needed capability becomes Interactions-only.
