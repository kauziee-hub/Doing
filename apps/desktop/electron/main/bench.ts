import { app } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderId, SttProviderId } from '@hirora/contracts';
import { PROVIDER_IDS, isKeyless } from '@hirora/contracts';
import { STT_KEY_PROVIDER, createTranscriber, toProviderError } from '@hirora/providers';
import { buildMessages } from '@hirora/orchestration';
import { percentile } from '@hirora/knowledge';
import type { AppServices } from './services';
import type { Logger } from './logger';

interface Run {
  provider: string;
  model: string;
  scenario: string;
  ok: boolean;
  ttftMs: number | null;
  totalMs: number | null;
  chars: number;
  error: string | null;
}

const SCENARIOS: Array<{ id: string; question: string; mode: 'general' | 'coding' | 'interview_practice'; rag: boolean }> = [
  { id: 'simple', question: 'In one sentence, what is a hash map?', mode: 'general', rag: false },
  { id: 'rag', question: 'Tell me about a project where you had measurable impact.', mode: 'interview_practice', rag: true },
  { id: 'coding', question: 'Write a function that returns the length of the longest substring without repeating characters.', mode: 'coding', rag: false },
];

function summarize(runs: Run[]) {
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    const k = `${r.provider}|${r.model}|${r.scenario}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()].map(([k, rs]) => {
    const [provider, model, scenario] = k.split('|');
    const ok = rs.filter((r) => r.ok && r.ttftMs !== null);
    const tt = ok.map((r) => r.ttftMs!).sort((a, b) => a - b);
    const tot = ok.map((r) => r.totalMs!).sort((a, b) => a - b);
    return {
      provider,
      model,
      scenario,
      runs: rs.length,
      ok: ok.length,
      ttftP50: tt.length ? Math.round(percentile(tt, 50)) : null,
      ttftP95: tt.length ? Math.round(percentile(tt, 95)) : null,
      totalP50: tot.length ? Math.round(percentile(tot, 50)) : null,
      totalP95: tot.length ? Math.round(percentile(tot, 95)) : null,
      errors: rs.filter((r) => !r.ok).map((r) => r.error),
    };
  });
}

function synthesizeSpeech(text: string, out: string): Promise<void> {
  // Windows' built-in SAPI voice renders a deterministic, clearly labelled TTS
  // fixture locally. It is real audio fed through the real STT path.
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile('${out.replace(/'/g, "''")}', $f); $s.Speak('${text.replace(/'/g, "''")}'); $s.Dispose()`;
  return new Promise((resolve, reject) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 30_000 }, (err) => (err ? reject(err) : resolve())),
  );
}

