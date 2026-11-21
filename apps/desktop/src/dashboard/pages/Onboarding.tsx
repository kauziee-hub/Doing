import { useEffect, useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import type { DeviceInfo, SecretsStatus } from '@hirora/contracts';
import { MODES, MODE_LABELS } from '@hirora/contracts';
import { Button, Field, cx } from '@hirora/ui';
import { invoke } from '../../shared/api';
import { useLive } from '../../shared/store';
import { ProviderCard, usePatch } from './Settings';

const STEPS = ['Welcome', 'Provider key', 'Audio', 'Your materials', 'Ready'] as const;

export function Onboarding({ onClose, go }: { onClose: () => void; go: (p: string) => void }) {
  const settings = useLive((s) => s.settings);
  const patch = usePatch();
  const [step, setStep] = useState(0);
  const [secrets, setSecrets] = useState<SecretsStatus | null>(null);
  const [devices, setDevices] = useState<{ capture: DeviceInfo[]; render: DeviceInfo[]; error: string | null } | null>(null);

  useEffect(() => {
    void invoke('secrets:status').then(setSecrets);
  }, []);
  useEffect(() => {
    if (step === 2 && !devices) void invoke('audio:devices').then(setDevices);
  }, [step, devices]);

  const finish = async () => {
    await patch({ onboardingComplete: true });
    onClose();
  };
  if (!settings) return null;

  return (
    <div className="dash-modal" role="dialog" aria-modal="true" aria-labelledby="ob-title">
      <div className="dash-modal__box">
        <h2 id="ob-title">{STEPS[step]}</h2>
        <div className="dash-steps" aria-hidden="true">{STEPS.map((s, i) => <span key={s} className={cx('dash-step', i <= step && 'is-done')} />)}</div>

        {step === 0 ? (
          <>
            <p>Hirora listens to audio you approve, transcribes it live, and streams short answers grounded in your own documents into a floating overlay.</p>
            <ul className="dash-small">
              <li>Bring your own keys (Gemini, xAI Grok, DeepSeek). Keys are encrypted with Windows DPAPI and never shown again.</li>
              <li>Nothing is captured until you press Start and confirm consent. Raw audio is never saved.</li>
              <li>Use it for practice, authorised meetings and coding help — respect interview/assessment rules and other people’s consent.</li>
            </ul>
            <Field label="What will you use Hirora for first?">
              <select className="vc-select" value={settings.answer.mode} onChange={(e) => void patch({ answer: { mode: e.target.value } })}>
                {MODES.map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
              </select>
            </Field>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <p className="dash-small">Easiest: paste the Hirora Cloud access code you were given — transcription and answers then work on any PC, free, with no GPU. Prefer your own account? Add a Gemini or xAI key instead (both can also transcribe). Have a GPU? Answers can run on this PC with Ollama (Settings → Providers). You can skip and explore first.</p>
            {(['cloud', 'gemini', 'xai', 'deepseek'] as const).map((p) => <ProviderCard key={p} id={p} secrets={secrets} onSecrets={setSecrets} />)}
          </>
        ) : null}

        {step === 2 ? (
          <>
            <p className="dash-small">Hirora captures your microphone and, separately, what plays through your speakers (WASAPI loopback) using a small native helper.</p>
            {devices?.error ? <div className="ov-error">{devices.error}</div> : null}
            <Field label="Microphone">
              <select className="vc-select" value={settings.audio.micDeviceId ?? ''} onChange={(e) => void patch({ audio: { micDeviceId: e.target.value || null } })}>
                <option value="">Windows default</option>
                {devices?.capture.map((d) => <option key={d.id} value={d.id}>{d.name}{d.isDefault ? ' (default)' : ''}</option>)}
              </select>
            </Field>
            <Field label="System audio from">
              <select className="vc-select" value={settings.audio.systemDeviceId ?? ''} onChange={(e) => void patch({ audio: { systemDeviceId: e.target.value || null } })}>
                <option value="">Windows default output</option>
                {devices?.render.map((d) => <option key={d.id} value={d.id}>{d.name}{d.isDefault ? ' (default)' : ''}</option>)}
              </select>
            </Field>
            <p className="dash-small">More options (gain, per-app capture, device tests) are in Settings → Audio.</p>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <p>Upload your resume and project notes so answers about <em>you</em> use your real experience. Missing facts are flagged instead of invented.</p>
            <div className="vc-row">
              <Button variant="primary" onClick={async () => { await invoke('knowledge:pickFiles', { kind: 'resume' }); }}>Add resume / CV</Button>
              <Button onClick={async () => { await invoke('knowledge:pickFiles', { kind: 'project' }); }}>Add project notes</Button>
              <Button variant="ghost" onClick={() => { void finish(); go('profiles'); }}>Fill in my profile instead</Button>
            </div>
          </>
        ) : null}

        {step === 4 ? (
          <>
            <p><Check size={16} color="var(--ok)" /> You are set up. Key shortcuts:</p>
            <table className="dash-table">
              <tbody>
                <tr><td>Show / hide overlay</td><td className="dash-mono">{settings.hotkeys.toggleOverlay}</td></tr>
                <tr><td>Start / stop listening</td><td className="dash-mono">{settings.hotkeys.toggleListening}</td></tr>
                <tr><td>Answer the latest question</td><td className="dash-mono">{settings.hotkeys.askNow}</td></tr>
                <tr><td>Type a question</td><td className="dash-mono">{settings.hotkeys.focusAsk}</td></tr>
                <tr><td>Cancel answer</td><td className="dash-mono">{settings.hotkeys.cancelAnswer}</td></tr>
              </tbody>
            </table>
          </>
        ) : null}

        <div className="vc-row" style={{ justifyContent: 'space-between', marginTop: 16 }}>
          <Button variant="ghost" onClick={() => void finish()}>Skip setup</Button>
          <div className="vc-row">
            {step > 0 ? <Button onClick={() => setStep(step - 1)}>Back</Button> : null}
            {step < STEPS.length - 1 ? (
              <Button variant="primary" icon={<ArrowRight size={14} />} onClick={() => setStep(step + 1)}>Next</Button>
            ) : (
              <Button variant="primary" onClick={() => void finish()}>Finish</Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
