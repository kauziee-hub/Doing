import { create } from 'zustand';
import type { AnswerRecord, AppSettings, AudioSource, EngineStatus, LiveEvent, LiveSnapshot, TranscriptSegment } from '@hirora/contracts';
import { invoke, onLive, reportPaint } from './api';

export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

interface LiveState {
  snapshot: LiveSnapshot | null;
  settings: AppSettings | null;
  /** The on-PC engine: what is installed, setup progress, hardware. */
  engine: EngineStatus | null;
  segments: TranscriptSegment[];
  answers: Record<string, AnswerRecord>;
  answerOrder: string[];
  currentAnswerId: string | null;
  levels: Partial<Record<AudioSource, number>>;
  toasts: Toast[];
  commands: Array<{ id: number; command: string; arg?: unknown }>;
  setSettings(s: AppSettings): void;
  refreshSettings(): Promise<void>;
  dismissToast(id: number): void;
  toast(level: Toast['level'], message: string): void;
  consumeCommand(id: number): void;
}

let toastId = 0;
let cmdId = 0;
const paintedFirstDelta = new Set<string>();

export const useLive = create<LiveState>((set, get) => ({
  snapshot: null,
  settings: null,
  engine: null,
  segments: [],
  answers: {},
  answerOrder: [],
  currentAnswerId: null,
  levels: {},
  toasts: [],
  commands: [],
  setSettings: (s) => set({ settings: s }),
  refreshSettings: async () => set({ settings: await invoke('settings:get') }),
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  toast: (level, message) => {
    const id = ++toastId;
    set({ toasts: [...get().toasts.slice(-3), { id, level, message }] });
    setTimeout(() => get().dismissToast(id), level === 'error' ? 9000 : 5000);
  },
  consumeCommand: (id) => set({ commands: get().commands.filter((c) => c.id !== id) }),
}));

function upsertSegment(list: TranscriptSegment[], seg: TranscriptSegment): TranscriptSegment[] {
  const idx = list.findIndex((s) => s.id === seg.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = seg;
    return next;
  }
  const next = [...list, seg];
  return next.length > 300 ? next.slice(-300) : next;
}

let started = false;

/** Subscribes this window to main-process live events (idempotent). */
export function startLiveSync(opts: { reportFirstPaint: boolean }): void {
  if (started) return;
  started = true;
  const st = useLive;
  onLive((ev: LiveEvent) => {
    switch (ev.type) {
      case 'snapshot':
        st.setState({ snapshot: ev.snapshot });
        break;
      case 'transcript':
        st.setState({ segments: upsertSegment(st.getState().segments, ev.segment) });
        break;
      case 'answer': {
        const s = st.getState();
        const prev = s.answers[ev.answer.requestId];
        // Keep locally accumulated text if the record arrives before the final flush.
        const rec = prev && prev.text.length > ev.answer.text.length && ev.answer.status !== 'done' ? { ...ev.answer, text: prev.text } : ev.answer;
        const order = s.answerOrder.includes(rec.requestId) ? s.answerOrder : [...s.answerOrder, rec.requestId].slice(-30);
        st.setState({ answers: { ...s.answers, [rec.requestId]: rec }, answerOrder: order, currentAnswerId: rec.requestId });
        break;
      }
      case 'answer_delta': {
        const s = st.getState();
        const prev = s.answers[ev.requestId];
        if (!prev) break;
        st.setState({ answers: { ...s.answers, [ev.requestId]: { ...prev, text: prev.text + ev.delta, status: 'streaming' } } });
        if (opts.reportFirstPaint && !paintedFirstDelta.has(ev.requestId)) {
          paintedFirstDelta.add(ev.requestId);
          reportPaint(`ans:${ev.requestId}`);
        }
        break;
      }
      case 'levels':
        st.setState({ levels: { ...st.getState().levels, ...ev.levels } });
        break;
      case 'toast':
        st.getState().toast(ev.level, ev.message);
        break;
      case 'engine':
        st.setState({ engine: ev.status });
        break;
      case 'command':
        if (ev.command === 'settingsChanged') {
          void st.getState().refreshSettings();
          break;
        }
        if (ev.command === 'paintProbe' && typeof ev.arg === 'string') {
          reportPaint(ev.arg);
          break;
        }
        st.setState({ commands: [...st.getState().commands, { id: ++cmdId, command: ev.command, arg: ev.arg }] });
        if (ev.command === 'setCompact') void st.getState().refreshSettings();
        break;
    }
  });
  void (async () => {
    const [snap, settings, engine] = await Promise.all([invoke('session:snapshot'), invoke('settings:get'), invoke('engine:status')]);
    const answers: Record<string, AnswerRecord> = {};
    for (const a of snap.answers) answers[a.requestId] = a;
    st.setState({
      snapshot: snap.snapshot,
      segments: snap.segments,
      answers,
      answerOrder: snap.answers.map((a) => a.requestId),
      currentAnswerId: snap.answers[snap.answers.length - 1]?.requestId ?? null,
      settings,
      engine: st.getState().engine ?? engine,
    });
  })();
}
