import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, KeyRound, Monitor, Moon, PlugZap, RefreshCw, ShieldCheck, Sun, Trash2, Volume2 } from 'lucide-react';
import type {
  AudioAppInfo,
  CaptureCheckResult,
  DeviceInfo,
  HotkeyAction,
  ModelInfo,
  ProviderHealth,
  ProviderId,
  ProviderTestResult,
  SecretsStatus,
} from '@hirora/contracts';
import { DEFAULT_HOTKEYS, HOTKEY_LABELS, MODES, MODE_LABELS, OLLAMA_DEFAULT_BASE_URL, PROVIDER_IDS, isKeyless, HIRORA_CLOUD_DEFAULT_BASE_URL } from '@hirora/contracts';
import { Badge, Button, Card, Field, LevelMeter, Toggle, cx } from '@hirora/ui';
import { invoke } from '../../shared/api';
import { PageHeader } from '../App';
import { useLive } from '../../shared/store';

const TABS = ['Providers', 'Transcription', 'Audio', 'Answers', 'Overlay & capture', 'Hotkeys', 'Privacy & data', 'Budget'] as const;
type Tab = (typeof TABS)[number];

const PROVIDER_META: Record<ProviderId, { label: string; console: string | null; sends: string }> = {
  cloud: { label: 'Hirora Cloud (free, no GPU needed)', console: null, sends: 'Answer prompts and (if selected for transcription) your speech go to the Hirora Cloud server, which forwards them to Groq to run open models and Whisper. Nothing is stored on the server.' },
  gemini: { label: 'Google Gemini', console: 'https://aistudio.google.com/apikey', sends: 'Answer prompts, approved screenshots and (if enabled) embedding text. Also powers Gemini 3.5 Transcribe Live audio transcription.' },
  xai: { label: 'xAI Grok', console: 'https://console.x.ai/', sends: 'Answer prompts and approved screenshots. Also powers xAI streaming transcription if selected.' },
  deepseek: { label: 'DeepSeek', console: 'https://platform.deepseek.com/api_keys', sends: 'Answer prompts (text). DeepSeek does not provide live audio transcription.' },
  ollama: { label: 'Ollama (runs on this PC)', console: 'https://ollama.com/download', sends: 'Nothing leaves this PC: answer prompts go to Ollama on 127.0.0.1. Live transcription still uses your Gemini or xAI key.' },
  custom: { label: 'Custom OpenAI-compatible', console: null, sends: 'Answer prompts to the endpoint you configure (https only; http allowed for localhost).' },
};

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

