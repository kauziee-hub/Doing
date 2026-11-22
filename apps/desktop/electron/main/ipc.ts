import { app, clipboard, desktopCapturer, dialog, ipcMain, screen, shell } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { readFile, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { release } from 'node:os';
import type {
  AppSettings,
  CaptureCheckResult,
  DocKind,
  IpcChannel,
  IpcResponses,
  LocalBenchResult,
  ScreenPreview,
} from '@hirora/contracts';
import { IpcRequestSchemas, detectSecrets, redactSecrets, defaultSettings } from '@hirora/contracts';
import { analyzeQuestion, buildMessages } from '@hirora/orchestration';
import { percentile } from '@hirora/knowledge';
import { FrameDecoder } from './audioHelper';
import type { AppServices } from './services';
import type { WindowManager } from './windows';
import type { HotkeyManager, TrayController } from './shell';
import { runCaptureCheck } from './capture';

const EXTERNAL_HOSTS = new Set([
  'aistudio.google.com',
  'ai.google.dev',
  'console.x.ai',
  'ollama.com',
  'docs.x.ai',
  'platform.deepseek.com',
  'api-docs.deepseek.com',
  'learn.microsoft.com',
  'www.electronjs.org',
  'support.microsoft.com',
]);

type Handler<C extends IpcChannel> = (payload: unknown, event: IpcMainInvokeEvent) => Promise<IpcResponses[C]> | IpcResponses[C];

export interface IpcContext {
  services: AppServices;
  windows: WindowManager;
  hotkeys: HotkeyManager;
  tray: TrayController;
  paintTokens: Map<string, { at: number; stage: 'hotkey_to_paint' }>;
}

function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? '';
  if (url.startsWith('file://')) return true;
  const dev = process.env.ELECTRON_RENDERER_URL;
  return !!dev && !app.isPackaged && url.startsWith(dev);
}

const screenPreviews = new Map<string, { base64: string; mime: 'image/jpeg'; at: number }>();