function wordErrorRate(ref: string, hyp: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const r = norm(ref);
  const h = norm(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => Array.from({ length: h.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= r.length; i++)
    for (let j = 1; j <= h.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
  return r.length ? d[r.length]![h.length]! / r.length : 0;
}

async function benchStt(svc: AppServices, provider: SttProviderId, log: Logger) {
  const key = svc.vault.get(STT_KEY_PROVIDER[provider]);
  if (!key) return { provider, skipped: 'no key' };
  const text = 'Can you walk me through how you would design a rate limiter for a public API?';
  const wav = join(tmpdir(), `hirora-stt-fixture-${process.pid}.wav`);
  try {
    await synthesizeSpeech(text, wav);
    const bytes = readFileSync(wav);
    const pcm = bytes.subarray(44); // 16 kHz mono s16le after the RIFF header
    const stt = createTranscriber(provider, key, { cloudBaseUrl: svc.settings.get().providers.cloud.baseUrl });
    let finalText = '';
    let firstPartialAt: number | null = null;
    let lastFinalAt: number | null = null;
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    const s = svc.settings.get().stt;
    const session = await stt.open(
      { language: s.language, vocabulary: [], geminiMode: 'VERBATIM', endpointingMs: s.endpointingMs },
      {
        onInterim: () => {
          firstPartialAt ??= performance.now();
        },
        onFinalSegment: (t) => {
          firstPartialAt ??= performance.now();
          finalText = `${finalText} ${t}`.trim();
          lastFinalAt = performance.now();
        },
        onUtteranceEnd: () => done(),
        onError: (e) => {
          log.warn('stt bench error', { error: e.message });
          done();
        },
        onClose: () => done(),
      },
    );
    const t0 = performance.now();
    let speechStart: number | null = null;
    for (let off = 0; off < pcm.length; off += 3200) {
      const chunk = pcm.subarray(off, off + 3200);
      if (speechStart === null) {
        let max = 0;
        for (let i = 0; i + 1 < chunk.length; i += 2) max = Math.max(max, Math.abs(chunk.readInt16LE(i)));
        if (max > 600) speechStart = performance.now();
      }
      session.sendAudio(Buffer.from(chunk));
      await new Promise((r) => setTimeout(r, 100));
    }
    const audioEnd = performance.now();
    // 1.2 s of trailing silence lets server endpointing close the utterance.
    for (let i = 0; i < 12; i++) {
      session.sendAudio(Buffer.alloc(3200));
      await new Promise((r) => setTimeout(r, 100));
    }
    session.endOfSpeech();
    await Promise.race([finished, new Promise((r) => setTimeout(r, 8000))]);
    session.close();
    return {
      provider,
      fixture: 'Windows SAPI synthesized speech (labelled TTS fixture)',
      reference: text,
      transcript: finalText,
      wer: +wordErrorRate(text, finalText).toFixed(3),
      firstPartialAfterSpeechStartMs: firstPartialAt && speechStart ? Math.round(firstPartialAt - speechStart) : null,
      finalAfterAudioEndMs: lastFinalAt ? Math.round((lastFinalAt as number) - audioEnd) : null,
      streamedSeconds: +((audioEnd - t0) / 1000).toFixed(2),
    };
  } catch (err) {
    return { provider, error: toProviderError(provider, err).message };
  } finally {
    if (existsSync(wav)) unlinkSync(wav);
  }
}

/** `pnpm perf:live` — real requests with the user's saved keys. Writes a JSON report. */
export async function runLiveBench(svc: AppServices, log: Logger): Promise<number> {
  const n = Math.max(1, Math.min(50, Number(process.env.HIRORA_BENCH_N ?? 5)));
  // Opt-in: bench a local Ollama model without touching the UI (writes to the profile in use).
  const ollamaModel = process.env.HIRORA_BENCH_OLLAMA_MODEL;
  if (ollamaModel) svc.settings.update({ providers: { ollama: { enabled: true, model: ollamaModel } } });
  const only = process.env.HIRORA_BENCH_PROVIDERS?.split(',').map((x) => x.trim()).filter(Boolean);
  const s = svc.settings.get();
  const runs: Run[] = [];
  const loads: Array<{ provider: string; model: string; loadMs: number | null; error: string | null }> = [];
  const configured = PROVIDER_IDS.filter((p) => svc.isReady(p) && s.providers[p].model && (!only || only.includes(p)));
  console.log(`Hirora live bench: providers with key+model = ${configured.join(', ') || '(none)'}; ${n} runs per scenario`);
  for (const id of configured) {
    const resolved = svc.getProvider(id as ProviderId);
    if (!resolved) continue;
    const model = s.providers[id].model;
    if (isKeyless(id)) {
      // What the app does when listening starts: load the local model into memory first.
      const t0 = performance.now();
      try {
        await resolved.preconnect(AbortSignal.timeout(180_000), model);
        loads.push({ provider: id, model, loadMs: Math.round(performance.now() - t0), error: null });
      } catch (err) {
        loads.push({ provider: id, model, loadMs: null, error: toProviderError(id, err).message });
      }
      console.log(`  ${id}/${model} model load: ${loads[loads.length - 1]!.loadMs ?? loads[loads.length - 1]!.error} ms`);
    }
    // Cold-ish connection first (recorded separately), then warm runs.
    for (const sc of SCENARIOS) {
      for (let i = 0; i < n; i++) {
        const evidence = sc.rag ? (await svc.retrieve(sc.question, AbortSignal.timeout(3000))).chunks : [];
        const messages = buildMessages({
          question: sc.question,
          questionOrigin: 'benchmark',
          mode: sc.mode,
          depth: 'fast',
          settings: s.answer,
          includeProfile: true,
          personal: svc.knowledge.getProfile(),
          session: null,
          evidence,
          recentTranscript: [],
          memory: [],
        });
        const t0 = performance.now();
        let ttft: number | null = null;
        let chars = 0;
        try {
          for await (const ch of resolved.stream({ model, messages, maxOutputTokens: s.answer.maxOutputTokens, temperature: s.answer.temperature, effort: 'fast', signal: AbortSignal.timeout(60_000) })) {
            if (ch.type === 'text') {
              ttft ??= performance.now() - t0;
              chars += ch.text.length;
            }
          }
          const total = performance.now() - t0;
          runs.push({ provider: id, model, scenario: sc.id, ok: ttft !== null, ttftMs: ttft, totalMs: total, chars, error: ttft === null ? 'empty answer' : null });
          if (ttft !== null) {
            svc.recordPerf({ stage: 'request_to_first_token', ms: ttft, at: Date.now(), provider: id, model, label: `bench:${sc.id}` });
            svc.recordPerf({ stage: 'answer_total', ms: total, at: Date.now(), provider: id, model, label: `bench:${sc.id}` });
          }
        } catch (err) {
          runs.push({ provider: id, model, scenario: sc.id, ok: false, ttftMs: null, totalMs: null, chars, error: toProviderError(id, err).message });
        }
        console.log(`  ${id}/${model} ${sc.id} #${i + 1}: ${runs[runs.length - 1]!.ok ? `ttft ${Math.round(ttft!)} ms` : runs[runs.length - 1]!.error}`);
      }
    }
  }
  const stt = [];
  if (process.env.HIRORA_BENCH_SKIP_STT !== '1') for (const p of ['cloud-whisper', 'gemini-live', 'xai-stt'] as SttProviderId[]) stt.push(await benchStt(svc, p, log));
  const report = {
    generatedAt: new Date().toISOString(),
    machine: { platform: process.platform, electron: process.versions.electron, node: process.versions.node },
    note: 'Real network measurements with the user’s saved keys. Network conditions at run time are not controlled.',
    runsPerScenario: n,
    modelLoads: loads,
    text: summarize(runs),
    stt,
    rawRuns: runs,
  };
  const repoResults = join(app.getAppPath(), '..', '..', 'tests', 'performance', 'results');
  const dir = !app.isPackaged && existsSync(join(repoResults, '..')) ? repoResults : join(app.getPath('userData'), 'perf');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `live-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ text: report.text, stt: report.stt }, null, 2));
  console.log(`report written: ${file}`);
  return configured.length === 0 && stt.every((x) => 'skipped' in x) ? 2 : 0;
}
