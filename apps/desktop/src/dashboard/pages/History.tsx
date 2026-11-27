import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { HistorySessionDetail, HistorySessionSummary } from '@hirora/contracts';
import { Button, Card, EmptyState, Toggle } from '@hirora/ui';
import { invoke } from '../../shared/api';
import { PageHeader } from '../App';
import { useLive } from '../../shared/store';
import { Markdown } from '../../shared/Markdown';

export function HistoryPage() {
  const settings = useLive((s) => s.settings);
  const setSettings = useLive((s) => s.setSettings);
  const [list, setList] = useState<HistorySessionSummary[]>([]);
  const [detail, setDetail] = useState<HistorySessionDetail | null>(null);
  const refresh = async () => setList(await invoke('history:list'));
  useEffect(() => {
    void refresh();
  }, []);

  return (
    <>
      <PageHeader bold="History" sub="Saved meeting transcripts and answers. You choose what stays." />
      <Card>
        {settings ? (
          <Toggle
            checked={settings.privacy.saveHistory}
            label="Save session history on this computer"
            description={`Transcripts and answers are kept in the local database for ${settings.privacy.historyRetentionDays} days. Raw audio is never saved.`}
            onChange={async (v) => setSettings(await invoke('settings:update', { privacy: { saveHistory: v } }))}
          />
        ) : null}
        <div className="vc-row">
          <Button variant="danger" icon={<Trash2 size={13} />} disabled={list.length === 0} onClick={async () => { if (confirm('Delete all saved sessions? This cannot be undone.')) { await invoke('history:deleteAll'); setDetail(null); await refresh(); } }}>Delete all history</Button>
        </div>
      </Card>
      <div className="dash-cols">
        <Card title={`Sessions (${list.length})`}>
          {list.length === 0 ? <EmptyState title="No saved sessions">{settings?.privacy.saveHistory ? 'Sessions you run will appear here.' : 'History saving is off.'}</EmptyState> : (
            <table className="dash-table">
              <thead><tr><th>When</th><th>Session</th><th className="dash-num">Lines</th><th className="dash-num">Answers</th><th /></tr></thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id}>
                    <td>{new Date(s.startedAt).toLocaleString()}</td>
                    <td><button type="button" className="dash-link" onClick={async () => setDetail(await invoke('history:get', { sessionId: s.id }))}>{s.title}</button>{s.profileName ? <div className="dash-small">{s.profileName}</div> : null}</td>
                    <td className="dash-num">{s.segmentCount}</td>
                    <td className="dash-num">{s.answerCount}</td>
                    <td><Button size="sm" variant="ghost" icon={<Trash2 size={13} />} aria-label="Delete session" onClick={async () => { await invoke('history:delete', { sessionId: s.id }); if (detail?.session.id === s.id) setDetail(null); await refresh(); }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Details">
          {!detail ? <div className="dash-small">Select a session.</div> : (
            <>
              {detail.segments.map((s) => <div key={s.id} className="dash-small"><strong>{s.source}</strong>: {s.text}</div>)}
              {detail.answers.map((a) => (
                <div key={a.requestId} className="dash-chunk">
                  <div className="dash-chunk__meta">Q: {a.question} · {a.provider}/{a.model} · {a.status}</div>
                  <Markdown text={a.text || a.error || ''} />
                </div>
              ))}
            </>
          )}
        </Card>
      </div>
    </>
  );
}
