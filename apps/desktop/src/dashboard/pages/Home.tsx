import { useEffect, useState } from 'react';
import {
  ArrowUp, BookOpen, Check, Code2, Eye, Headphones, HelpCircle, Lightbulb, MessagesSquare, Mic, NotebookPen, Pause, Play, Radio, Sparkles, Square, UserRound, Waves,
} from 'lucide-react';
import type { DocumentSummary, Mode, SecretsStatus } from '@hirora/contracts';
import { MODE_LABELS } from '@hirora/contracts';
import { Button, Card, LevelMeter, cx } from '@hirora/ui';
import { invoke } from '../../shared/api';
import { useLive } from '../../shared/store';
import { AnswerView, ConsentModal, TranscriptLine } from '../../overlay/Overlay';
import { PageHeader } from '../App';

const MODE_TILES: Array<{ mode: Mode; icon: typeof Mic; hint: string }> = [
  { mode: 'interview_practice', icon: MessagesSquare, hint: 'Rehearse answers' },
  { mode: 'live_copilot', icon: Radio, hint: 'Authorised calls' },
  { mode: 'coding', icon: Code2, hint: 'Code, tests, Big-O' },
  { mode: 'explain', icon: Lightbulb, hint: 'Teach me simply' },
  { mode: 'general', icon: HelpCircle, hint: 'Quick facts' },
  { mode: 'meeting_notes', icon: NotebookPen, hint: 'Decisions & actions' },
];

function stateText(s: string | undefined): string {
  if (!s || s === 'off') return 'Off';
  return s[0]!.toUpperCase() + s.slice(1);
}

