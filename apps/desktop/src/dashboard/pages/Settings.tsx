import { useCallback, useEffect, useState } from 'react';
import { Monitor, Moon, RefreshCw, Sun, Trash2, Volume2 } from 'lucide-react';
import type { AudioAppInfo, CaptureCheckResult, DeviceInfo, HotkeyAction } from '@hirora/contracts';
import { DEFAULT_HOTKEYS, HOTKEY_LABELS } from '@hirora/contracts';
import { Button, Card, Field, LevelMeter, Toggle, cx } from '@hirora/ui';
import { invoke } from '../../shared/api';
import { PageHeader } from '../App';
import { useLive } from '../../shared/store';
import { EngineSetup } from '../EngineSetup';

const TABS = ['Engine', 'Audio', 'Answers', 'Overlay & capture', 'Hotkeys', 'Privacy & data'] as const;
type Tab = (typeof TABS)[number];

export function usePatch() {
  const setSettings = useLive((s) => s.setSettings);
  const toast = useLive((s) => s.toast);
  return useCallback(
    async (patch: Record<string, unknown>) => {
      try {
        setSettings(await invoke('settings:update', patch));
      } catch (e) {
        toast('error', (e as Error).message);
      }
    },
    [setSettings, toast],
  );
}

function EngineTab() {
  const s = useLive((x) => x.settings)!;
  const engine = useLive((x) => x.engine);
  const patch = usePatch();
  return (
    <>
      <Card title="On this PC">
        <p className="dash-small" style={{ marginTop: 0 }}>Speech recognition (whisper.cpp) and the answer model (Ollama runtime) run only on this computer, on 127.0.0.1. No account or key is involved and nothing you say is sent anywhere.</p>
        <EngineSetup />
      </Card>
      <Card title="Hardware">
        <Field label="Run the engine on" hint="Automatic uses the graphics card when it is an NVIDIA GPU with at least 6 GB, otherwise the processor. Switching downloads the matching models.">
          <select className="vc-select" value={s.engine.tier} disabled={engine?.setup === 'running'} onChange={(e) => void patch({ engine: { tier: e.target.value } })}>
            <option value="auto">Automatic (recommended)</option>
            <option value="gpu">NVIDIA graphics card — large Whisper + Qwen 3.5 4B</option>
            <option value="cpu">Processor only — small Whisper + Qwen 3 1.7B (slower, no screenshots)</option>
          </select>
        </Field>
      </Card>
      <Card title="Transcription">
        <div className="vc-grid2">
          <Field label="Spoken language" hint="Two-letter code such as en or hi. Empty = detect automatically (slightly slower).">
            <input className="vc-input" value={s.stt.language} onChange={(e) => void patch({ stt: { language: e.target.value.trim() } })} />
          </Field>
        </div>
        <Field label="Custom vocabulary" hint="Names, products, acronyms Whisper should expect (one per line, up to 100). Skills and the company from your profile are added automatically.">
          <textarea className="vc-textarea" defaultValue={s.stt.customVocabulary.join('\n')} onBlur={(e) => void patch({ stt: { customVocabulary: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 100) } })} />
        </Field>
        <Field label="Where the conversation is" hint="On a call, the other side comes through system audio and your microphone is you. In a room, one microphone hears everyone, so every question it hears can be answered.">
          <select className="vc-select" value={s.stt.captureMode} onChange={(e) => void patch({ stt: { captureMode: e.target.value } })}>
            <option value="two-stream">On a call (system audio is the other side)</option>
            <option value="single-mic">In a room (one microphone for everyone)</option>
          </select>
        </Field>
      </Card>
    </>
  );
}

