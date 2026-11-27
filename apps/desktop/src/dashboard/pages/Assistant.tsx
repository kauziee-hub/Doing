import { useEffect, useRef, useState } from 'react';
import { ArrowUp, FolderOpen, Plus, Square, Undo2, X } from 'lucide-react';
import { Button, Card } from '@doing/ui';
import type { LocalStatus } from '@doing/contracts';
import { invoke } from '../../shared/api';
import { useLive } from '../../shared/store';
import { Markdown } from '../../shared/Markdown';
import { PageHeader } from '../App';

export function Assistant({ go }: { go: (page: string) => void }) {
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ready = useLive((s) => s.engine?.ready);
  const toast = useLive((s) => s.toast);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      void invoke('local:status')
        .then((s) => {
          if (alive) setStatus(s);
        })
        .catch((e: Error) => {
          if (alive) toast('error', e.message);
        });
    refresh();
    const timer = setInterval(refresh, 650);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [toast]);
  useEffect(() => {
    if (status?.messages.length) end.current?.scrollIntoView({ block: 'nearest' });
    else end.current?.parentElement?.scrollTo({ top: 0 });
  }, [status?.messages.length]);
  const act = async (action: () => Promise<LocalStatus>) => {
    setSending(true);
    try {
      setStatus(await action());
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setSending(false);
    }
  };
  const send = async () => {
    if (!text.trim() || status?.busy || sending) return;
    const message = text.trim();
    setSending(true);
    try {
      setStatus(await invoke('local:send', { text: message }));
      setText('');
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setSending(false);
    }
  };
  return (
    <>
      <PageHeader
        bold="Assistant"
        sub="Ask, write and get things done on your PC."
        right={
          <Button size="sm" icon={<Plus size={14} />} disabled={sending} onClick={() => void act(() => invoke('local:clear'))}>
            New chat
          </Button>
        }
      />
      {!ready && (
        <Card className="doing-setup">
          <div>
            <h2>Set up Doing</h2>
            <p>Download the local engine once to start chatting and working with files.</p>
          </div>
          <Button size="sm" onClick={() => go('settings')}>
            Open setup
          </Button>
        </Card>
      )}
      <div className="doing-workspace">
        <div className="doing-scope">
          <Button
            size="sm"
            icon={<FolderOpen size={14} />}
            disabled={sending || !!status?.busy}
            onClick={() => void act(() => invoke('local:chooseFolder'))}
          >
            {status?.folder ? 'Change folder' : 'Allow a folder'}
          </Button>
          <span title={status?.folder || ''}>{status?.folder || 'Choose a folder for file tasks. Chat works without one.'}</span>
          {status?.folder && (
            <Button
              size="sm"
              variant="ghost"
              aria-label="Revoke folder access"
              icon={<X size={13} />}
              onClick={() => void act(() => invoke('local:revoke'))}
            />
          )}
        </div>
        <section className="doing-conversation" aria-label="Assistant conversation" aria-live="polite" aria-relevant="additions">
          {!status?.messages.length && (
            <div className="doing-welcome">
              <h2>What can I take off your list?</h2>
              <p>Find files, open apps, play music, change a setting, draft a WhatsApp message, or work with files in a folder you allow.</p>
              <div className="doing-suggestions">
                {[
                  'Where is my resume?',
                  'Play Blinding Lights on Spotify.',
                  'Turn on dark mode.',
                  'Create a weekly plan in a Markdown file.',
                ].map((prompt) => (
                  <button key={prompt} type="button" onClick={() => setText(prompt)}>
                    {prompt}
                    <span>↗</span>
                  </button>
                ))}
              </div>
              <div className="doing-other-work">
                <button type="button" onClick={() => go('browser')}>
                  Work in Chrome ↗
                </button>
                <button type="button" onClick={() => go('home')}>
                  Transcribe a meeting ↗
                </button>
              </div>
            </div>
          )}
          {status?.messages.map((m) => (
            <article key={m.id} className={`doing-message ${m.role}`}>
              <span className="doing-message__name">{m.role === 'user' ? 'You' : 'Doing'}</span>
              <Markdown text={m.text} />
            </article>
          ))}
          {status?.busy && (
            <p role="status" className="dash-small">
              {status.message || 'Working…'}
            </p>
          )}
          <div ref={end} />
        </section>
        {status?.changes.length ? (
          <details className="doing-changes">
            <summary>
              {status.changes.length} file change
              {status.changes.length === 1 ? '' : 's'}
            </summary>
            <ul>
              {status.changes.map((change, i) => (
                <li key={`${change.path}-${i}`}>
                  {change.kind}: {change.path}
                </li>
              ))}
            </ul>
            <Button
              size="sm"
              icon={<Undo2 size={13} />}
              disabled={!status.canUndo || sending}
              onClick={() => void act(() => invoke('local:undo'))}
            >
              Undo last change
            </Button>
          </details>
        ) : null}
        <form
          className="doing-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label className="vc-sr-only" htmlFor="assistant-message">
            Message Doing
          </label>
          <textarea
            id="assistant-message"
            rows={2}
            maxLength={6000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Message Doing…"
            disabled={!!status?.busy}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div>
            <span>Local AI · Check important results</span>
            {status?.busy ? (
              <Button size="sm" icon={<Square size={13} />} onClick={() => void act(() => invoke('local:stop'))}>
                Stop
              </Button>
            ) : (
              <Button
                variant="primary"
                size="sm"
                type="submit"
                aria-label="Send message"
                icon={<ArrowUp size={16} />}
                disabled={!ready || sending || !text.trim()}
              >
                Send
              </Button>
            )}
          </div>
        </form>
        <p className="doing-caption">Text, code, Markdown and CSV files. Undo edits here. Restore deleted items from Windows Recycle Bin.</p>
      </div>
    </>
  );
}
