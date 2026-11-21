import { useEffect, useState } from 'react';
import type { AppInfo } from '@hirora/contracts';
import { Button, Card } from '@hirora/ui';
import { invoke } from '../../shared/api';
import { PageHeader } from '../App';

export function About() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void invoke('app:info').then(setInfo);
  }, []);
  return (
    <>
      <PageHeader light="About &" bold="privacy" sub="Hirora is an independent desktop copilot with no accounts, analytics or telemetry. The optional Hirora Cloud relay forwards answers and speech to Groq and stores nothing; your documents, history and keys stay on this PC." />
      <Card title="Build">
        {info ? (
          <dl className="dash-kv">
            <dt>Version</dt><dd>{info.version}{info.packaged ? '' : ' (development)'}</dd>
            <dt>Electron / Chromium / Node</dt><dd>{info.electron} / {info.chrome} / {info.node}</dd>
            <dt>OS</dt><dd>{info.platform} {info.osRelease} ({info.arch})</dd>
            <dt>Data folder</dt><dd className="dash-mono">{info.userDataPath}</dd>
            <dt>Audio helper</dt><dd className="dash-mono">{info.helperPath ?? 'not found'}</dd>
          </dl>
        ) : null}
        <div className="vc-row" style={{ marginTop: 12 }}><Button onClick={() => void invoke('app:openDataFolder')}>Open data folder</Button></div>
      </Card>
      <Card title="Privacy summary">
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
          <li>API keys: encrypted with Electron safeStorage (Windows DPAPI, your user account). Used only in the main process; never written to logs, settings or history.</li>
          <li>Audio: captured only after explicit Start + consent, streamed to your selected transcription provider, never saved. A red LISTENING badge shows while capture is active.</li>
          <li>Documents: parsed locally; extracted text and a search index are stored in a local SQLite database. Only relevant passages are sent with questions.</li>
          <li>History: off by default. When on, kept locally for your retention period; deletable per session or all at once.</li>
          <li>Screenshots and clipboard: never captured silently; always previewed and confirmed; possible secrets are flagged.</li>
          <li>Screen-capture exclusion is a best-effort OS setting. Hirora never claims to be undetectable and does not evade monitoring, proctoring or security software.</li>
        </ul>
      </Card>
    </>
  );
}