function AudioTab() {
  const s = useLive((x) => x.settings)!;
  const levels = useLive((x) => x.levels);
  const patch = usePatch();
  const [devices, setDevices] = useState<{ capture: DeviceInfo[]; render: DeviceInfo[]; error: string | null } | null>(null);
  const [apps, setApps] = useState<AudioAppInfo[]>([]);
  const [testRes, setTestRes] = useState<string | null>(null);
  const load = async () => {
    setDevices(await invoke('audio:devices'));
    setApps((await invoke('audio:apps')).apps);
  };
  useEffect(() => {
    void load();
  }, []);
  const test = async (source: 'mic' | 'system') => {
    setTestRes(`Testing ${source} for 3 s… ${source === 'system' ? 'Play some audio now.' : 'Say something.'} Nothing is sent anywhere.`);
    const r = await invoke('audio:testDevice', { source, seconds: 3 });
    setTestRes(r.ok ? `${source}: received ${r.frames} frames, peak ${r.peakDbfs} dBFS${r.peakDbfs < -55 ? ' (very quiet — check the device or volume)' : ''}.` : `${source}: ${r.error}`);
  };
  return (
    <>
      <Card title="Devices" actions={<Button size="sm" icon={<RefreshCw size={12} />} onClick={() => void load()}>Refresh</Button>}>
        {devices?.error ? <div className="ov-error">{devices.error}</div> : null}
        <Toggle checked={s.audio.micEnabled} label="Capture microphone" description="Your own voice (labelled “Mic”)." onChange={(v) => void patch({ audio: { micEnabled: v } })} />
        <div className="vc-grid2">
          <Field label="Microphone">
            <select className="vc-select" value={s.audio.micDeviceId ?? ''} onChange={(e) => void patch({ audio: { micDeviceId: e.target.value || null } })}>
              <option value="">Windows default{devices?.capture.find((d) => d.isDefault) ? ` (${devices.capture.find((d) => d.isDefault)!.name})` : ''}</option>
              {devices?.capture.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          <Field label={`Mic gain (${s.audio.micGain.toFixed(1)}×)`}>
            <input type="range" min={0.2} max={4} step={0.1} value={s.audio.micGain} onChange={(e) => void patch({ audio: { micGain: Number(e.target.value) } })} />
          </Field>
        </div>
        <div className="vc-row"><Button size="sm" icon={<Volume2 size={12} />} onClick={() => void test('mic')}>Test microphone</Button><div style={{ width: 160 }}><LevelMeter db={levels.mic ?? -100} label="mic level" /></div></div>
        <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '14px 0' }} />
        <Toggle checked={s.audio.systemEnabled} label="Capture system audio (WASAPI loopback)" description="What plays through your speakers/headphones, e.g. the other meeting participants (labelled “System”)." onChange={(v) => void patch({ audio: { systemEnabled: v } })} />
        <div className="vc-grid2">
          <Field label="Output device to capture" hint="“All” hears the other side wherever the call app plays it, even when a Bluetooth headset switches to its hands-free mode.">
            <select className="vc-select" value={s.audio.systemDeviceId ?? ''} onChange={(e) => void patch({ audio: { systemDeviceId: e.target.value || null } })}>
              <option value="all">All speakers & headphones (recommended)</option>
              <option value="">Windows default only{devices?.render.find((d) => d.isDefault) ? ` (${devices.render.find((d) => d.isDefault)!.name})` : ''}</option>
              {devices?.render.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </Field>
          <Field label="Only one application (experimental)" hint="Per-process loopback (Windows 10 2004+). Pick an app currently playing audio.">
            <select
              className="vc-select"
              value={s.audio.appCapturePid ?? ''}
              onChange={(e) => {
                const pid = e.target.value ? Number(e.target.value) : null;
                const a = apps.find((x) => x.pid === pid);
                void patch({ audio: { appCapturePid: pid, appCaptureName: a ? a.displayName || a.exe : null } });
              }}
            >
              <option value="">Whole device (recommended)</option>
              {apps.map((a) => <option key={a.pid} value={a.pid}>{a.displayName || a.exe} (pid {a.pid})</option>)}
              {s.audio.appCapturePid && !apps.some((a) => a.pid === s.audio.appCapturePid) ? <option value={s.audio.appCapturePid}>{s.audio.appCaptureName} (not running)</option> : null}
            </select>
          </Field>
        </div>
        <div className="vc-row"><Button size="sm" icon={<Volume2 size={12} />} onClick={() => void test('system')}>Test system audio</Button><div style={{ width: 160 }}><LevelMeter db={levels.system ?? -100} label="system level" /></div></div>
        {testRes ? <div className="dash-small" style={{ marginTop: 8 }}>{testRes}</div> : null}
      </Card>
      <Card title="Noise handling">
        <Field label={`Noise gate: ${s.audio.noiseGateDbfs <= -89 ? 'off (stream everything)' : `${s.audio.noiseGateDbfs} dBFS`}`} hint="Sound below this level is ignored (an adaptive voice detector with 300 ms pre-roll opens the gate). Lower = more sensitive; leftmost = off.">
          <input type="range" min={-90} max={-30} step={1} value={s.audio.noiseGateDbfs} onChange={(e) => void patch({ audio: { noiseGateDbfs: Number(e.target.value) } })} />
        </Field>
        <p className="dash-small" style={{ margin: 0 }}>Device changes (headset plugged in, Bluetooth reconnect, new default device) are picked up automatically within about a second. Capture pauses on sleep; resume from the overlay.</p>
      </Card>
    </>
  );
}

