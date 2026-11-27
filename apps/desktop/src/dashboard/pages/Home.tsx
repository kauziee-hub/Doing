import { useEffect, useState } from 'react';
import {
  ArrowUp, BookOpen, Check, Eye, Headphones, Mic, Pause, Play, Sparkles, Square, UserRound, Waves,
} from 'lucide-react';
import type { DocumentSummary } from '@hirora/contracts';
import { Button, Card, LevelMeter, cx } from '@hirora/ui';
import { invoke } from '../../shared/api';
import { useLive } from '../../shared/store';
import { AnswerView, ConsentModal, TranscriptLine } from '../../overlay/Overlay';
import { PageHeader } from '../App';
import { EngineSetup } from '../EngineSetup';

function stateText(s: string | undefined): string {
  if (!s || s === 'off') return 'Off';
  return s[0]!.toUpperCase() + s.slice(1);
}

export function Home({ go }: { go: (page: string) => void }) {
  const settings = useLive((s) => s.settings);
  const snapshot = useLive((s) => s.snapshot);
  const segments = useLive((s) => s.segments);
  const answers = useLive((s) => s.answers);
  const currentId = useLive((s) => s.currentAnswerId);
  const levels = useLive((s) => s.levels);
  const engine = useLive((s) => s.engine);
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [consent, setConsent] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => {
    void invoke('knowledge:list').then(setDocs);
  }, [settings]);

  if (!settings) return null;
  const ready = !!engine?.ready;
  const state = snapshot?.session ?? 'idle';
  const active = state === 'listening' || state === 'paused';
  const answer = currentId ? answers[currentId] : undefined;
  const src = (s: 'mic' | 'system' | 'app') => snapshot?.sources.find((x) => x.source === s);
  const sys = src('system') ?? src('app');
  const mic = src('mic');
  const checks = [{ ok: docs.length > 0, title: 'Add your résumé', desc: 'So answers about you use your real experience.', page: 'prep' }];
  const pending = checks.filter((c) => !c.ok);

  return (
    <>
      <PageHeader
        light="Your"
        bold="meetings"
        sub="Listen, transcribe and answer, all on this PC."
        right={
          <span className="dash-status-pill">
            <span className={cx('dot', state === 'listening' && 'is-live', state === 'paused' && 'is-paused')} />
            {state === 'listening' ? 'Listening' : state === 'paused' ? 'Paused' : 'Not listening'}
          </span>
        }
      />
      {!ready ? (
        <Card>
          <h2 className="dash-section-title">Set up Doing</h2>
          <p className="dash-section-sub">A one-time download. After that, everything runs offline.</p>
          <EngineSetup />
        </Card>
      ) : null}
      <div className="dash-cols">
        <Card>
          <h2 className="dash-section-title">Session</h2>
          <p className="dash-section-sub">Answers appear here and in the overlay. <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>O</kbd> answers whatever is on your screen.</p>
          <div className="dash-start">
            {!active ? (
              <Button variant="primary" icon={<Mic size={17} />} disabled={!ready} onClick={() => setConsent(true)}>{ready ? 'Start listening' : 'Finish setup to start'}</Button>
            ) : (
              <>
                <Button variant="primary" icon={state === 'paused' ? <Play size={16} /> : <Pause size={16} />} onClick={() => void invoke(state === 'paused' ? 'session:resume' : 'session:pause')}>{state === 'paused' ? 'Resume' : 'Pause'}</Button>
                <Button variant="danger" icon={<Square size={14} />} onClick={() => void invoke('session:stop')}>Stop</Button>
              </>
            )}
            <Button icon={<Eye size={16} />} onClick={() => void invoke('overlay:toggle')}>Overlay</Button>
            <span className="dash-start__note"><kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Space</kbd> toggles it</span>
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
              <div className="dash-tile__row"><span className="dash-tile__icon"><Waves size={17} /></span><span className="dash-tile__state">{!ready ? 'Not set up' : sys?.sttState === 'open' || mic?.sttState === 'open' ? 'Streaming' : engine?.running.speech ? 'Running' : 'Ready'}</span></div>
              <span className="dash-tile__label">Speech recognition</span>
              <span className="dash-tile__value">{engine?.speechModel ?? '…'}{engine ? ` · ${engine.tier === 'gpu' ? 'GPU' : 'CPU'}` : ''}</span>
            </button>
            <button type="button" className="dash-tile t-peach" onClick={() => go('settings')}>
              <div className="dash-tile__row"><span className="dash-tile__icon"><Sparkles size={17} /></span><span className="dash-tile__state">{!ready ? 'Not set up' : engine?.running.answers ? 'Running' : 'Ready'}</span></div>
              <span className="dash-tile__label">Answer model</span>
              <span className="dash-tile__value">{engine?.answerModel ?? '…'} · on this PC</span>
            </button>
            <button type="button" className="dash-tile t-blush" onClick={() => go('prep')}>
              <div className="dash-tile__row"><span className="dash-tile__icon"><BookOpen size={17} /></span><span className="dash-tile__state">{docs.length ? 'Indexed' : 'Empty'}</span></div>
              <span className="dash-tile__label">Documents</span>
              <span className="dash-tile__value">{docs.length} document{docs.length === 1 ? '' : 's'}</span>
            </button>
            <button type="button" className="dash-tile t-sand" onClick={() => go('prep')}>
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
            {segments.length === 0 ? <span className="dash-small">The transcript appears here when you start listening.</span> : segments.slice(-30).map((s) => <TranscriptLine key={s.id} seg={s} />)}
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
            <input placeholder="Ask anything, or press Enter to answer the last question" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Type a question" />
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