export function registerIpc(ctx: IpcContext): void {
  const { services: svc, windows } = ctx;

  const handlers: { [C in IpcChannel]: Handler<C> } = {
    'app:info': () => ({
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node,
      platform: process.platform,
      osRelease: release(),
      arch: process.arch,
      userDataPath: app.getPath('userData'),
      helperPath: svc.helper.exePath,
      packaged: app.isPackaged,
    }),
    'app:openExternal': async (p) => {
      const { url } = IpcRequestSchemas['app:openExternal'].parse(p);
      const u = new URL(url);
      if (u.protocol !== 'https:' || !EXTERNAL_HOSTS.has(u.hostname)) return { ok: false };
      await shell.openExternal(u.toString());
      return { ok: true };
    },
    'app:openDataFolder': async () => {
      await shell.openPath(app.getPath('userData'));
      return { ok: true };
    },
    'settings:get': () => svc.settings.get(),
    'settings:update': (p) => {
      const patch = IpcRequestSchemas['settings:update'].parse(p);
      const next = svc.settings.update(patch);
      if ('hotkeys' in patch) ctx.hotkeys.registerAll();
      if ('overlay' in patch) windows.applyOverlaySettings();
      return next;
    },
    'settings:reset': (p) => {
      const { section } = IpcRequestSchemas['settings:reset'].parse(p);
      const d = defaultSettings();
      let next: AppSettings;
      if (section === 'all') next = svc.settings.replace({ ...d, onboardingComplete: svc.settings.get().onboardingComplete });
      else next = svc.settings.update({ [section]: d[section] });
      ctx.hotkeys.registerAll();
      windows.applyOverlaySettings();
      return next;
    },
    'engine:status': () => svc.engine.refresh(),
    'engine:setup': () => {
      // Runs in the background; progress arrives as live 'engine' events.
      void svc.engine.setup().then(() => {
        if (svc.engine.status().ready) void svc.warmUp();
      });
      return svc.engine.status();
    },
    'engine:cancel': () => {
      svc.engine.cancel();
      return svc.engine.status();
    },
    'audio:devices': async () => {
      try {
        const d = await svc.helper.request<{ capture: never[]; render: never[] }>('list_devices');
        return { capture: d.capture, render: d.render, error: null };
      } catch (err) {
        return { capture: [], render: [], error: (err as Error).message };
      }
    },
    'audio:apps': async () => {
      try {
        const apps = await svc.helper.request<never[]>('list_audio_apps');
        return { apps: apps.filter((a: { exe: string }) => !/hirora/i.test(a.exe)), error: null };
      } catch (err) {
        return { apps: [], error: (err as Error).message };
      }
    },
    'audio:testDevice': async (p) => {
      const { source, seconds } = IpcRequestSchemas['audio:testDevice'].parse(p);
      if (svc.session.sessionState === 'listening') return { ok: false, peakDbfs: -100, frames: 0, error: 'Stop listening before running a device test.' };
      const s = svc.settings.get();
      let peak = -100;
      let frames = 0;
      const onFrame = (src: string, pcm: Buffer) => {
        if (src !== source) return;
        frames++;
        let max = 0;
        for (let i = 0; i + 1 < pcm.length; i += 2) max = Math.max(max, Math.abs(pcm.readInt16LE(i)));
        const db = max === 0 ? -100 : 20 * Math.log10(max / 32768);
        peak = Math.max(peak, db);
        svc.emit({ type: 'levels', levels: { [source]: db } as never });
      };
      svc.helper.on('frame', onFrame);
      try {
        await svc.helper.request('start', { source, deviceId: source === 'mic' ? s.audio.micDeviceId : s.audio.systemDeviceId, gain: source === 'mic' ? s.audio.micGain : 1 });
        await new Promise((r) => setTimeout(r, seconds * 1000));
        return { ok: frames > 0, peakDbfs: Math.round(peak * 10) / 10, frames, error: frames > 0 ? null : 'No audio frames received from the device.' };
      } catch (err) {
        return { ok: false, peakDbfs: -100, frames, error: (err as Error).message };
      } finally {
        svc.helper.off('frame', onFrame);
        await svc.helper.request('stop', { source }).catch(() => undefined);
      }
    },
    'session:start': async (p) => {
      IpcRequestSchemas['session:start'].parse(p);
      if (!svc.engine.status().ready) {
        svc.emit({ type: 'toast', level: 'warn', message: 'Finish setting up Hirora first: open Home and press Set up.' });
        windows.showDashboard();
        return svc.session.snapshot();
      }
      void svc.preconnect();
      // Transcription must be up before audio flows (it usually already is: the app warms up at launch).
      const speech = await svc.engine.startSpeech();
      if (speech) svc.emit({ type: 'toast', level: 'error', message: speech });
      const snap = await svc.session.start(true);
      ctx.tray.refresh();
      return snap;
    },
    'session:stop': async () => {
      const snap = await svc.session.stop();
      ctx.tray.refresh();
      return snap;
    },
    'session:pause': async () => {
      const r = await svc.session.pause();
      ctx.tray.refresh();
      return r;
    },
    'session:resume': async () => {
      const r = await svc.session.resume();
      ctx.tray.refresh();
      return r;
    },
    'session:setSourceMuted': (p) => {
      const { source, muted } = IpcRequestSchemas['session:setSourceMuted'].parse(p);
      return svc.session.setMuted(source, muted);
    },
    'session:snapshot': () => {
      const rid = svc.answer.currentRequestId;
      const answers = rid && svc.answer.getRecord(rid) ? [svc.answer.getRecord(rid)!] : [];
      return { snapshot: svc.session.snapshot(), segments: svc.session.transcript.slice(-80), answers };
    },
    'session:clearTranscript': () => {
      svc.session.clearTranscript();
      return { ok: true };
    },
    'ask:text': (p) => {
      const { text, mode, depth, origin } = IpcRequestSchemas['ask:text'].parse(p);
      svc.session.noteTyped(text);
      const requestId = svc.answer.ask({ question: text, origin: origin ?? 'typed', mode, depth: depth ?? 'fast', questionEndedAt: Date.now() });
      return { requestId, error: null };
    },
    'ask:latest': () => svc.session.askLatest(),
    'ask:segment': (p) => svc.session.askSegment(IpcRequestSchemas['ask:segment'].parse(p).segmentId),
    'ask:followup': (p) => {
      const { requestId, action } = IpcRequestSchemas['ask:followup'].parse(p);
      const rec = svc.answer.getRecord(requestId);
      if (!rec) return { requestId: null, error: 'Answer not found (it may be from an older session).' };
      const base = { question: rec.question, origin: rec.questionSource, mode: rec.mode, questionEndedAt: Date.now() } as const;
      let id: string;
      switch (action) {
        case 'expand':
          id = svc.answer.ask({ ...base, depth: 'deep', useMemory: true, instruction: 'Give the in-depth version: deeper reasoning, examples and trade-offs.' });
          break;
        case 'beginner':
          id = svc.answer.ask({ ...base, priorAnswer: rec.text, instruction: 'Re-explain the answer for a beginner: simple words, one analogy, define any jargon. Keep all facts unchanged.' });
          break;
        case 'concise':
          id = svc.answer.ask({ ...base, priorAnswer: rec.text, instruction: 'Rewrite the answer about half as long, keeping only the most important points and any code.' });
          break;
        case 'retry':
          id = svc.answer.ask({ ...base, depth: rec.depth });
          break;
      }
      return { requestId: id, error: null };
    },
    'ask:screen': (p) => {
      const { previewId, question } = IpcRequestSchemas['ask:screen'].parse(p);
      const prev = screenPreviews.get(previewId);
      if (!prev) return { requestId: null, error: 'Screenshot preview expired. Capture again.' };
      if (!svc.engine.answerModelReadsImages) {
        screenPreviews.delete(previewId);
        return { requestId: null, error: 'The answer model on this PC can’t read images (it needs the NVIDIA GPU setup). Copy the text and use the clipboard button instead.' };
      }
      screenPreviews.delete(previewId);
      const q = question.trim() || 'Describe what is on this screen and answer any question or task shown.';
      svc.session.noteTyped(`[screenshot] ${q}`);
      const id = svc.answer.ask({ question: q, origin: 'screen', images: [{ type: 'image', mimeType: prev.mime, base64: prev.base64 }], questionEndedAt: Date.now() });
      return { requestId: id, error: null };
    },
    'answer:cancel': () => ({ ok: svc.answer.cancel('user') }),
    'context:readClipboard': async () => {
      const raw = String(await clipboard.readText());
      const truncated = raw.length > 20_000;
      const text = raw.slice(0, 20_000);
      const findings = detectSecrets(text);
      return { text, truncated, secretFindings: findings, redactedText: redactSecrets(text, findings) };
    },
    'context:captureScreen': async (p) => {
      const { displayId } = IpcRequestSchemas['context:captureScreen'].parse(p);
      const display = displayId !== undefined ? screen.getAllDisplays().find((d) => d.id === displayId) ?? screen.getPrimaryDisplay() : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const overlayVisible = windows.overlay?.isVisible() ?? false;
      // Keep Hirora's own overlay out of the screenshot.
      if (overlayVisible) windows.overlay?.hide();
      await new Promise((r) => setTimeout(r, 180));
      try {
        const sf = display.scaleFactor;
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.size.width * sf), height: Math.round(display.size.height * sf) } });
        const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
        if (!src || src.thumbnail.isEmpty()) return { error: 'Screen capture returned no image (permission or capture API unavailable).' };
        let img = src.thumbnail;
        if (img.getSize().width > 1600) img = img.resize({ width: 1600, quality: 'good' });
        const jpeg = img.toJPEG(82);
        const previewId = `scr-${Date.now().toString(36)}`;
        screenPreviews.set(previewId, { base64: jpeg.toString('base64'), mime: 'image/jpeg', at: Date.now() });
        for (const [k, v] of screenPreviews) if (Date.now() - v.at > 5 * 60_000) screenPreviews.delete(k);
        const out: ScreenPreview = {
          previewId,
          dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
          width: img.getSize().width,
          height: img.getSize().height,
          displayLabel: `${display.label || 'Display'} (${display.size.width}×${display.size.height})`,
          capturedAt: Date.now(),
        };
        return out;
      } finally {
        if (overlayVisible) windows.overlay?.showInactive();
      }
    },
    'context:discardScreen': (p) => {
      screenPreviews.delete(IpcRequestSchemas['context:discardScreen'].parse(p).previewId);
      return { ok: true };
    },
    'knowledge:list': () => svc.knowledge.listDocuments(),
    'knowledge:pickFiles': async (p) => {
      const { kind } = IpcRequestSchemas['knowledge:pickFiles'].parse(p);
      const parent = windows.dashboard ?? undefined;
      const opts = {
        title: 'Add documents to Hirora',
        properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
        filters: [
          { name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md', 'markdown', 'csv', 'json', 'jsonl'] },
          { name: 'Code', extensions: ['py', 'js', 'ts', 'tsx', 'jsx', 'java', 'cpp', 'cc', 'c', 'h', 'hpp', 'cs', 'go', 'rs', 'sql', 'kt', 'rb', 'php', 'swift', 'ipynb'] },
          { name: 'All files', extensions: ['*'] },
        ],
      };
      const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
      if (r.canceled) return [];
      return ingestPaths(svc, r.filePaths, kind);
    },
    'knowledge:ingestPaths': (p) => {
      const { kind, paths } = IpcRequestSchemas['knowledge:ingestPaths'].parse(p);
      return ingestPaths(svc, paths, kind);
    },
    'knowledge:preview': (p) => {
      const { documentId } = IpcRequestSchemas['knowledge:preview'].parse(p);
      const doc = svc.knowledge.getDocument(documentId);
      if (!doc) return null;
      const chunks = svc.knowledge.getChunks(documentId).slice(0, 60).map((c) => ({ id: c.id, ordinal: c.ordinal, page: c.page, section: c.section, text: c.text }));
      return { document: doc, chunks };
    },
    'knowledge:delete': (p) => ({ ok: svc.knowledge.deleteDocument(IpcRequestSchemas['knowledge:delete'].parse(p).documentId) }),
    'knowledge:setKind': (p) => {
      const { documentId, kind } = IpcRequestSchemas['knowledge:setKind'].parse(p);
      return { ok: svc.knowledge.setKind(documentId, kind) };
    },
    'knowledge:search': async (p) => {
      const { query } = IpcRequestSchemas['knowledge:search'].parse(p);
      const r = await svc.retrieve(query, AbortSignal.timeout(5000));
      return { results: r.chunks, ms: Math.round(r.ms * 10) / 10, usedVectors: r.usedVectors };
    },
    'profile:get': () => svc.knowledge.getProfile(),
    'profile:set': (p) => svc.knowledge.setProfile(IpcRequestSchemas['profile:set'].parse(p)),
    'cards:list': () => svc.knowledge.listCards(),
    'cards:upsert': (p) => svc.knowledge.upsertCard(IpcRequestSchemas['cards:upsert'].parse(p)),
    'cards:delete': (p) => svc.knowledge.deleteCard(IpcRequestSchemas['cards:delete'].parse(p).id),
    'sessionProfiles:list': () => ({ profiles: svc.knowledge.listSessionProfiles(), activeId: svc.settings.get().activeProfileId }),
    'sessionProfiles:upsert': (p) => {
      const profiles = svc.knowledge.upsertSessionProfile(IpcRequestSchemas['sessionProfiles:upsert'].parse(p));
      return { profiles, activeId: svc.settings.get().activeProfileId };
    },
    'sessionProfiles:delete': (p) => {
      const { id } = IpcRequestSchemas['sessionProfiles:delete'].parse(p);
      const profiles = svc.knowledge.deleteSessionProfile(id);
      if (svc.settings.get().activeProfileId === id) svc.settings.update({ activeProfileId: null });
      return { profiles, activeId: svc.settings.get().activeProfileId };
    },
    'sessionProfiles:setActive': (p) => {
      const { id } = IpcRequestSchemas['sessionProfiles:setActive'].parse(p);
      const prof = svc.knowledge.getSessionProfile(id);
      const patch: Record<string, unknown> = { activeProfileId: prof ? prof.id : null };
      svc.settings.update(patch);
      svc.emit({ type: 'snapshot', snapshot: svc.session.snapshot() });
      return { profiles: svc.knowledge.listSessionProfiles(), activeId: svc.settings.get().activeProfileId };
    },
    'history:list': () => svc.history.list(),
    'history:get': (p) => svc.history.get(IpcRequestSchemas['history:get'].parse(p).sessionId),
    'history:delete': (p) => ({ ok: svc.history.delete(IpcRequestSchemas['history:delete'].parse(p).sessionId) }),
    'history:deleteAll': () => ({ ok: true, deleted: svc.history.deleteAll() }),
    'perf:summary': () => ({ rows: svc.perf.summary(), recent: svc.perf.recent(60), total: svc.perf.count() }),
    'perf:clear': () => {
      svc.perf.clear();
      return { ok: true };
    },
    'perf:runLocalBench': () => runLocalBench(svc),
    'overlay:toggle': () => ({ visible: windows.toggleOverlay() }),
    'overlay:setCompact': (p) => {
      const { compact } = IpcRequestSchemas['overlay:setCompact'].parse(p);
      svc.settings.update({ overlay: { compact } });
      return { ok: true };
    },
    'overlay:setFocusable': (p) => {
      const { focusable } = IpcRequestSchemas['overlay:setFocusable'].parse(p);
      if (focusable) windows.overlay?.focus();
      return { ok: true };
    },
    'overlay:reportPaint': (p) => {
      const { token, at } = IpcRequestSchemas['overlay:reportPaint'].parse(p);
      const t = ctx.paintTokens.get(token);
      if (t) {
        ctx.paintTokens.delete(token);
        svc.recordPerf({ stage: t.stage, ms: at - t.at, at: Date.now(), provider: null, model: null, label: token.split(':')[1] ?? null });
        return { ok: true };
      }
      // A hidden overlay still runs rAF (on a slow schedule), but nothing reached the screen:
      // recording it would report 2 s+ "paints" nobody saw. Measured 2026-11-21.
      if (token.startsWith('ans:') && windows.overlay?.isVisible()) {
        const rec = svc.answer.getRecord(token.slice(4));
        if (rec) svc.recordPerf({ stage: 'question_to_first_paint', ms: at - rec.questionEndedAt, at: Date.now(), provider: rec.provider, model: rec.model, label: rec.questionSource });
      }
      return { ok: true };
    },
    'overlay:hide': () => {
      windows.overlay?.hide();
      return { ok: true };
    },
    'dashboard:show': (p) => {
      const { page } = IpcRequestSchemas['dashboard:show'].parse(p);
      windows.showDashboard();
      if (page) svc.emit({ type: 'command', command: 'navigate', arg: page });
      return { ok: true };
    },
    'capture:runCheck': async () => {
      const results = await runCaptureCheck(windows, svc.helper, svc.settings.get().overlay.contentProtection, svc.log);
      svc.captureResults.add(results);
      return svc.captureResults.latest();
    },
    'capture:results': () => svc.captureResults.latest(),
    'capture:recordManual': (p) => {
      const { tool, result, notes } = IpcRequestSchemas['capture:recordManual'].parse(p);
      const r: CaptureCheckResult = {
        method: `manual:${tool}`,
        description: `Manual test with ${tool}${notes ? ` — ${notes}` : ''}`,
        result,
        detail: 'Recorded by the user; not measured by Hirora.',
        contentProtectionEnabled: svc.settings.get().overlay.contentProtection,
        testedAt: Date.now(),
        osRelease: `Windows ${release()}`,
        electron: process.versions.electron ?? '',
      };
      svc.captureResults.add([r]);
      return svc.captureResults.latest();
    },
    'data:deleteAll': async (p) => {
      IpcRequestSchemas['data:deleteAll'].parse(p);
      await svc.session.stop();
      svc.history.deleteAll();
      for (const d of svc.knowledge.listDocuments(true)) svc.knowledge.deleteDocument(d.id);
      for (const c of svc.knowledge.listCards()) svc.knowledge.deleteCard(c.id);
      for (const sp of svc.knowledge.listSessionProfiles()) svc.knowledge.deleteSessionProfile(sp.id);
      svc.db.exec("DELETE FROM kv; DELETE FROM perf_events; DELETE FROM usage_events; DELETE FROM capture_results; DELETE FROM embeddings;");
      svc.db.exec('VACUUM;');
      // API keys saved by Hirora 0.2.x (encrypted) are removed too.
      await rm(join(app.getPath('userData'), 'secrets.json'), { force: true });
      svc.settings.replace(defaultSettings());
      ctx.hotkeys.registerAll();
      windows.applyOverlaySettings();
      return { ok: true };
    },
  };

  for (const channel of Object.keys(handlers) as IpcChannel[]) {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrustedSender(event)) return { ok: false, error: 'Untrusted sender' };
      try {
        const data = await (handlers[channel] as Handler<IpcChannel>)(payload, event);
        return { ok: true, data };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        svc.log.warn('ipc handler error', { channel, error: msg.slice(0, 300) });
        return { ok: false, error: msg.slice(0, 1000) };
      }
    });
  }
}