function AnswersTab() {
  const s = useLive((x) => x.settings)!;
  const engine = useLive((x) => x.engine);
  const patch = usePatch();
  const a = s.answer;
  return (
    <>
      <Card title="Answers">
        <p className="dash-small" style={{ marginTop: 0 }}>One assistant handles everything: questions about you, code, concepts, summaries. It works out what each question needs.</p>
        <div className="vc-grid2">
          <Field label="Answer length">
            <select className="vc-select" value={a.length} onChange={(e) => void patch({ answer: { length: e.target.value } })}><option value="short">Short</option><option value="medium">Medium</option><option value="long">Long</option></select>
          </Field>
          <Field label="Answer language"><input className="vc-input" value={a.language} onChange={(e) => void patch({ answer: { language: e.target.value } })} /></Field>
          <Field label="Tone"><input className="vc-input" value={a.tone} onChange={(e) => void patch({ answer: { tone: e.target.value } })} /></Field>
        </div>
      </Card>
      <Card title="Your screen">
        <Field
          label="Look at the screen with a question"
          hint={engine?.tier === 'cpu' ? 'Needs the NVIDIA graphics-card setup: the processor model can’t read images.' : 'Captures the monitor you’re using, in memory only, and sends it to the answer model on this PC. Hirora’s own windows are left out.'}
        >
          <select className="vc-select" value={a.screen} disabled={engine?.tier === 'cpu'} onChange={(e) => void patch({ answer: { screen: e.target.value } })}>
            <option value="auto">When the question refers to it (recommended)</option>
            <option value="always">With every question (slower)</option>
            <option value="off">Never</option>
          </select>
        </Field>
      </Card>
      <Card title="Automatic answering">
        <Toggle checked={a.autoAnswer} label="Answer detected questions automatically" description="Otherwise press Ctrl+Shift+Enter (or the Answer button)." onChange={(v) => void patch({ answer: { autoAnswer: v } })} />
        <div className="dash-small">Hirora only knows which device audio came from, not who spoke. Choose which sources may trigger automatic answers:</div>
        {(['system', 'app', 'mic'] as const).map((src) => (
          <Toggle key={src} checked={a.autoAnswerSources.includes(src)} label={src === 'mic' ? 'Microphone' : src === 'system' ? 'System audio' : 'Selected application audio'} onChange={(v) => void patch({ answer: { autoAnswerSources: v ? [...new Set([...a.autoAnswerSources, src])] : a.autoAnswerSources.filter((x) => x !== src) } })} />
        ))}
      </Card>
      <Card title="Limits & timeouts">
        <div className="vc-grid2">
          <Field label="First-token timeout (ms)" hint="Then retry once."><input className="vc-input" type="number" value={a.firstTokenTimeoutMs} onChange={(e) => void patch({ answer: { firstTokenTimeoutMs: Number(e.target.value) } })} /></Field>
          <Field label="Total timeout (ms)"><input className="vc-input" type="number" value={a.totalTimeoutMs} onChange={(e) => void patch({ answer: { totalTimeoutMs: Number(e.target.value) } })} /></Field>
          <Field label="Max output tokens (fast)"><input className="vc-input" type="number" value={a.maxOutputTokens} onChange={(e) => void patch({ answer: { maxOutputTokens: Number(e.target.value) } })} /></Field>
          <Field label="Max output tokens (deep)"><input className="vc-input" type="number" value={a.deepMaxOutputTokens} onChange={(e) => void patch({ answer: { deepMaxOutputTokens: Number(e.target.value) } })} /></Field>
          <Field label={`Temperature (${a.temperature})`} hint="Some newer models ignore it."><input type="range" min={0} max={1.5} step={0.1} value={a.temperature} onChange={(e) => void patch({ answer: { temperature: Number(e.target.value) } })} /></Field>
          <Field label="Follow-up memory (turns)"><input className="vc-input" type="number" min={0} max={12} value={a.memoryTurns} onChange={(e) => void patch({ answer: { memoryTurns: Number(e.target.value) } })} /></Field>
        </div>
      </Card>
    </>
  );
}