export function Home({ go }: { go: (page: string) => void }) {
  const settings = useLive((s) => s.settings);
  const setSettings = useLive((s) => s.setSettings);
  const snapshot = useLive((s) => s.snapshot);
  const segments = useLive((s) => s.segments);
  const answers = useLive((s) => s.answers);
  const currentId = useLive((s) => s.currentAnswerId);
  const levels = useLive((s) => s.levels);
  const [secrets, setSecrets] = useState<SecretsStatus | null>(null);
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [consent, setConsent] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => {
    void invoke('secrets:status').then(setSecrets);
    void invoke('knowledge:list').then(setDocs);
  }, [settings]);

  if (!settings) return null;
  const primary = settings.answer.primaryProvider;
  const model = primary ? settings.providers[primary].model : '';
  const sttKeyOk = secrets ? secrets.providers[settings.stt.provider === 'cloud-whisper' ? 'cloud' : settings.stt.provider === 'gemini-live' ? 'gemini' : 'xai'].hasKey : false;
  const state = snapshot?.session ?? 'idle';
  const active = state === 'listening' || state === 'paused';
  const answer = currentId ? answers[currentId] : undefined;
  const src = (s: 'mic' | 'system' | 'app') => snapshot?.sources.find((x) => x.source === s);
  const sys = src('system') ?? src('app');
  const mic = src('mic');
  const checks = [
    { ok: !!secrets && Object.values(secrets.providers).some((p) => p.hasKey), title: 'Add an API key', desc: 'Stored encrypted with Windows DPAPI.', page: 'settings' },
    { ok: !!model, title: 'Choose an answer model', desc: 'Picked from the live model list for your key.', page: 'settings' },
    { ok: sttKeyOk, title: 'Live transcription key', desc: settings.stt.provider === 'cloud-whisper' ? 'Hirora Cloud transcribes with your access code — free, no GPU needed.' : settings.stt.provider === 'gemini-live' ? 'Gemini 3.5 Transcribe Live uses your Gemini key.' : 'xAI streaming STT uses your xAI key.', page: 'settings' },
    { ok: docs.length > 0, title: 'Add your resume (optional)', desc: 'Grounds answers about you in your real experience.', page: 'knowledge' },
  ];
  const pending = checks.filter((c) => !c.ok);

  return (
    <>
      <PageHeader
        light="Ready when"
        bold="you are."
        sub="Pick what you're doing, start listening, and Hirora cues you in quietly — here or in the floating overlay."
        right={
          <span className="dash-status-pill">
            <span className={cx('dot', state === 'listening' && 'is-live', state === 'paused' && 'is-paused')} />
            {state === 'listening' ? 'Listening' : state === 'paused' ? 'Paused' : 'Not listening'}
          </span>
        }
      />
      <div className="dash-cols">
        <Card>
          <h2 className="dash-section-title">What are you doing?</h2>
          <p className="dash-section-sub">The mode shapes every answer — length, format and what counts as evidence.</p>
          <div className="dash-modes" role="radiogroup" aria-label="Mode">
            {MODE_TILES.map(({ mode, icon: Icon, hint }) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={settings.answer.mode === mode}
                className={cx('dash-mode', settings.answer.mode === mode && 'is-active')}
                onClick={async () => setSettings(await invoke('settings:update', { answer: { mode } }))}
              >
                <span className="dash-mode__icon"><Icon size={24} strokeWidth={1.6} /></span>
                <span className="dash-mode__label">{MODE_LABELS[mode]}</span>
                <span className="dash-mode__hint">{hint}</span>
              </button>
            ))}
          </div>
          <div className="dash-start">
            {!active ? (
              <Button variant="primary" icon={<Mic size={17} />} onClick={() => setConsent(true)}>Start listening</Button>
            ) : (
              <>
                <Button variant="primary" icon={state === 'paused' ? <Play size={16} /> : <Pause size={16} />} onClick={() => void invoke(state === 'paused' ? 'session:resume' : 'session:pause')}>{state === 'paused' ? 'Resume' : 'Pause'}</Button>
                <Button variant="danger" icon={<Square size={14} />} onClick={() => void invoke('session:stop')}>Stop</Button>
              </>
            )}
            <Button icon={<Eye size={16} />} onClick={() => void invoke('overlay:toggle')}>Overlay</Button>
            <span className="dash-start__note"><kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Space</kbd> shows it anywhere</span>
          </div>
        </Card>

        <div className="dash-panel">
          <h2 className="dash-section-title">Right now</h2>
          <p className="dash-section-sub">{snapshot ? `Today: ${snapshot.usageToday.answers} answers · ${snapshot.usageToday.sttMinutes.toFixed(1)} min transcribed` : '…'}</p>
          <div className="dash-tiles">
            <button type="button" className="dash-tile t-mint" onClick={() => go('settings')}>
              <div className="dash-tile__row"><span className="dash-tile__icon"><Mic size={17} /></span><span className="dash-tile__state">{settings.audio.micEnabled ? stateText(mic?.state) : 'Disabled'}</span></div>
              <span className="dash-tile__label">Microphone</span>
              <span className="dash-tile__value">{mic?.deviceName ?? 'Windows default'}</span>
              <LevelMeter db={levels.mic ?? -100} label="Microphone level" />
            </button>
            <button type="button" className="dash-tile t-sky" onClick={() => go('settings')}>
              <div className="dash-tile__row"><span className="dash-tile__icon"><Headphones size={17} /></span><span className="dash-tile__state">{settings.audio.systemEnabled ? stateText(sys?.state) : 'Disabled'}</span></div>
              <span className="dash-tile__label">{settings.audio.appCaptureName ? `App audio · ${settings.audio.appCaptureName}` : 'System audio'}</span>
              <span className="dash-tile__value">{sys?.deviceName ?? 'Default output'}</span>
              <LevelMeter db={levels.system ?? levels.app ?? -100} label="System audio level" />
            </button>
            <button type="button" className="dash-tile t-lilac" onClick={() => go('settings')}>
              <div className="dash-tile__row"><span className="dash-tile__icon"><Waves size={17} /></span><span className="dash-tile__state">{sttKeyOk ? (sys?.sttState === 'open' || mic?.sttState === 'open' ? 'Streaming' : 'Ready') : 'Needs key'}</span></div>
              <span className="dash-tile__label">Transcription</span>
              <span className="dash-tile__value">{settings.stt.provider === 'cloud-whisper' ? 'Hirora Cloud · Whisper' : settings.stt.provider === 'gemini-live' ? 'Gemini 3.5 Transcribe Live' : 'xAI streaming STT'}</span>
            </button>
            <button type="button" className="dash-tile t-peach" onClick={() => go('settings')}>
              <div className="dash-tile__row"><span className="dash-tile__icon"><Sparkles size={17} /></span><span className="dash-tile__state">{model ? 'Ready' : 'Not set'}</span></div>
              <span className="dash-tile__label">Answer model</span>
              <span className="dash-tile__value">{model ? `${primary} · ${model}` : 'Add a key in Settings'}</span>
            </button>
            <button type="button" className="dash-tile t-blush" onClick={() => go('knowledge')}>
              <div className="dash-tile__row"><span className="dash-tile__icon"><BookOpen size={17} /></span><span className="dash-tile__state">{docs.length ? 'Indexed' : 'Empty'}</span></div>
              <span className="dash-tile__label">Knowledge</span>
              <span className="dash-tile__value">{docs.length} document{docs.length === 1 ? '' : 's'}</span>
            </button>
            <button type="button" className="dash-tile t-sand" onClick={() => go('profiles')}>
              <div className="dash-tile__row"><span className="dash-tile__icon"><UserRound size={17} /></span><span className="dash-tile__state">{snapshot?.activeProfileName ? 'Active' : 'None'}</span></div>
              <span className="dash-tile__label">Profile</span>
              <span className="dash-tile__value">{snapshot?.activeProfileName ?? 'Generic answers'}</span>
            </button>
          </div>
          {pending.length ? (
            <div style={{ marginTop: 18 }}>
              <h3 className="dash-section-title" style={{ fontSize: '1.05em' }}>Finish setting up</h3>
              {pending.map((c) => (
                <div className="dash-check" key={c.title}>
                  <span className="dash-check__icon is-todo"><Check size={15} /></span>
                  <div className="dash-check__body"><div className="dash-check__title">{c.title}</div><div className="dash-check__desc">{c.desc}</div></div>
                  <Button size="sm" onClick={() => go(c.page)}>Open</Button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <Card>
        <div className="vc-card__head">
          <h2 className="dash-section-title" style={{ margin: 0 }}>Live</h2>
          {segments.length ? <Button size="sm" variant="ghost" onClick={() => void invoke('session:clearTranscript').then(() => useLive.setState({ segments: [] }))}>Clear</Button> : null}
        </div>
        <div className="dash-live">
          {snapshot?.sources.some((s) => s.sttError) ? (
            <div className="ov-error">{snapshot.sources.filter((s) => s.sttError).map((s) => `${s.source}: ${s.sttError}`).join(' · ')}</div>
          ) : null}
          <div className="dash-transcript" aria-label="Transcript">
            {segments.length === 0 ? <span className="dash-small">Transcript appears here once you start listening. Typing works any time.</span> : segments.slice(-30).map((s) => <TranscriptLine key={s.id} seg={s} />)}
          </div>
          <form
            className="dash-ask"
            onSubmit={(e) => {
              e.preventDefault();
              if (!q.trim()) {
                void invoke('ask:latest');
                return;
              }
              void invoke('ask:text', { text: q.trim() });
              setQ('');
            }}
          >
            <input placeholder="Type a question — or press Enter on empty to answer the latest one" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Type a question" />
            <Button variant="primary" type="submit" icon={<ArrowUp size={16} />} aria-label="Ask">Ask</Button>
          </form>
          {answer ? <div className="dash-answer"><AnswerView a={answer} compact={false} /></div> : null}
        </div>
      </Card>

      {consent ? (
        <div className="dash-modal">
          <div style={{ position: 'relative', width: 'min(520px, 100%)', minHeight: 300 }}><ConsentModal onCancel={() => setConsent(false)} /></div>
        </div>
      ) : null}
    </>
  );
}
