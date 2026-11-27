import { useEffect, useState } from 'react';
import type { AppInfo } from '@hirora/contracts';
import { Button, Card } from '@hirora/ui';
import { invoke } from '../../shared/api';
import { PageHeader } from '../App';

export function About({ onGuide }: { onGuide?: () => void } = {}) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void invoke('app:info').then(setInfo);
  }, []);
  return (
    <>
      <PageHeader light="About &" bold="privacy" sub="Doing is a private assistant that runs on this PC. No account, analytics or telemetry." />
      <Card title="This copy">
        {info ? (
          <dl className="dash-kv">
            <dt>Version</dt><dd>{info.version}{info.packaged ? '' : ' (development)'}</dd>
            <dt>Windows</dt><dd>{info.osRelease} ({info.arch})</dd>
            <dt>Data folder</dt><dd className="dash-mono">{info.userDataPath}</dd>
          </dl>
        ) : null}
        <div className="vc-row" style={{ marginTop: 12 }}>
          <Button onClick={() => void invoke('app:openDataFolder')}>Open data folder</Button>
          {onGuide ? <Button variant="ghost" onClick={onGuide}>Setup guide</Button> : null}
        </div>
      </Card>
      <Card title="Privacy">
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
          <li>Speech and answers run on this PC (127.0.0.1). Internet is used only for the one-time engine download and, if on, a daily update check; every file is checked against its SHA-256.</li>
          <li>Audio is captured only after Start and your consent, transcribed here and never saved.</li>
          <li>Your screen is looked at only when a question points at it or you press Ctrl+Shift+O. The picture stays in memory.</li>
          <li>Documents and history stay in a local database. History is off unless you turn it on.</li>
          <li>Hiding Doing from screen shares is a best-effort Windows setting, not a way to evade monitoring or proctoring.</li>
        </ul>
      </Card>
    </>
  );
}