function OverlayTab() {
  const s = useLive((x) => x.settings)!;
  const patch = usePatch();
  const [results, setResults] = useState<CaptureCheckResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState('');
  const [manual, setManual] = useState<'hidden' | 'visible' | 'not_verified'>('not_verified');
  useEffect(() => {
    void invoke('capture:results').then(setResults);
  }, []);
  const o = s.overlay;
  return (
    <>
      <Card title="Overlay">
        <Field label={`Opacity (${Math.round(o.opacity * 100)}%)`}><input type="range" min={0.35} max={1} step={0.01} value={o.opacity} onChange={(e) => void patch({ overlay: { opacity: Number(e.target.value) } })} /></Field>
        <Field label={`Text size (${Math.round(o.fontScale * 100)}%)`}><input type="range" min={0.75} max={1.8} step={0.05} value={o.fontScale} onChange={(e) => void patch({ overlay: { fontScale: Number(e.target.value) } })} /></Field>
        <Toggle checked={o.glass} label="Translucent glass" description="Tinted see-through panel so the meeting or app behind stays visible. Turn off for a solid, maximum-contrast panel." onChange={(v) => void patch({ overlay: { glass: v } })} />
        <Toggle checked={o.alwaysOnTop} label="Always on top" description="Floats above other windows, including full-screen meetings and presentations." onChange={(v) => void patch({ overlay: { alwaysOnTop: v } })} />
        <Toggle checked={o.showTranscript} label="Show live transcript in overlay" onChange={(v) => void patch({ overlay: { showTranscript: v } })} />
        <Toggle checked={o.compact} label="Compact mode" onChange={(v) => void patch({ overlay: { compact: v } })} />
        <Button size="sm" onClick={() => void invoke('settings:reset', { section: 'overlay' }).then(() => useLive.getState().refreshSettings())}>Reset position & size</Button>
      </Card>
      <Card title="Screen-capture privacy (best-effort)">
        <Toggle
          checked={o.contentProtection}
          label="Hide Hirora from screen sharing and screenshots"
          description="On by default. Covers the overlay and this main window. You still see them; Windows leaves them out of screen captures (SetWindowDisplayAffinity via Electron setContentProtection), so your own screenshots and recordings won't show it either. Not every capture method honours it (cameras, some remote-desktop and hardware capture never will). This is a privacy convenience — Hirora does not claim the overlay is undetectable and does not try to evade monitoring or proctoring software."
          onChange={(v) => void patch({ overlay: { contentProtection: v } })}
        />
        <div className="vc-row">
          <Button disabled={busy} onClick={async () => { setBusy(true); try { setResults(await invoke('capture:runCheck')); } finally { setBusy(false); } }}>{busy ? 'Checking…' : 'Run Capture Compatibility Check'}</Button>
          <span className="dash-small">Briefly paints the overlay magenta and samples it through two capture paths, with protection off (baseline) and on.</span>
        </div>
        {results.length ? (
          <table className="dash-table" style={{ marginTop: 12 }}>
            <thead><tr><th>Method</th><th>Result with protection on</th><th>Details</th><th>Tested</th></tr></thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.method + r.testedAt}>
                  <td><strong>{r.method}</strong><div className="dash-small">{r.description}</div></td>
                  <td className={r.result === 'hidden' ? 'dash-result-hidden' : r.result === 'visible' ? 'dash-result-visible' : 'dash-result-other'}>
                    {r.result === 'hidden' ? 'excluded from this capture' : r.result === 'visible' ? 'still captured' : r.result.replace('_', ' ')}
                  </td>
                  <td className="dash-small">{r.detail}</td>
                  <td className="dash-small">{new Date(r.testedAt).toLocaleString()}<br />{r.osRelease} · Electron {r.electron}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="dash-small">Status: <strong>not verified</strong> on this machine yet.</p>}
        <div className="vc-row" style={{ marginTop: 12 }}>
          <input className="vc-input" style={{ width: 220 }} placeholder="Tool tested manually (e.g. Teams 25.x)" value={tool} onChange={(e) => setTool(e.target.value)} />
          <select className="vc-select" style={{ width: 170 }} value={manual} onChange={(e) => setManual(e.target.value as typeof manual)}>
            <option value="hidden">Overlay not visible</option>
            <option value="visible">Overlay visible</option>
            <option value="not_verified">Not verified</option>
          </select>
          <Button size="sm" disabled={!tool.trim()} onClick={async () => { setResults(await invoke('capture:recordManual', { tool: tool.trim(), result: manual, notes: '' })); setTool(''); }}>Record manual result</Button>
        </div>
      </Card>
    </>
  );
}