export function ProviderCard({ id, secrets, onSecrets }: { id: ProviderId; secrets: SecretsStatus | null; onSecrets: (s: SecretsStatus) => void }) {
  const settings = useLive((s) => s.settings)!;
  const patch = usePatch();
  const toast = useLive((s) => s.toast);
  const [key, setKey] = useState('');
  const [test, setTest] = useState<ProviderTestResult | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const ps = settings.providers[id];
  const local = isKeyless(id);
  // Local runtimes need no key: treat them as usable once their card is shown.
  const hasKey = local || (secrets?.providers[id].hasKey ?? false);
  const meta = PROVIDER_META[id];

  useEffect(() => {
    if (hasKey) void invoke('providers:models', { provider: id }).then((r) => setModels(r.models));
  }, [hasKey, id]);

  const runTest = async () => {
    setBusy(true);
    const r = await invoke('providers:test', { provider: id });
    setTest(r);
    if (r.ok) setModels(r.models);
    await useLive.getState().refreshSettings();
    setBusy(false);
  };

  return (
    <Card
      title={<>{meta.label} {local ? <Badge tone="ok">no key needed</Badge> : hasKey ? <Badge tone="ok">key saved</Badge> : <Badge>no key</Badge>} {ps.enabled && hasKey ? <Badge tone="info">enabled</Badge> : null}</>}
      actions={meta.console ? <Button size="sm" variant="ghost" icon={<ExternalLink size={12} />} onClick={() => void invoke('app:openExternal', { url: meta.console! })}>{local ? 'Get Ollama' : 'Get a key'}</Button> : null}
    >
      {id === 'custom' ? (
        <div className="vc-grid2">
          <Field label="Label"><input className="vc-input" value={settings.providers.custom.label} onChange={(e) => void patch({ providers: { custom: { label: e.target.value } } })} /></Field>
          <Field label="Base URL" hint="e.g. https://my-gateway.example.com/v1 — must implement /models and /chat/completions."><input className="vc-input" defaultValue={settings.providers.custom.baseUrl} onBlur={(e) => void patch({ providers: { custom: { baseUrl: e.target.value.trim() } } })} /></Field>
        </div>
      ) : null}
      {id === 'cloud' ? (
        <p className="dash-small" style={{ marginTop: 0 }}>
          A free shared server, always on, so Hirora works on any PC — no GPU, no paid key. Ask whoever runs your Hirora Cloud for the access code, paste it below and press Save. Limits are shared by everyone using the same server.
        </p>
      ) : null}
      {id === 'ollama' ? (
        <>
          <p className="dash-small" style={{ marginTop: 0 }}>
            Fastest and most private option on a PC with a GPU. Install Ollama, run <code>ollama pull qwen3.5:4b</code> (about 3.3 GB) in a terminal, then press Test. The model loads into memory when you start listening.
          </p>
          <div className="vc-grid2">
            <Field label="Ollama endpoint" hint={`Default ${OLLAMA_DEFAULT_BASE_URL}. Must be on this PC.`}><input className="vc-input" defaultValue={settings.providers.ollama.baseUrl} onBlur={(e) => void patch({ providers: { ollama: { baseUrl: e.target.value.trim() || OLLAMA_DEFAULT_BASE_URL } } })} /></Field>
          </div>
          <div className="dash-keyrow">
            <Button variant="primary" icon={<PlugZap size={13} />} disabled={busy} onClick={() => void runTest()}>{busy ? 'Testing…' : 'Test connection'}</Button>
          </div>
        </>
      ) : (
      <div className="dash-keyrow">
        <input
          className="vc-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={hasKey ? '•••••••• (saved — paste to replace)' : id === 'cloud' ? 'Paste the access code' : 'Paste API key'}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          aria-label={id === 'cloud' ? 'Hirora Cloud access code' : `${meta.label} API key`}
        />
        <Button
          variant="primary"
          icon={<KeyRound size={13} />}
          disabled={key.trim().length < 8}
          onClick={async () => {
            try {
              onSecrets(await invoke('secrets:set', { provider: id, key: key.trim() }));
              setKey('');
              toast('info', `${id === 'cloud' ? 'Access code' : `${meta.label} key`} saved (encrypted). Testing…`);
              await runTest();
            } catch (e) {
              toast('error', (e as Error).message);
            }
          }}
        >
          {id === 'cloud' ? 'Save code' : 'Save key'}
        </Button>
        <Button icon={<PlugZap size={13} />} disabled={!hasKey || busy} onClick={() => void runTest()}>{busy ? 'Testing…' : 'Test'}</Button>
      </div>
      )}
      {test ? (
        <div className={cx('dash-small')} style={{ marginTop: 8, color: test.ok ? 'var(--ok)' : 'var(--error)' }}>
          {test.ok
            ? local
              ? test.models.length
                ? `Ollama is running · ${test.models.length} local models pulled.`
                : 'Ollama is running but has no models yet. Run: ollama pull qwen3.5:4b'
              : id === 'cloud'
                ? `Connected to Hirora Cloud in ${test.latencyMs} ms · ${test.models.length} models.`
                : `Connected in ${test.latencyMs} ms · ${test.models.length} text models available to this key.`
            : local && test.errorCode === 'network'
              ? 'Ollama is not running. Start it from the Start menu (or run: ollama serve), then Test again.'
              : `${test.errorCode ?? 'error'}: ${test.error}`}
        </div>
      ) : null}
      {hasKey ? (
        <div className="vc-grid2" style={{ marginTop: 12 }}>
          <Field label="Fast model (first answers)" hint={models.length ? `${models.length} models from the live list` : 'Run Test to load the live model list'}>
            <select className="vc-select" value={ps.model} onChange={(e) => void patch({ providers: { [id]: { model: e.target.value, enabled: true } } })}>
              <option value="">(select)</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.id}{m.displayName && m.displayName !== m.id ? ` — ${m.displayName}` : ''}</option>)}
              {ps.model && !models.some((m) => m.id === ps.model) ? <option value={ps.model}>{ps.model} (saved)</option> : null}
            </select>
          </Field>
          <Field label="Deep model (Expand)" hint="Optional; defaults to the fast model.">
            <select className="vc-select" value={ps.deepModel} onChange={(e) => void patch({ providers: { [id]: { deepModel: e.target.value } } })}>
              <option value="">(same as fast)</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
            </select>
          </Field>
        </div>
      ) : null}
      {hasKey ? (
        <div className="vc-row">
          <Toggle checked={ps.enabled} label="Enabled for answers" onChange={(v) => void patch({ providers: { [id]: { enabled: v } } })} />
          {local ? null : <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={async () => { if (confirm(`Remove the saved ${meta.label} key?`)) { onSecrets(await invoke('secrets:delete', { provider: id })); await useLive.getState().refreshSettings(); setModels([]); setTest(null); } }}>Remove key</Button>}
        </div>
      ) : null}
      {id === 'cloud' ? (
        <details style={{ marginTop: 10 }}>
          <summary className="dash-small" style={{ cursor: 'pointer' }}>Server address</summary>
          <Field label="Hirora Cloud address" hint={`Default ${HIRORA_CLOUD_DEFAULT_BASE_URL}. Change it only if you run your own server.`}>
            <input className="vc-input" defaultValue={settings.providers.cloud.baseUrl} onBlur={(e) => void patch({ providers: { cloud: { baseUrl: e.target.value.trim() || HIRORA_CLOUD_DEFAULT_BASE_URL } } })} />
          </Field>
        </details>
      ) : null}
      <div className="dash-small" style={{ marginTop: 6 }}>Data sent: {meta.sends}</div>
    </Card>
  );
}

