import { useState } from 'react';
import { ArrowUp, Eye, Mic, Pause, Play, Square } from 'lucide-react';
import { Button, Card, LevelMeter, cx } from '@doing/ui';
import { invoke } from '../../shared/api';
import { useLive } from '../../shared/store';
import { AnswerView, ConsentModal, TranscriptLine } from '../../overlay/Overlay';
import { PageHeader } from '../App';
import { EngineSetup } from '../EngineSetup';

export function Home({ go }: { go: (page: string) => void }) {
  const engine = useLive((s) => s.engine);
  const settings = useLive((s) => s.settings);
  const snapshot = useLive((s) => s.snapshot);
  const segments = useLive((s) => s.segments);
  const answers = useLive((s) => s.answers);
  const currentId = useLive((s) => s.currentAnswerId);
  const levels = useLive((s) => s.levels);
  const [consent, setConsent] = useState(false);
  const [q, setQ] = useState('');
  const ready = !!engine?.ready;
  const state = snapshot?.session ?? 'idle';
  const active = state === 'listening' || state === 'paused';
  const answer = currentId ? answers[currentId] : undefined;
  return (
    <>
      <PageHeader
        bold="Meetings"
        sub="Live transcription, useful answers and clear next steps."
        right={
          <span className="dash-status-pill">
            <span className={cx('dot', state === 'listening' && 'is-live')} />
            {state === 'listening' ? 'Listening' : state === 'paused' ? 'Paused' : 'Not listening'}
          </span>
        }
      />
      {!ready && (
        <Card title="Set up Doing">
          <EngineSetup />
        </Card>
      )}
      <Card>
        <div className="doing-meeting-controls">
          <div className="vc-row">
            {!active ? (
              <Button variant="primary" icon={<Mic size={16} />} disabled={!ready} onClick={() => setConsent(true)}>
                Start listening
              </Button>
            ) : (
              <>
                <Button
                  variant="primary"
                  icon={state === 'paused' ? <Play size={14} /> : <Pause size={14} />}
                  onClick={() => void invoke(state === 'paused' ? 'session:resume' : 'session:pause')}
                >
                  {state === 'paused' ? 'Resume' : 'Pause'}
                </Button>
                <Button icon={<Square size={13} />} onClick={() => void invoke('session:stop')}>
                  Stop
                </Button>
              </>
            )}
            <Button icon={<Eye size={15} />} onClick={() => void invoke('overlay:toggle')}>
              Overlay
            </Button>
          </div>
          <button type="button" className="dash-link" onClick={() => go('audio')}>
            Audio settings
          </button>
        </div>
        <div className="doing-levels">
          <div>
            <span>Microphone</span>
            <LevelMeter db={levels.mic ?? -100} label="Microphone level" />
          </div>
          <div>
            <span>Call audio</span>
            <LevelMeter db={levels.system ?? levels.app ?? -100} label="Call audio level" />
          </div>
        </div>
        {snapshot?.sources.some((s) => s.sttError) && (
          <p className="ov-error">
            {snapshot.sources
              .filter((s) => s.sttError)
              .map((s) => s.sttError)
              .join(' · ')}
          </p>
        )}
      </Card>
      <div className="dash-cols doing-meeting-content">
        <Card
          title="Transcript"
          actions={
            segments.length ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void invoke('session:clearTranscript').then(() => useLive.setState({ segments: [] }))}
              >
                Clear
              </Button>
            ) : undefined
          }
        >
          <div className="doing-transcript" aria-label="Transcript">
            {segments.length ? (
              segments.slice(-100).map((s) => <TranscriptLine key={s.id} seg={s} />)
            ) : (
              <div className="doing-empty">
                <Mic size={25} />
                <p>Start listening when everyone has agreed.</p>
                <span>Your transcript appears here.</span>
              </div>
            )}
          </div>
          <p className="doing-caption">Audio stays in memory. Save transcripts in History when you choose.</p>
        </Card>
        <Card title="Ask your meeting">
          <form
            className="dash-ask"
            onSubmit={(e) => {
              e.preventDefault();
              if (q.trim()) {
                void invoke('ask:text', { text: q.trim() });
                setQ('');
              } else void invoke('ask:latest');
            }}
          >
            <input aria-label="Type a question" placeholder="What did we decide?" value={q} onChange={(e) => setQ(e.target.value)} />
            <Button variant="primary" type="submit" aria-label="Ask" icon={<ArrowUp size={15} />}>
              Ask
            </Button>
          </form>
          <div className="doing-meeting-answer">
            {answer ? (
              <AnswerView a={answer} compact={false} />
            ) : (
              <div className="doing-empty">
                <p>Questions, summaries, decisions.</p>
                <span>Ask anything about the conversation.</span>
              </div>
            )}
          </div>
          <p className="doing-caption">
            <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>O</kbd> answers from your screen. Add context in{' '}
            <button type="button" className="dash-link" onClick={() => go('prep')}>
              Library
            </button>
            .
          </p>
        </Card>
      </div>
      {consent && settings && (
        <div className="dash-modal">
          <div
            style={{
              position: 'relative',
              width: 'min(520px,100%)',
              minHeight: 300,
            }}
          >
            <ConsentModal onCancel={() => setConsent(false)} />
          </div>
        </div>
      )}
    </>
  );
}