async function ingestPaths(svc: AppServices, paths: string[], kind: DocKind) {
  const results = [];
  for (const p of paths) {
    const fileName = basename(p);
    const t0 = performance.now();
    try {
      if (!isAbsolute(p)) throw new Error('Path must be absolute');
      const st = await stat(p);
      if (!st.isFile()) throw new Error('Not a file');
      if (st.size > 25 * 1024 * 1024) throw new Error('File is larger than 25 MB');
      const bytes = await readFile(p);
      const r = await svc.knowledge.ingest(fileName, new Uint8Array(bytes), kind, st.mtimeMs);
      results.push({ fileName, ...r, ms: Math.round(r.ms) });
    } catch (err) {
      results.push({ fileName, ok: false, documentId: null, duplicateOf: null, error: (err as Error).message, chunks: 0, ms: Math.round(performance.now() - t0) });
    }
  }
  return results;
}

function bench(label: string, iterations: number, fn: (i: number) => void): LocalBenchResult {
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn(i);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { label, iterations, p50: +percentile(times, 50).toFixed(3), p95: +percentile(times, 95).toFixed(3), unit: 'ms' };
}

/** Local-only micro-benchmarks of real code paths (no network, no synthetic answers). */
function runLocalBench(svc: AppServices): LocalBenchResult[] {
  const queries = [
    'Tell me about a project where you improved performance',
    'What is your experience with distributed systems?',
    'Explain the difference between a process and a thread',
    'How would you design a rate limiter?',
    'Why do you want to work here?',
  ];
  const out: LocalBenchResult[] = [];
  out.push(bench('FTS5 hybrid retrieval (current knowledge base)', 100, (i) => svc.retriever.retrieve(queries[i % queries.length]!, { topK: 5 })));
  out.push(bench('Question detection (per utterance)', 2000, (i) => analyzeQuestion(queries[i % queries.length]!)));
  const settings = svc.settings.get();
  const evidence = svc.retriever.retrieve(queries[0]!, { topK: 5 });
  out.push(
    bench('Prompt assembly', 500, () =>
      buildMessages({
        question: queries[0]!,
        questionOrigin: 'bench',
        depth: 'fast',
        settings: settings.answer,
        includeProfile: true,
        personal: svc.knowledge.getProfile(),
        session: null,
        evidence,
        recentTranscript: [],
        memory: [],
      }),
    ),
  );
  // Decode cost of 1 s of two-source helper traffic (100 frames).
  const frame = Buffer.alloc(24 + 640);
  frame.write('VC', 0, 'latin1');
  frame[2] = 1;
  frame[3] = 1;
  frame[4] = 1;
  frame.writeUInt32LE(640, 20);
  const second = Buffer.concat(Array.from({ length: 100 }, () => frame));
  out.push(bench('Helper protocol decode (1 s of 2-source audio)', 300, () => new FrameDecoder().push(second)));
  return out;
}
