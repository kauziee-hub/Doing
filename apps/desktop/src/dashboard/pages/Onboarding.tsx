import { useState } from 'react';
import { ArrowRight, Check, Lock, FolderOpen, Globe, Mic } from 'lucide-react';
import { Button, cx } from '@doing/ui';
import { useLive } from '../../shared/store';
import { EngineSetup } from '../EngineSetup';
import { Wordmark } from '../../shared/Logo';
import { usePatch } from './Settings';
const STEPS = ['Welcome', 'Set up', 'Ready'] as const;
export function Onboarding({ onClose, go }: { onClose: () => void; go: (p: string) => void }) {
  const engine = useLive((s) => s.engine);
  const patch = usePatch();
  const [step, setStep] = useState(0);
  const finish = async () => {
    await patch({ onboardingComplete: true });
    onClose();
  };
  return (
    <div className="dash-modal" role="dialog" aria-modal="true" aria-labelledby="ob-title">
      <div className="dash-modal__box">
        <div style={{ marginBottom: 24 }}>
          <Wordmark height={30} />
        </div>
        <h2 id="ob-title">{STEPS[step]}</h2>
        <div className="dash-steps" aria-hidden="true">
          {STEPS.map((s, i) => (
            <span key={s} className={cx('dash-step', i <= step && 'is-done')} />
          ))}
        </div>
        {step === 0 && (
          <>
            <p>Your private assistant, working on your PC.</p>
            <div className="ob-points">
              <div>
                <FolderOpen size={18} />
                <span>
                  <strong>Get things done.</strong> Chat, draft and work with files you allow.
                </span>
              </div>
              <div>
                <Globe size={18} />
                <span>
                  <strong>Work in Chrome.</strong> Ask about pages, fill forms and type code.
                </span>
              </div>
              <div>
                <Mic size={18} />
                <span>
                  <strong>Keep up with meetings.</strong> Transcripts, answers and action items.
                </span>
              </div>
              <div>
                <Lock size={18} />
                <span>
                  <strong>Local AI.</strong> No account, API keys or subscription.
                </span>
              </div>
            </div>
            <p className="dash-small">Nothing records or operates a tab before you allow it. Website submissions go to that website.</p>
          </>
        )}
        {step === 1 && (
          <>
            <p className="dash-small">A one-time download. Doing chooses the right models for this PC.</p>
            <EngineSetup onReady={() => setStep(2)} />
          </>
        )}
        {step === 2 && (
          <>
            <p>
              <Check size={16} />
              {engine?.ready ? ' Your local engine is ready.' : ' You can finish engine setup later in Settings.'}
            </p>
            <div className="doing-suggestions">
              {[
                ['assistant', 'Start a conversation'],
                ['browser', 'Connect Chrome'],
                ['home', 'Open Meetings'],
                ['prep', 'Add documents'],
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    void finish().then(() => go(id!));
                  }}
                >
                  {label}
                  <ArrowRight size={14} />
                </button>
              ))}
            </div>
          </>
        )}
        <div className="vc-row" style={{ justifyContent: 'space-between', marginTop: 24 }}>
          <Button variant="ghost" onClick={() => void finish()}>
            {engine?.setup === 'running' ? 'Close — setup continues' : 'Skip'}
          </Button>
          <div className="vc-row">
            {step > 0 && <Button onClick={() => setStep(step - 1)}>Back</Button>}
            {step < 2 ? (
              <Button variant="primary" icon={<ArrowRight size={14} />} onClick={() => setStep(step + 1)}>
                {step === 1 && !engine?.ready ? 'Later' : 'Next'}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void finish()}>
                Start using Doing
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
