# ADR 0011 — Instant answers: live local transcription and speculative answers

**Status:** accepted · 2026-11-22

**Context.** The owner wants answers on screen within ~0.5 s of the interviewer finishing. On the free cloud path, cloud Whisper transcribes after each sentence (~0.5–0.8 s), followed by Groq's first token (~0.5–0.9 s), so 2–3 s in total. Groq's free tier (~20 transcriptions/min, ~8K tokens/min) rules out transcribing continuously or starting answers early on the cloud.

**Decision.**
1. **Whisper on this PC** (`local-whisper`). whisper.cpp's CUDA server, managed by the app on 127.0.0.1, re-transcribes the utterance in progress every 350 ms and when the speaker goes quiet. A 4 s question takes ~150 ms on an RTX 4060.
2. **Speculative answers.** As soon as the live text reads as a question, `AnswerEngine.prefetch` starts the answer hidden; the answer on screen is untouched. 300 ms into the speaker's pause, `commit` reveals it with whatever is already generated. The final transcript keeps it (`sameQuestion`) or replaces it. Unfinished fragments are never revealed.
3. **Local answer model with a pre-read prompt.** Ollama keeps the model loaded. The prompt starts with a fixed block (instructions, profile, résumé), which the model reads once (`prime()`), so each answer only processes the new question. Prompts fit Ollama's 4K context.
4. **Question check on the cloud.** Ollama serves one request at a time, so while answers run locally the ANSWER/SKIP check goes to Hirora Cloud.
5. **Missing-fact guard.** Questions that assume things absent from the user's materials (an internship, a thesis…) are flagged in the prompt, because the 4B local model invented them otherwise.

**Consequences.** Usually 0.3–0.4 s from end of speech to first token, with occasional 0.85–2 s cases (mid-sentence pauses, late final words). It needs an NVIDIA GPU on AC power and ~1.2 GB of local Whisper files. Local answers are less capable than gpt-oss-20b. Friends without a GPU stay on the cloud path, which is slower but needs no setup.
