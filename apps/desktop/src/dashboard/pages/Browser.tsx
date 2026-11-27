import { useEffect, useState } from 'react';
import { FolderOpen, Globe, Square } from 'lucide-react';
import { Button, Card } from '@doing/ui';
import type { BrowserStatus } from '@doing/contracts';
import { invoke } from '../../shared/api';
import { useLive } from '../../shared/store';
import { PageHeader } from '../App';
export function BrowserPage() {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useLive((s) => s.toast);
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      void invoke('browser:status')
        .then((s) => {
          if (alive) setStatus(s);
        })
        .catch((e: Error) => {
          if (alive) toast('error', e.message);
        });
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [toast]);
  const act = async (action: () => Promise<BrowserStatus>) => {
    setBusy(true);
    try {
      setStatus(await action());
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader bold="Browser" sub="Chat and get things done beside your Chrome or Edge tabs." right={<Globe size={28} />} />
      <Card>
        <span className="doing-connection-state">
          {!status
            ? 'Checking connection…'
            : status.trustedBrowser
              ? 'Browser remembered'
              : status.enabled
                ? 'Ready to connect'
                : 'Connection off'}
        </span>
        <h2 className="dash-section-title" style={{ marginTop: 22 }}>
          {status?.tab ? 'Your browser chat is ready.' : 'Open Doing in your browser.'}
        </h2>
        <p className="dash-section-sub">
          Click the Doing extension, allow a tab, then tell it what to do. Replies and follow-ups stay in the side panel.
        </p>
        {status?.tabs.length ? (
          <div className="doing-scope">
            {status.tabs.map((tab) => (
              <span key={tab.id} title={tab.url}>
                {tab.title}
              </span>
            ))}
          </div>
        ) : null}
        {status?.connectionRequest && (
          <div role="region" aria-label="Browser connection approval" className="dash-chunk">
            <h3>Connect this browser?</h3>
            <p className="dash-small">
              {status.connectionRequest.label} · {status.connectionRequest.extensionId}
            </p>
            <div className="vc-row">
              <Button
                variant="primary"
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    invoke('browser:allowConnection', {
                      requestId: status.connectionRequest!.id,
                    }),
                  )
                }
              >
                Allow connection & remember
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void act(() =>
                    invoke('browser:denyConnection', {
                      requestId: status.connectionRequest!.id,
                    }),
                  )
                }
              >
                Decline
              </Button>
            </div>
          </div>
        )}
        <div className="vc-row" style={{ marginTop: 20, flexWrap: 'wrap' }}>
          <Button
            icon={<FolderOpen size={14} />}
            onClick={() => void invoke('browser:openExtension').catch((e: Error) => toast('error', e.message))}
          >
            Open extension folder
          </Button>
          {!status?.enabled && (
            <Button variant="primary" disabled={busy || !status} onClick={() => void act(() => invoke('browser:enable'))}>
              Enable browser connection
            </Button>
          )}
          {(status?.chatting || status?.phase === 'review') && (
            <Button icon={<Square size={13} />} onClick={() => void act(() => invoke('browser:stop'))}>
              Stop current request
            </Button>
          )}
        </div>
      </Card>
      <Card>
        <details open={!status?.trustedBrowser}>
          <summary>Install or update the extension</summary>
          <ol className="dash-small" style={{ lineHeight: 1.9 }}>
            <li>
              Open <strong>chrome://extensions</strong> or <strong>edge://extensions</strong> and turn on Developer mode.
            </li>
            <li>
              Choose <strong>Load unpacked</strong> and select the folder above. Already installed? Choose <strong>Reload</strong>.
            </li>
            <li>
              Click Doing in the browser toolbar → <strong>Allow this tab</strong>. Approve this browser here once.
            </li>
          </ol>
          <p className="dash-small">No pairing code needed. Add up to eight tabs. Say when to submit in chat.</p>
        </details>
        <details style={{ marginTop: 18 }}>
          <summary>Access & connection</summary>
          <p className="dash-small">
            Only tabs you allow are read. Close a tab or revoke its access anytime. Local AI can make mistakes; check important results.
          </p>
          <p className="dash-small" role="status">
            {status?.message}
          </p>
          <Button size="sm" disabled={busy || !status?.enabled} onClick={() => void act(() => invoke('browser:disable'))}>
            Forget browser & revoke access
          </Button>
        </details>
      </Card>
    </>
  );
}