function ProvidersTab() {
  const settings = useLive((s) => s.settings)!;
  const patch = usePatch();
  const [secrets, setSecrets] = useState<SecretsStatus | null>(null);
  const [health, setHealth] = useState<ProviderHealth[]>([]);
  useEffect(() => {
    void invoke('secrets:status').then(setSecrets);
    void invoke('providers:health').then(setHealth);
  }, [settings]);
  const ready = PROVIDER_IDS.filter((p) => (isKeyless(p) || secrets?.providers[p].hasKey) && settings.providers[p].model);
  return (
    <>
      <Card title="Routing">
        <div className="vc-grid2">
          <Field label="Primary answer provider">
            <select className="vc-select" value={settings.answer.primaryProvider ?? ''} onChange={(e) => void patch({ answer: { primaryProvider: e.target.value || null } })}>
              <option value="">(none)</option>
              {PROVIDER_IDS.map((p) => <option key={p} value={p} disabled={!ready.includes(p)}>{PROVIDER_META[p].label}{ready.includes(p) ? '' : isKeyless(p) ? ' — needs a pulled model (Test it below)' : ' — needs key + model'}</option>)}
            </select>
          </Field>
          <Field label="Fallback provider" hint="Used visibly (badge “fallback”) only if the primary fails before streaming.">
            <select className="vc-select" value={settings.answer.fallbackProvider ?? ''} onChange={(e) => void patch({ answer: { fallbackProvider: e.target.value || null } })}>
              <option value="">(none)</option>
              {PROVIDER_IDS.filter((p) => p !== settings.answer.primaryProvider).map((p) => <option key={p} value={p} disabled={!ready.includes(p)}>{PROVIDER_META[p].label}</option>)}
            </select>
          </Field>
        </div>
        <div className="dash-pill-row">
          {health.map((h) => (
            <Badge key={h.provider} tone={h.status === 'ok' ? 'ok' : h.status === 'error' ? 'error' : h.status === 'backoff' ? 'warn' : 'neutral'} title={h.lastError ?? undefined}>
              {h.provider}: {h.hasKey ? h.status : 'no key'}
            </Badge>
          ))}
        </div>
        <p className="dash-small" style={{ marginBottom: 0 }}>
          <ShieldCheck size={12} /> Keys are encrypted with {secrets?.backend ?? 'the OS keystore'} and only used by the main process. They never reach this window, logs or session files.
          {secrets && !secrets.encryptionAvailable ? <strong style={{ color: 'var(--error)' }}> OS encryption unavailable — keys cannot be saved.</strong> : null}
        </p>
      </Card>
      {PROVIDER_IDS.map((p) => <ProviderCard key={p} id={p} secrets={secrets} onSecrets={setSecrets} />)}
    </>
  );
}

