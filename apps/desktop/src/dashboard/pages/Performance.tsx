import { useEffect, useState } from 'react';
import { RefreshCw, Timer, Trash2 } from 'lucide-react';
import type { LocalBenchResult, PerfSample, PerfSummaryRow } from '@hirora/contracts';
import { Badge, Button, Card, EmptyState } from '@hirora/ui';
import { invoke } from '../../shared/api';
import { PageHeader } from '../App';

const STAGE_INFO: Record<string, { label: string; target?: number; p: 50 | 95 }> = {
  hotkey_to_paint: { label: 'Hotkey → overlay paint', target: 100, p: 95 },
  stt_first_partial: { label: 'Speech onset → first transcript text', target: 500, p: 50 },
  speech_end_to_final: { label: 'End of speech → final transcript', p: 50 },
  final_to_question: { label: 'Final transcript → question dispatched', p: 50 },
  retrieval: { label: 'Knowledge retrieval', p: 95 },
  request_to_first_token: { label: 'Model request → first token', p: 50 },
  question_to_first_token: { label: 'Question end → first token', target: 1500, p: 50 },
  question_to_first_paint: { label: 'Question end → first answer paint', target: 1500, p: 50 },
  answer_total: { label: 'Model request → answer complete', p: 50 },
  provider_preconnect: { label: 'Provider connect / STT session open', p: 50 },
  app_cold_start: { label: 'App launch → dashboard ready', p: 50 },
};

export function Performance() {
  const [data, setData] = useState<{ rows: PerfSummaryRow[]; recent: PerfSample[]; total: number } | null>(null);
  const [bench, setBench] = useState<LocalBenchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = async () => setData(await invoke('perf:summary'));
  useEffect(() => {
    void refresh();
  }, []);

  return (
    <>
      <PageHeader light="Measured" bold="performance" sub="Every number here was measured on this PC from real events — nothing estimated or pre-filled. Targets are goals, not guarantees; provider load dominates model latency." />
      <div className="vc-row" style={{ marginBottom: 14 }}>
        <Button icon={<RefreshCw size={13} />} onClick={() => void refresh()}>Refresh</Button>
        <Button icon={<Timer size={13} />} disabled={busy} onClick={async () => { setBusy(true); setBench(await invoke('perf:runLocalBench')); setBusy(false); }}>{busy ? 'Running…' : 'Run local benchmarks'}</Button>
        <Button variant="danger" icon={<Trash2 size={13} />} onClick={async () => { if (confirm('Clear all recorded timings?')) { await invoke('perf:clear'); await refresh(); } }}>Clear</Button>
        <span className="dash-small">{data?.total ?? 0} samples recorded</span>
      </div>
      <Card title="Measured pipeline latency">
        {!data || data.rows.length === 0 ? (
          <EmptyState title="No measurements yet">Use the app (ask a question, press a hotkey, start listening) and timings appear here. For a repeatable provider benchmark run <code>pnpm perf:live</code>.</EmptyState>
        ) : (
          <table className="dash-table">
            <thead><tr><th>Stage</th><th>Provider</th><th className="dash-num">n</th><th className="dash-num">p50 ms</th><th className="dash-num">p95 ms</th><th className="dash-num">min</th><th className="dash-num">max</th><th>Target</th></tr></thead>
            <tbody>
              {data.rows
                .sort((a, b) => a.stage.localeCompare(b.stage))
                .map((r) => {
                  const info = STAGE_INFO[r.stage];
                  const val = info?.p === 95 ? r.p95 : r.p50;
                  const met = info?.target !== undefined ? val <= info.target : null;
                  return (
                    <tr key={`${r.stage}|${r.provider}`}>
                      <td>{info?.label ?? r.stage}</td>
                      <td>{r.provider ?? '—'}</td>
                      <td className="dash-num">{r.count}</td>
                      <td className="dash-num">{Math.round(r.p50)}</td>
                      <td className="dash-num">{Math.round(r.p95)}</td>
                      <td className="dash-num">{Math.round(r.min)}</td>
                      <td className="dash-num">{Math.round(r.max)}</td>
                      <td>{info?.target !== undefined ? <Badge tone={met ? 'ok' : 'warn'}>p{info.p} &lt; {info.target}{r.count < 20 ? ' (few samples)' : ''}</Badge> : '—'}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        )}
      </Card>
      {bench ? (
        <Card title="Local benchmarks (no network)">
          <table className="dash-table">
            <thead><tr><th>Benchmark</th><th className="dash-num">iterations</th><th className="dash-num">p50 ms</th><th className="dash-num">p95 ms</th></tr></thead>
            <tbody>{bench.map((b) => <tr key={b.label}><td>{b.label}</td><td className="dash-num">{b.iterations}</td><td className="dash-num">{b.p50}</td><td className="dash-num">{b.p95}</td></tr>)}</tbody>
          </table>
        </Card>
      ) : null}
      {data && data.recent.length ? (
        <Card title="Recent samples">
          <table className="dash-table">
            <thead><tr><th>Time</th><th>Stage</th><th>Provider / model</th><th>Label</th><th className="dash-num">ms</th></tr></thead>
            <tbody>
              {data.recent.slice(0, 40).map((s, i) => (
                <tr key={i}><td>{new Date(s.at).toLocaleTimeString()}</td><td>{STAGE_INFO[s.stage]?.label ?? s.stage}</td><td>{[s.provider, s.model].filter(Boolean).join(' / ') || '—'}</td><td>{s.label ?? ''}</td><td className="dash-num">{Math.round(s.ms)}</td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </>
  );
}