function HotkeysTab() {
  const s = useLive((x) => x.settings)!;
  const patch = usePatch();
  return (
    <Card title="Global shortcuts" actions={<Button size="sm" onClick={() => void invoke('settings:reset', { section: 'hotkeys' }).then(() => useLive.getState().refreshSettings())}>Reset defaults</Button>}>
      <p className="dash-small">Electron accelerator syntax, e.g. <code>CommandOrControl+Shift+Space</code>. Shortcuts already used by another app cannot be registered (you will see a warning in the log).</p>
      <table className="dash-table">
        <tbody>
          {(Object.keys(DEFAULT_HOTKEYS) as HotkeyAction[]).map((k) => (
            <tr key={k}>
              <td>{HOTKEY_LABELS[k]}</td>
              <td><input className="vc-input dash-mono" defaultValue={s.hotkeys[k]} aria-label={HOTKEY_LABELS[k]} onBlur={(e) => { if (e.target.value !== s.hotkeys[k]) void patch({ hotkeys: { [k]: e.target.value.trim() } }); }} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function PrivacyTab() {
  const s = useLive((x) => x.settings)!;
  const patch = usePatch();
  const toast = useLive((x) => x.toast);
  const p = s.privacy;
  return (
    <>
      <Card title="Nothing leaves this computer">
        <ul className="dash-small" style={{ marginTop: 0 }}>
          <li>Audio: captured only after you press Start and confirm consent, transcribed on this PC, never written to disk.</li>
          <li>Answers: the question, a few passages from your documents, your profile summary (if allowed below) and the recent transcript go to the answer model on this PC.</li>
          <li>Clipboard and screenshots: used only after you preview and press Send. Possible secrets are flagged and can be redacted.</li>
          <li>The only internet use is the one-time engine download (GitHub, Hugging Face and the Ollama model library).</li>
        </ul>
        <Toggle checked={p.includeProfileInPrompts} label="Include personal profile summary in prompts" onChange={(v) => void patch({ privacy: { includeProfileInPrompts: v } })} />
        <Toggle checked={p.includeDocumentsInPrompts} label="Include retrieved document passages in prompts" onChange={(v) => void patch({ privacy: { includeDocumentsInPrompts: v } })} />
        <Toggle checked={p.redactSecrets} label="Flag possible secrets before sending clipboard text" onChange={(v) => void patch({ privacy: { redactSecrets: v } })} />
      </Card>
      <Card title="History & data">
        <Toggle checked={p.saveHistory} label="Save session history (opt-in)" onChange={(v) => void patch({ privacy: { saveHistory: v } })} />
        <Field label="Keep history for (days)"><input className="vc-input" type="number" min={1} max={3650} value={p.historyRetentionDays} onChange={(e) => void patch({ privacy: { historyRetentionDays: Number(e.target.value) } })} /></Field>
        <div className="vc-row">
          <Button onClick={() => void invoke('app:openDataFolder')}>Open data folder</Button>
          <Button
            variant="danger"
            icon={<Trash2 size={13} />}
            onClick={async () => {
              const typed = prompt('This deletes ALL Hirora data on this computer: documents, profiles, history, timings and settings (the downloaded engine stays). Type DELETE to confirm.');
              if (typed === 'DELETE') {
                await invoke('data:deleteAll', { confirm: 'DELETE' });
                await useLive.getState().refreshSettings();
                toast('info', 'All Hirora data deleted.');
              }
            }}
          >
            Delete all data
          </Button>
        </div>
      </Card>
    </>
  );
}

function ThemeSwitch() {
  const theme = useLive((s) => s.settings?.appearance.theme ?? 'system');
  const patch = usePatch();
  const opts: Array<{ id: 'system' | 'light' | 'dark'; label: string; icon: typeof Sun }> = [
    { id: 'system', label: 'System', icon: Monitor },
    { id: 'light', label: 'Light', icon: Sun },
    { id: 'dark', label: 'Dark', icon: Moon },
  ];
  return (
    <div className="dash-theme-switch" role="radiogroup" aria-label="Theme">
      {opts.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={theme === o.id} className={cx(theme === o.id && 'is-active')} onClick={() => void patch({ appearance: { theme: o.id } })}>
          <o.icon size={14} /> {o.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsPage() {
  const settings = useLive((s) => s.settings);
  const [tab, setTab] = useState<Tab>('Engine');
  if (!settings) return null;
  return (
    <>
      <PageHeader bold="Settings" sub="Changes save immediately." right={<ThemeSwitch />} />
      <div className="dash-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={cx('dash-tab', tab === t && 'is-active')} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {tab === 'Engine' && <EngineTab />}
      {tab === 'Audio' && <AudioTab />}
      {tab === 'Answers' && <AnswersTab />}
      {tab === 'Overlay & capture' && <OverlayTab />}
      {tab === 'Hotkeys' && <HotkeysTab />}
      {tab === 'Privacy & data' && <PrivacyTab />}
    </>
  );
}