function TranscriptionTab() {
  const s = useLive((x) => x.settings)!;
  const patch = usePatch();
  return (
    <Card title="Streaming transcription">
      <Field label="Provider" hint="Independent from the answer model. Mic and system audio use separate sessions so transcripts stay distinguishable.">
        <select className="vc-select" value={s.stt.provider} onChange={(e) => void patch({ stt: { provider: e.target.value } })}>
          <option value="cloud-whisper">Hirora Cloud — Whisper (free; text appears when each sentence ends)</option>
          <option value="gemini-live">Google Gemini 3.5 Transcribe Live (needs Gemini key)</option>
          <option value="xai-stt">xAI Grok streaming STT (needs xAI key)</option>
        </select>
      </Field>
      <div className="vc-grid2">
        <Field label="Language" hint="BCP-47, e.g. en-US, en-IN, hi-IN. Empty = automatic detection.">
          <input className="vc-input" value={s.stt.language} onChange={(e) => void patch({ stt: { language: e.target.value.trim() } })} />
        </Field>
        <Field label="End-of-utterance silence (ms)" hint="xAI endpointing; local VAD hint for Gemini uses ~450 ms.">
          <input className="vc-input" type="number" min={100} max={5000} value={s.stt.endpointingMs} onChange={(e) => void patch({ stt: { endpointingMs: Number(e.target.value) } })} />
        </Field>
      </div>
      {s.stt.provider === 'gemini-live' ? (
        <Field label="Gemini transcription mode">
          <select className="vc-select" value={s.stt.geminiMode} onChange={(e) => void patch({ stt: { geminiMode: e.target.value } })}>
            <option value="VERBATIM">Verbatim (shows exactly what was heard)</option>
            <option value="SMART">Smart (removes fillers, formats numbers)</option>
          </select>
        </Field>
      ) : null}
      <Field label="Custom vocabulary" hint="Names, products, acronyms (one per line, up to 100).">
        <textarea className="vc-textarea" defaultValue={s.stt.customVocabulary.join('\n')} onBlur={(e) => void patch({ stt: { customVocabulary: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 100) } })} />
      </Field>
    </Card>
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
          <Field label="Output device to capture">
            <select className="vc-select" value={s.audio.systemDeviceId ?? ''} onChange={(e) => void patch({ audio: { systemDeviceId: e.target.value || null } })}>
              <option value="">Windows default{devices?.render.find((d) => d.isDefault) ? ` (${devices.render.find((d) => d.isDefault)!.name})` : ''}</option>
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
        <Field label={`Noise gate: ${s.audio.noiseGateDbfs <= -89 ? 'off (stream everything)' : `${s.audio.noiseGateDbfs} dBFS`}`} hint="Silence below this level is not streamed to the paid STT provider (an adaptive voice detector with 300 ms pre-roll opens the gate). Lower = more sensitive; leftmost = off.">
          <input type="range" min={-90} max={-30} step={1} value={s.audio.noiseGateDbfs} onChange={(e) => void patch({ audio: { noiseGateDbfs: Number(e.target.value) } })} />
        </Field>
        <p className="dash-small" style={{ margin: 0 }}>Device changes (headset plugged in, Bluetooth reconnect, new default device) are picked up automatically within about a second. Capture pauses on sleep; resume from the overlay.</p>
      </Card>
    </>
  );
}

