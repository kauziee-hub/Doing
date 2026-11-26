import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  ArrowUpRight, Camera, ChevronsDownUp, ChevronsUpDown, ClipboardPaste, Copy, EyeOff, LayoutDashboard, Mic, MicOff, Pause, Play,
  RotateCcw, Send, Speaker, Square, Sparkles, Baby, Minimize2, X, ShieldAlert, Check,
} from 'lucide-react';
import type { AnswerRecord, AudioSource, ClipboardContext, SourceStatus, TranscriptSegment } from '@hirora/contracts';
import { PROVIDER_ERROR_HINTS } from '@hirora/contracts';
import { Badge, Button, LevelMeter, cx } from '@hirora/ui';
import { invoke } from '../shared/api';
import { useLive } from '../shared/store';
import { Markdown } from '../shared/Markdown';
import { LogoMark } from '../shared/Logo';

const SOURCE_LABEL: Record<string, string> = { mic: 'Mic', system: 'System', app: 'App', typed: 'Typed' };

function chipLabel(s: SourceStatus): string {
  if (s.state === 'muted') return 'muted';
  if (s.state === 'failed') return 'failed';
  if (s.state !== 'streaming') return s.state;
  return s.sttState === 'open' ? 'live' : s.sttState === 'error' ? 'stt error' : s.sttState;
}

