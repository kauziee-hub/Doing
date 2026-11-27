import { Check, Cpu, Download, HardDrive, LoaderCircle, RotateCcw, X } from 'lucide-react';
import type { EngineComponentStatus, EngineStatus } from '@hirora/contracts';
import { Button, cx } from '@hirora/ui';
import { invoke } from '../shared/api';
import { useLive } from '../shared/store';

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

export function hardwareLine(e: EngineStatus): string {
  if (e.tier === 'gpu') return `${e.gpu?.name ?? 'NVIDIA GPU'} · ${Math.round((e.gpu?.vramMb ?? 0) / 1024)} GB — fastest setup`;
  if (e.gpu) return `${e.gpu.name} has too little memory for the large models — using the processor (answers take longer)`;
  return 'No NVIDIA graphics card found — Doing runs on the processor (answers take longer)';
}

function stateLabel(c: EngineComponentStatus): string {
  switch (c.state) {
    case 'ready':
      return 'Installed';
    case 'queued':
      return 'Waiting';
    case 'downloading':
      return `${formatBytes(c.bytesDone)} of ${formatBytes(c.bytesTotal)}`;
    case 'verifying':
      return 'Checking download…';
    case 'installing':
      return 'Installing…';
    case 'error':
      return 'Failed';
    default:
      return formatBytes(c.bytesTotal);
  }
}

function ComponentRow({ c }: { c: EngineComponentStatus }) {
  const busy = c.state === 'downloading' || c.state === 'verifying' || c.state === 'installing';
  const pct = c.bytesTotal ? Math.min(100, (c.bytesDone / c.bytesTotal) * 100) : 0;
  return (
    <div className="eng-row">
      <span className={cx('eng-row__icon', c.state === 'ready' && 'is-ok', c.state === 'error' && 'is-err')}>
        {c.state === 'ready' ? <Check size={14} /> : busy ? <LoaderCircle size={14} className="eng-spin" /> : c.state === 'error' ? <X size={14} /> : <Download size={14} />}
      </span>
      <div className="eng-row__body">
        <div className="eng-row__top">
          <strong>{c.label}</strong>
          <span className="eng-row__state">{stateLabel(c)}</span>
        </div>
        <div className="eng-row__detail">{c.detail}</div>
        {c.state === 'downloading' || c.state === 'verifying' || c.state === 'installing' ? (
          <div className="eng-bar" role="progressbar" aria-label={`${c.label} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
            <span className={cx(c.state !== 'downloading' && 'is-indeterminate')} style={{ width: c.state === 'downloading' ? `${pct}%` : '100%' }} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One-click setup of the on-PC engine: shows the hardware, what will be downloaded, live
 * progress, and a single Set up / Cancel / Try again button.
 */
export function EngineSetup({ onReady }: { onReady?: () => void }) {
  const engine = useLive((s) => s.engine);
  if (!engine) return <p className="dash-small">Checking this PC…</p>;
  const running = engine.setup === 'running';
  const total = engine.components.filter((c) => c.state !== 'ready').reduce((a, c) => a + c.bytesTotal, 0);
  const lowDisk = engine.freeDiskBytes !== null && engine.freeDiskBytes < engine.downloadBytes * 1.6 + 1e9;
  return (
    <div className="eng">
      <div className="eng-hw">
        <Cpu size={15} /> <span>{hardwareLine(engine)}</span>
      </div>
      <div className="eng-list">{engine.components.map((c) => <ComponentRow key={c.id} c={c} />)}</div>
      {engine.error ? <div className="ov-error" style={{ marginTop: 10 }}>{engine.error}</div> : null}
      <div className="eng-actions">
        {engine.ready && !running ? (
          <>
            <span className="eng-done"><Check size={15} /> Everything runs on this PC. Nothing you say leaves it.</span>
            {onReady ? <Button variant="primary" onClick={onReady}>Continue</Button> : null}
          </>
        ) : running ? (
          <>
            <span className="dash-small">You can keep using your PC. Setup carries on if you close this window.</span>
            <Button icon={<X size={13} />} onClick={() => void invoke('engine:cancel')}>Cancel</Button>
          </>
        ) : (
          <>
            <span className="dash-small">
              <HardDrive size={12} /> One-time download of {formatBytes(total)}
              {engine.freeDiskBytes !== null ? ` · ${formatBytes(engine.freeDiskBytes)} free` : ''}
              {lowDisk ? <strong style={{ color: 'var(--error)' }}> — not enough space</strong> : null}
            </span>
            <Button variant="primary" icon={engine.setup === 'error' || engine.setup === 'cancelled' ? <RotateCcw size={14} /> : <Download size={14} />} onClick={() => void invoke('engine:setup').then((s) => useLive.setState({ engine: s }))}>
              {engine.setup === 'error' || engine.setup === 'cancelled' ? 'Resume setup' : 'Set up Doing'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