function AnswersTab() {
  const s = useLive((x) => x.settings)!;
  const patch = usePatch();
  const a = s.answer;
  return (
    <>
      <Card title="Style">
        <div className="vc-grid2">
          <Field label="Default mode">
            <select className="vc-select" value={a.mode} onChange={(e) => void patch({ answer: { mode: e.target.value } })}>{MODES.map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}</select>
          </Field>
          <Field label="Answer length">
            <select className="vc-select" value={a.length} onChange={(e) => void patch({ answer: { length: e.target.value } })}><option value="short">Short cue</option><option value="medium">Medium</option><option value="long">Long</option></select>
          </Field>
          <Field label="Format (interview modes)">
            <select className="vc-select" value={a.format} onChange={(e) => void patch({ answer: { format: e.target.value } })}><option value="talking_points">Talking points</option><option value="star">STAR</option><option value="paragraph">Paragraph</option></select>
          </Field>
          <Field label="Technical depth">
            <select className="vc-select" value={a.technicalDepth} onChange={(e) => void patch({ answer: { technicalDepth: e.target.value } })}><option value="basic">Basic</option><option value="intermediate">Intermediate</option><option value="expert">Expert</option></select>
          </Field>
          <Field label="Tone"><input className="vc-input" value={a.tone} onChange={(e) => void patch({ answer: { tone: e.target.value } })} /></Field>
          <Field label="Answer language"><input className="vc-input" value={a.language} onChange={(e) => void patch({ answer: { language: e.target.value } })} /></Field>
        </div>
        <Toggle checked={a.codingIncludeTests} label="Coding answers include test cases" onChange={(v) => void patch({ answer: { codingIncludeTests: v } })} />
      </Card>
      <Card title="Automatic answering">
        <Toggle checked={a.autoAnswer} label="Answer detected questions automatically" description="Otherwise press Ctrl+Shift+Enter (or the Answer button). Never active in Meeting Notes mode." onChange={(v) => void patch({ answer: { autoAnswer: v } })} />
        <div className="dash-small">Hirora only knows which device audio came from, not who spoke. Choose which sources may trigger automatic answers:</div>
        {(['system', 'app', 'mic'] as const).map((src) => (
          <Toggle key={src} checked={a.autoAnswerSources.includes(src)} label={src === 'mic' ? 'Microphone' : src === 'system' ? 'System audio' : 'Selected application audio'} onChange={(v) => void patch({ answer: { autoAnswerSources: v ? [...new Set([...a.autoAnswerSources, src])] : a.autoAnswerSources.filter((x) => x !== src) } })} />
        ))}
      </Card>
      <Card title="Limits & timeouts">
        <div className="vc-grid2">
          <Field label="First-token timeout (ms)" hint="Then retry once / use fallback."><input className="vc-input" type="number" value={a.firstTokenTimeoutMs} onChange={(e) => void patch({ answer: { firstTokenTimeoutMs: Number(e.target.value) } })} /></Field>
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
          label="Ask Windows to exclude the overlay from screen capture"
          description="Uses Electron setContentProtection → SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE). Not every capture method honours it (cameras, some remote-desktop and hardware capture never will). This is a privacy convenience — Hirora does not claim the overlay is undetectable and does not try to evade monitoring or proctoring software."
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
      <Card title="What leaves this computer">
        <ul className="dash-small" style={{ marginTop: 0 }}>
          <li>Audio: only after you press Start and confirm consent, only to your selected transcription provider, never written to disk.</li>
          <li>Answers: the question, a few retrieved passages, your profile summary (if allowed below) and the recent transcript go to your answer provider.</li>
          <li>Clipboard and screenshots: only after you preview and press Send. Possible secrets are flagged and can be redacted.</li>
          <li>Embeddings (optional): document chunks go to Google once, if you enable semantic search.</li>
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
              const typed = prompt('This deletes ALL Hirora data on this computer: saved keys, documents, profiles, history, timings and settings. Type DELETE to confirm.');
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

function BudgetTab() {
  const s = useLive((x) => x.settings)!;
  const snapshot = useLive((x) => x.snapshot);
  const patch = usePatch();
  const b = s.budget;
  const [pk, setPk] = useState('');
  const [inP, setInP] = useState('');
  const [outP, setOutP] = useState('');
  const modelKeys = PROVIDER_IDS.filter((p) => s.providers[p].model).flatMap((p) => [`${p}:${s.providers[p].model}`, ...(s.providers[p].deepModel ? [`${p}:${s.providers[p].deepModel}`] : [])]);
  return (
    <>
      <Card title="Guardrails (conservative by default)">
        <div className="vc-grid2">
          <Field label="Max answers per day"><input className="vc-input" type="number" value={b.dailyAnswerLimit} onChange={(e) => void patch({ budget: { dailyAnswerLimit: Number(e.target.value) } })} /></Field>
          <Field label="Max transcription minutes per day"><input className="vc-input" type="number" value={b.dailySttMinutesLimit} onChange={(e) => void patch({ budget: { dailySttMinutesLimit: Number(e.target.value) } })} /></Field>
          <Field label="Monthly spend cap (USD, priced usage only)" hint="Applies to models you priced below. Empty = no cap."><input className="vc-input" type="number" step="0.5" value={b.monthlyUsdCap ?? ''} onChange={(e) => void patch({ budget: { monthlyUsdCap: e.target.value === '' ? null : Number(e.target.value) } })} /></Field>
        </div>
        <div className="dash-small">Today: {snapshot?.usageToday.answers ?? 0} answers · {(snapshot?.usageToday.sttMinutes ?? 0).toFixed(1)} transcription minutes{snapshot?.usageToday.costUsd != null ? ` · $${snapshot.usageToday.costUsd.toFixed(4)}` : ' · cost unknown (no prices entered)'}</div>
      </Card>
      <Card title="Model prices (USD per 1M tokens)">
        <p className="dash-small" style={{ marginTop: 0 }}>Prices change; Hirora does not guess them. Copy current prices from your provider’s pricing page to see cost estimates computed from reported token usage.</p>
        <table className="dash-table">
          <thead><tr><th>Model</th><th className="dash-num">Input</th><th className="dash-num">Output</th><th /></tr></thead>
          <tbody>
            {Object.entries(b.prices).map(([k, v]) => (
              <tr key={k}><td className="dash-mono">{k}</td><td className="dash-num">{v.inputPer1M}</td><td className="dash-num">{v.outputPer1M}</td>
                <td><Button size="sm" variant="ghost" icon={<Trash2 size={12} />} aria-label="Remove price" onClick={() => { const next = { ...b.prices }; delete next[k]; void patch({ budget: { '=prices': next } }); }} /></td></tr>
            ))}
          </tbody>
        </table>
        <div className="vc-row" style={{ marginTop: 10 }}>
          <select className="vc-select" style={{ width: 280 }} value={pk} onChange={(e) => setPk(e.target.value)}>
            <option value="">Choose model…</option>
            {modelKeys.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <input className="vc-input" style={{ width: 110 }} placeholder="input $" value={inP} onChange={(e) => setInP(e.target.value)} />
          <input className="vc-input" style={{ width: 110 }} placeholder="output $" value={outP} onChange={(e) => setOutP(e.target.value)} />
          <Button size="sm" disabled={!pk || !inP || !outP || Number.isNaN(Number(inP)) || Number.isNaN(Number(outP))} onClick={() => { void patch({ budget: { prices: { ...b.prices, [pk]: { inputPer1M: Number(inP), outputPer1M: Number(outP) } } } }); setInP(''); setOutP(''); }}>Add price</Button>
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
  const [tab, setTab] = useState<Tab>('Providers');
  if (!settings) return null;
  return (
    <>
      <PageHeader bold="Settings" sub="Everything works without keys except live transcription and answers. Changes save immediately." right={<ThemeSwitch />} />
      <div className="dash-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={cx('dash-tab', tab === t && 'is-active')} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {tab === 'Providers' && <ProvidersTab />}
      {tab === 'Transcription' && <TranscriptionTab />}
      {tab === 'Audio' && <AudioTab />}
      {tab === 'Answers' && <AnswersTab />}
      {tab === 'Overlay & capture' && <OverlayTab />}
      {tab === 'Hotkeys' && <HotkeysTab />}
      {tab === 'Privacy & data' && <PrivacyTab />}
      {tab === 'Budget' && <BudgetTab />}
    </>
  );
}