export function ConsentModal({ onCancel }: { onCancel: () => void }) {
  const settings = useLive((s) => s.settings);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!settings) return null;
  const sources = [settings.audio.micEnabled && 'your microphone', settings.audio.systemEnabled && (settings.audio.appCaptureName ? `audio from ${settings.audio.appCaptureName}` : 'system (speaker) audio')].filter(Boolean);
  return (
    <div className="ov-modal" role="dialog" aria-modal="true" aria-labelledby="consent-title">
      <div className="ov-modal__box">
        <h2 id="consent-title"><ShieldAlert size={16} /> Start listening?</h2>
        <p>Hirora will capture <strong>{sources.join(' and ') || 'no sources (enable one in Settings → Audio)'}</strong> and transcribe it <strong>on this PC</strong>{settings.answer.screen !== 'off' ? <>; when a question refers to something shown, it also looks at <strong>your screen</strong></> : null}. Nothing is sent anywhere, and audio and screen captures are never saved.</p>
        <p className="ov-muted">Only continue if everyone in the conversation has agreed to be recorded/transcribed and AI assistance is allowed in this setting (many interviews and assessments forbid it).</p>
        {err ? <p className="ov-error">{err}</p> : null}
        <div className="vc-row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || sources.length === 0}
            icon={<Mic size={14} />}
            onClick={async () => {
              setBusy(true);
              try {
                await invoke('session:start', { consent: true });
                onCancel();
              } catch (e) {
                setErr((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            I have consent — start
          </Button>
        </div>
      </div>
    </div>
  );
}

function ClipboardModal({ ctx, onClose }: { ctx: ClipboardContext; onClose: () => void }) {
  const [useRedacted, setUseRedacted] = useState(ctx.secretFindings.length > 0);
  const [question, setQuestion] = useState('');
  const text = useRedacted ? ctx.redactedText : ctx.text;
  return (
    <div className="ov-modal" role="dialog" aria-modal="true" aria-label="Clipboard preview">
      <div className="ov-modal__box ov-modal__box--wide">
        <h2><ClipboardPaste size={16} /> Send clipboard text?</h2>
        {ctx.secretFindings.length > 0 ? (
          <div className="ov-warn">
            Possible secrets detected: {ctx.secretFindings.map((f) => `${f.kind} (${f.preview})`).join(', ')}.
            <label className="vc-row" style={{ marginTop: 6 }}>
              <input type="checkbox" checked={useRedacted} onChange={(e) => setUseRedacted(e.target.checked)} /> Send redacted version
            </label>
          </div>
        ) : null}
        <pre className="ov-preview">{text || '(clipboard is empty)'}</pre>
        {ctx.truncated ? <p className="ov-muted">Truncated to 20,000 characters.</p> : null}
        <input className="vc-input" placeholder="Optional instruction, e.g. “find the bug”" value={question} onChange={(e) => setQuestion(e.target.value)} />
        <div className="vc-row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
          <Button variant="ghost" onClick={onClose}>Discard</Button>
          <Button
            variant="primary"
            disabled={!text.trim()}
            onClick={async () => {
              const full = question.trim() ? `${question.trim()}\n\n${text}` : text;
              await invoke('ask:text', { text: full.slice(0, 20_000), origin: 'clipboard' });
              onClose();
            }}
          >
            Send to model
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Source markers ("[S1]", "[S2, S3]") a model may still write; the owner doesn't want them shown (2026-11-27). */
function withoutMarkers(text: string): string {
  return text.replace(/\s*\[S\d+(?:\s*[,;]\s*S?\d+)*\]/g, '');
}

export function AnswerView({ a, compact }: { a: AnswerRecord; compact: boolean }) {
  const [copied, setCopied] = useState(false);
  const text = withoutMarkers(a.text);
  const busy = a.status === 'queued' || a.status === 'retrieving' || a.status === 'waiting' || a.status === 'streaming';
  const statusLabel: Record<string, string> = { queued: 'Queued', retrieving: 'Searching your materials…', waiting: 'Waiting for model…', streaming: 'Streaming', done: 'Done', error: 'Error', cancelled: 'Cancelled' };
  return (
    <div className={cx('ov-answer', a.status === 'error' && 'is-error')} aria-live="polite" aria-busy={busy}>
      <div className="ov-answer__meta">
        <Badge tone={a.status === 'error' ? 'error' : a.status === 'done' ? 'ok' : a.status === 'cancelled' ? 'neutral' : 'info'}>{statusLabel[a.status]}</Badge>
        {a.model ? <Badge title="Written on this PC">{a.model}</Badge> : null}
        {a.depth === 'deep' ? <Badge tone="info">deep</Badge> : null}
        {a.usedScreen ? <Badge tone="info" title="Your screen was looked at for this answer (on this PC, not saved)">screen</Badge> : null}
        {a.firstTokenMs !== null ? <span className="ov-muted" title="Time from request to first token">{(a.firstTokenMs / 1000).toFixed(2)} s</span> : null}
      </div>
      {!compact ? <div className="ov-q" title={a.question}>Q · {a.question.length > 220 ? `${a.question.slice(0, 220)}…` : a.question}</div> : null}
      {text ? <Markdown text={text} /> : busy ? <div className="ov-skeleton" aria-hidden="true"><span /><span /><span /></div> : null}
      {a.status === 'error' && a.error ? <div className="ov-error">{a.error}{a.errorCode && !a.error.includes(PROVIDER_ERROR_HINTS[a.errorCode]) ? ` ${PROVIDER_ERROR_HINTS[a.errorCode]}` : ''}</div> : null}
      <div className="ov-actions">
        {busy ? <Button size="sm" variant="ghost" icon={<Square size={12} />} onClick={() => void invoke('answer:cancel')}>Stop</Button> : null}
        {text ? (
          <Button size="sm" variant="ghost" icon={copied ? <Check size={12} /> : <Copy size={12} />} onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        ) : null}
        {!busy ? (
          <>
            <Button size="sm" variant="ghost" icon={<Sparkles size={12} />} onClick={() => void invoke('ask:followup', { requestId: a.requestId, action: 'expand' })}>Expand</Button>
            {a.text ? <Button size="sm" variant="ghost" icon={<Baby size={12} />} onClick={() => void invoke('ask:followup', { requestId: a.requestId, action: 'beginner' })}>Beginner</Button> : null}
            {a.text ? <Button size="sm" variant="ghost" icon={<Minimize2 size={12} />} onClick={() => void invoke('ask:followup', { requestId: a.requestId, action: 'concise' })}>Concise</Button> : null}
            <Button size="sm" variant="ghost" icon={<RotateCcw size={12} />} onClick={() => void invoke('ask:followup', { requestId: a.requestId, action: 'retry' })}>Retry</Button>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function TranscriptLine({ seg }: { seg: TranscriptSegment }) {
  const label = SOURCE_LABEL[seg.source] ?? seg.source;
  const committed = seg.committedText ?? (seg.final ? seg.text : '');
  const tentative = seg.tentativeText ?? (!seg.final && !seg.committedText ? seg.text : '');
  return (
    <div className={cx('ov-line', !seg.final && 'is-interim', seg.isQuestion && 'is-question')}>
      <span className={cx('ov-line__src', `src-${seg.source}`)}>{label}</span>
      <span className="ov-line__text">
        {committed}
        {tentative ? <span className="ov-line__tentative">{committed ? ' ' : ''}{tentative}</span> : null}
      </span>
      {seg.final && seg.source !== 'typed' ? (
        <button type="button" className="ov-line__ask" title="Answer this" onClick={() => void invoke('ask:segment', { segmentId: seg.id })}>
          <ArrowUpRight size={12} />
        </button>
      ) : null}
    </div>
  );
}

export function Overlay() {
  const snapshot = useLive((s) => s.snapshot);
  const settings = useLive((s) => s.settings);
  const engine = useLive((s) => s.engine);
  const segments = useLive((s) => s.segments);
  const answers = useLive((s) => s.answers);
  const currentId = useLive((s) => s.currentAnswerId);
  const levels = useLive((s) => s.levels);
  const commands = useLive((s) => s.commands);
  const consume = useLive((s) => s.consumeCommand);
  const toast = useLive((s) => s.toast);
  const [consent, setConsent] = useState(false);
  const [probe, setProbe] = useState(false);
  const [question, setQuestion] = useState('');
  const [clip, setClip] = useState<ClipboardContext | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const compact = settings?.overlay.compact ?? false;
  const answer = currentId ? answers[currentId] : undefined;

  // Looks at the screen now and answers the question or task on it (Ctrl+Shift+O does the same).
  const answerFromScreen = async () => {
    const r = await invoke('ask:screenNow');
    if (r.error) toast('error', r.error);
  };

  useEffect(() => {
    for (const c of commands) {
      if (c.command === 'focusAsk') setTimeout(() => inputRef.current?.focus(), 30);
      if (c.command === 'requestStart') setConsent(true);
      if (c.command === 'captureProbe') setProbe(c.arg === true);
      consume(c.id);
    }
  }, [commands, consume]);

  useEffect(() => {
    document.documentElement.style.setProperty('--scale', String(settings?.overlay.fontScale ?? 1));
  }, [settings?.overlay.fontScale]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [segments]);

  const visibleSegments = useMemo(() => segments.slice(-12), [segments]);
  const state = snapshot?.session ?? 'idle';
  const listening = state === 'listening';
  const paused = state === 'paused';

  if (probe) return <div className="ov-probe" aria-hidden="true" />;

  const submit = async () => {
    const q = question.trim();
    if (!q) {
      await invoke('ask:latest');
      return;
    }
    setQuestion('');
    await invoke('ask:text', { text: q });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    } else if (e.key === 'Escape') {
      (e.target as HTMLTextAreaElement).blur();
    }
  };

  const sourceStatus = (src: AudioSource) => snapshot?.sources.find((s) => s.source === src);
  const providerReady = !!engine?.ready;

  return (
    <div className={cx('ov', compact && 'is-compact', settings?.overlay.glass === false && 'is-solid')}>
      <header className="ov-head">
        <div className="ov-brand">
          <LogoMark size={24} />
          <span className={cx('ov-state', listening && 'is-live', paused && 'is-paused')} role="status">{listening ? 'Listening' : paused ? 'Paused' : 'Idle'}</span>
        </div>
        <div className="ov-sources-bar">
          {(['mic', 'system', 'app'] as AudioSource[]).map((src) => {
            const st = sourceStatus(src);
            if (!st) return null;
            return (
              <div className={cx('ov-chip', src === 'mic' ? 'is-mic' : 'is-sys', (st.state === 'muted' || st.state === 'off') && 'is-off')} key={src} title={`${st.deviceName ?? ''} ${st.sttError ?? st.message ?? ''}`.trim()}>
                <button
                  type="button"
                  className="ov-icon-btn"
                  aria-label={st.state === 'muted' ? `Unmute ${src}` : `Mute ${src}`}
                  onClick={() => void invoke('session:setSourceMuted', { source: src, muted: st.state !== 'muted' })}
                >
                  {src === 'mic' ? (st.state === 'muted' ? <MicOff size={13} /> : <Mic size={13} />) : <Speaker size={13} />}
                </button>
                <LevelMeter db={st.state === 'muted' ? -100 : (levels[src] ?? -100)} label={`${src} level`} />
                <span className="ov-chip__label">{chipLabel(st)}</span>
                {st.sttError || st.state === 'failed' ? <span className="ov-chip__err" aria-label="error" /> : null}
              </div>
            );
          })}
        </div>
        <div className="ov-head__actions">
          {listening || paused ? (
            <>
              <button type="button" className="ov-icon-btn" aria-label={paused ? 'Resume listening' : 'Pause listening'} onClick={() => void invoke(paused ? 'session:resume' : 'session:pause')}>
                {paused ? <Play size={14} /> : <Pause size={14} />}
              </button>
              <button type="button" className="ov-icon-btn is-stop" aria-label="Stop listening" onClick={() => void invoke('session:stop')}>
                <Square size={13} />
              </button>
            </>
          ) : (
            <button type="button" className="ov-icon-btn is-start" aria-label="Start listening" onClick={() => setConsent(true)}>
              <Mic size={14} />
            </button>
          )}
          <button type="button" className="ov-icon-btn" aria-label={compact ? 'Expand overlay' : 'Compact overlay'} onClick={async () => { await invoke('overlay:setCompact', { compact: !compact }); await useLive.getState().refreshSettings(); }}>
            {compact ? <ChevronsUpDown size={14} /> : <ChevronsDownUp size={14} />}
          </button>
          <button type="button" className="ov-icon-btn" aria-label="Open dashboard" onClick={() => void invoke('dashboard:show', {})}>
            <LayoutDashboard size={14} />
          </button>
          <button type="button" className="ov-icon-btn" aria-label="Hide overlay" onClick={() => void invoke('overlay:hide')}>
            <EyeOff size={14} />
          </button>
        </div>
      </header>

      {!providerReady ? (
        <div className="ov-setup">
          {engine?.setup === 'running' ? 'Hirora is still setting up on this PC.' : 'Hirora isn’t set up on this PC yet.'} <button type="button" className="ov-link" onClick={() => void invoke('dashboard:show', { page: 'home' })}>{engine?.setup === 'running' ? 'See progress' : 'Set up now'}</button>
        </div>
      ) : null}

      {!compact && settings?.overlay.showTranscript ? (
        <div className="ov-transcript" ref={transcriptRef} aria-label="Live transcript" aria-live="off">
          {visibleSegments.length === 0 ? (
            <div className="ov-muted ov-small">{listening ? 'Listening… speech will appear here as it is recognised.' : 'Transcript appears here after you start listening. You can also type a question below.'}</div>
          ) : (
            visibleSegments.map((s) => <TranscriptLine key={s.id} seg={s} />)
          )}
        </div>
      ) : null}

      {snapshot?.questionCandidate && (!answer || answer.question !== snapshot.questionCandidate.text) ? (
        <div className="ov-candidate">
          <span className="ov-candidate__label">Question?</span>
          <span className="ov-candidate__text">{snapshot.questionCandidate.text}</span>
          <Button size="sm" variant="primary" onClick={() => void invoke('ask:latest')}>Answer</Button>
        </div>
      ) : null}

      <div className="ov-body">
        {answer ? <AnswerView a={answer} compact={compact} /> : (
          <div className="ov-muted ov-small ov-hint">
            Answers stream here. Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd> to answer the latest question, or type below.
          </div>
        )}
      </div>

      {!compact ? (
        <footer className="ov-ask">
          <textarea
            ref={inputRef}
            className="ov-ask__input"
            rows={1}
            placeholder="Ask or paste a question…"
            title="Enter sends · Shift+Enter new line · Enter on empty answers the latest question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onKey}
            aria-label="Ask a question"
          />
          <button type="button" className="ov-icon-btn" aria-label="Use clipboard text (preview first)" title="Use clipboard text (preview first)" onClick={async () => setClip(await invoke('context:readClipboard'))}>
            <ClipboardPaste size={14} />
          </button>
          <button type="button" className="ov-icon-btn" aria-label="Answer from the screen (Ctrl+Shift+O)" title="Answer from the screen (Ctrl+Shift+O)" onClick={() => void answerFromScreen()}>
            <Camera size={14} />
          </button>
          <button type="button" className="ov-icon-btn is-send" aria-label="Send" onClick={() => void submit()}>
            <Send size={14} />
          </button>
        </footer>
      ) : null}

      {consent ? <ConsentModal onCancel={() => setConsent(false)} /> : null}
      {clip ? <ClipboardModal ctx={clip} onClose={() => setClip(null)} /> : null}
      <Toasts />
    </div>
  );
}

export function Toasts() {
  const toasts = useLive((s) => s.toasts);
  const dismiss = useLive((s) => s.dismissToast);
  return (
    <div className="vc-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('vc-toast', `vc-toast--${t.level}`)}>
          <span>{t.message}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}><X size={13} /></button>
        </div>
      ))}
    </div>
  );
}
