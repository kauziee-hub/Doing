import { useState } from 'react';
import { ArrowRight, Check, FileText, Lock, Mic, MonitorUp, Zap } from 'lucide-react';
import { Button, cx } from '@hirora/ui';
import { invoke } from '../../shared/api';
import { useLive } from '../../shared/store';
import { EngineSetup } from '../EngineSetup';
import { usePatch } from './Settings';

const STEPS = ['Welcome', 'Set up', 'Your résumé', 'You’re ready'] as const;

export function Onboarding({ onClose, go }: { onClose: () => void; go: (p: string) => void }) {
  const settings = useLive((s) => s.settings);
  const engine = useLive((s) => s.engine);
  const toast = useLive((s) => s.toast);
  const patch = usePatch();
  const [step, setStep] = useState(0);
  const [added, setAdded] = useState<string[]>([]);

  const finish = async () => {
    await patch({ onboardingComplete: true });
    onClose();
  };
  if (!settings) return null;
  const settingUp = engine?.setup === 'running';

  return (
    <div className="dash-modal" role="dialog" aria-modal="true" aria-labelledby="ob-title">
      <div className="dash-modal__box">
        <h2 id="ob-title">{STEPS[step]}</h2>
        <div className="dash-steps" aria-hidden="true">{STEPS.map((s, i) => <span key={s} className={cx('dash-step', i <= step && 'is-done')} />)}</div>

        {step === 0 ? (
          <>
            <p>Hirora listens to the call you approve, writes down the question as it is asked, and shows you a short answer grounded in your own résumé, in a floating overlay only you can see.</p>
            <div className="ob-points">
              <div><Zap size={16} /><span><strong>Fast.</strong> Answers usually start within half a second of the question ending.</span></div>
              <div><Lock size={16} /><span><strong>Private.</strong> Everything runs on this PC. No account, no keys, nothing you say is sent anywhere.</span></div>
              <div><MonitorUp size={16} /><span><strong>Sees what's shared.</strong> When someone shows code or a slide and asks about it, Hirora looks at your screen too.</span></div>
              <div><Mic size={16} /><span><strong>Only when you say so.</strong> Nothing is captured until you press Start and confirm. Audio and screen captures are never saved.</span></div>
            </div>
            <p className="dash-small">Use it for practice and for calls where it is allowed. Respect the rules of any interview or assessment, and other people’s consent.</p>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <p className="dash-small" style={{ marginTop: 0 }}>Hirora installs its speech recognition and answer model once. It picks the right size for this PC and checks every download.</p>
            <EngineSetup onReady={() => setStep(2)} />
          </>
        ) : null}

        {step === 2 ? (
          <>
            <p>Add your résumé so answers about <em>you</em> use your real experience. If something isn’t in it, Hirora says so instead of making it up.</p>
            <div className="vc-row">
              <Button
                variant="primary"
                icon={<FileText size={14} />}
                onClick={async () => {
                  const r = await invoke('knowledge:pickFiles', { kind: 'resume' });
                  const ok = r.filter((x) => x.ok).map((x) => x.fileName);
                  setAdded((a) => [...a, ...ok]);
                  for (const x of r.filter((y) => !y.ok)) toast('error', `${x.fileName}: ${x.error}`);
                }}
              >
                Add résumé (PDF, Word or text)
              </Button>
              <Button onClick={async () => { await invoke('knowledge:pickFiles', { kind: 'project' }); }}>Add project notes</Button>
            </div>
            {added.length ? <p className="dash-small"><Check size={13} color="var(--ok)" /> Added: {added.join(', ')}</p> : null}
            <p className="dash-small">You can add or replace documents later in Knowledge, or <button type="button" className="ob-link" onClick={() => { void finish(); go('profiles'); }}>fill in a profile</button> instead.</p>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <p><Check size={16} color="var(--ok)" /> {engine?.ready ? 'Hirora is ready.' : 'Setup is still running. You can close this window; it carries on in the background.'} Shortcuts that work anywhere:</p>
            <table className="dash-table">
              <tbody>
                <tr><td>Show / hide overlay</td><td className="dash-mono">{settings.hotkeys.toggleOverlay}</td></tr>
                <tr><td>Start / stop listening</td><td className="dash-mono">{settings.hotkeys.toggleListening}</td></tr>
                <tr><td>Answer the latest question</td><td className="dash-mono">{settings.hotkeys.askNow}</td></tr>
                <tr><td>Type a question</td><td className="dash-mono">{settings.hotkeys.focusAsk}</td></tr>
                <tr><td>Cancel answer</td><td className="dash-mono">{settings.hotkeys.cancelAnswer}</td></tr>
              </tbody>
            </table>
            <p className="dash-small">The overlay is left out of screen shares and screenshots on Windows (best-effort; check the rules of your call).</p>
          </>
        ) : null}

        <div className="vc-row" style={{ justifyContent: 'space-between', marginTop: 16 }}>
          <Button variant="ghost" onClick={() => void finish()}>{step === 1 && settingUp ? 'Close (setup continues)' : 'Skip'}</Button>
          <div className="vc-row">
            {step > 0 ? <Button onClick={() => setStep(step - 1)}>Back</Button> : null}
            {step < STEPS.length - 1 ? (
              <Button variant="primary" icon={<ArrowRight size={14} />} onClick={() => setStep(step + 1)}>{step === 1 && !engine?.ready ? 'Later' : 'Next'}</Button>
            ) : (
              <Button variant="primary" onClick={() => void finish()}>Start using Hirora</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
