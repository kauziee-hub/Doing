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
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
          <li>AI answers and speech recognition run on this PC, with no cloud model requests.</li>
          <li>Only folders and browser tabs you allow can be used for tasks. Website submissions send information to that website.</li>
          <li>Audio and screenshots stay in memory. Saved meeting history is opt-in.</li>
          <li>Assistant and browser chats stay in memory for the app session. File changes remain in the folder you choose.</li>
          <li>Engine downloads and optional update checks use the internet. No accounts, analytics or telemetry.</li>
        </ul>
      </Card>
    </>
  );
}
