import { useCallback, useEffect, useState } from 'react';
import { AudioLines, BookOpen, History as HistoryIcon, Settings as SettingsIcon, Globe, MessageCircle } from 'lucide-react';
import { cx } from '@hirora/ui';
import { useLive } from '../shared/store';
import { useTheme } from '../shared/theme';
import { LogoMark } from '../shared/Logo';
import { Toasts } from '../overlay/Overlay';
import { Home } from './pages/Home';
import { Prep } from './pages/Prep';
import { HistoryPage } from './pages/History';
import { SettingsPage } from './pages/Settings';
import type { SettingsTab } from './pages/Settings';
import { Onboarding } from './pages/Onboarding';
import { BrowserPage } from './pages/Browser';
import { Assistant } from './pages/Assistant';

const PAGES = [
  { id: 'assistant', label: 'Assistant', icon: MessageCircle },
  { id: 'home', label: 'Meetings', icon: AudioLines },
  { id: 'browser', label: 'Browser assistant', icon: Globe },
  { id: 'prep', label: 'Library', icon: BookOpen },
  { id: 'history', label: 'History', icon: HistoryIcon },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
] as const;
type PageId = (typeof PAGES)[number]['id'];
/** Page names from before 0.4.0 (links in the overlay, tray and onboarding). */
const MOVED: Record<string, PageId> = {
  knowledge: 'prep',
  profiles: 'prep',
  performance: 'settings',
  about: 'settings',
  audio: 'settings',
};
const pageFor = (id: string): PageId | null => (PAGES.some((p) => p.id === id) ? (id as PageId) : (MOVED[id] ?? null));

export function App() {
  const [page, setPage] = useState<PageId>('assistant');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('Engine');
  const go = useCallback((id: string) => {
    const next = pageFor(id);
    if (!next) return;
    if (next === 'settings')
      setSettingsTab(id === 'audio' ? 'Audio' : id === 'performance' ? 'Performance' : id === 'about' ? 'About' : 'Engine');
    setPage(next);
  }, []);
  const settings = useLive((s) => s.settings);
  const snapshot = useLive((s) => s.snapshot);
  const commands = useLive((s) => s.commands);
  const consume = useLive((s) => s.consumeCommand);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  useTheme();

  useEffect(() => {
    if (settings && !settings.onboardingComplete) setOnboardingOpen(true);
  }, [settings?.onboardingComplete]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    for (const c of commands) {
      if (c.command === 'navigate' && typeof c.arg === 'string') go(c.arg);
      if (c.command === 'navigate' || c.command === 'devicesChanged') consume(c.id);
    }
  }, [commands, consume, go]);

  const listening = snapshot?.session === 'listening';
  const main = PAGES.slice(0, 5);
  const foot = PAGES.slice(5);
  return (
    <div className="dash">
      <nav className="dash-rail" aria-label="Main">
        <div className="dash-rail__logo">
          <LogoMark size={40} />
        </div>
        <div className="dash-rail__bar">
          {main.map((p) => (
            <button
              key={p.id}
              type="button"
              data-tip={p.label}
              aria-label={p.label}
              className={cx('dash-rail__item', page === p.id && 'is-active')}
              aria-current={page === p.id ? 'page' : undefined}
              onClick={() => setPage(p.id)}
            >
              <p.icon size={19} strokeWidth={1.8} aria-hidden="true" />
            </button>
          ))}
          <div className="dash-rail__spacer" />
          {foot.map((p) => (
            <button
              key={p.id}
              type="button"
              data-tip={p.label}
              aria-label={p.label}
              className={cx('dash-rail__item', page === p.id && 'is-active')}
              aria-current={page === p.id ? 'page' : undefined}
              onClick={() => setPage(p.id)}
            >
              <p.icon size={19} strokeWidth={1.8} aria-hidden="true" />
            </button>
          ))}
          <span
            className={cx('dash-rail__live', listening && 'is-on')}
            title={listening ? 'Listening — audio is being transcribed' : 'Not listening'}
            aria-label={listening ? 'Listening' : 'Not listening'}
            role="status"
          />
        </div>
      </nav>
      <main className="dash-main">
        {page === 'assistant' && <Assistant go={go} />}
        {page === 'home' && <Home go={go} />}
        {page === 'prep' && <Prep />}
        {page === 'browser' && <BrowserPage />}
        {page === 'history' && <HistoryPage />}
        {page === 'settings' && <SettingsPage key={settingsTab} initial={settingsTab} onGuide={() => setOnboardingOpen(true)} />}
      </main>
      {onboardingOpen ? <Onboarding onClose={() => setOnboardingOpen(false)} go={(p) => setPage(pageFor(p) ?? 'home')} /> : null}
      <Toasts />
    </div>
  );
}

/** Shared page header: light/bold mixed-weight title like an editorial headline. */
export function PageHeader({ light, bold, sub, right }: { light?: string; bold: string; sub?: string; right?: React.ReactNode }) {
  return (
    <header className="dash-top">
      <div>
        <h1 className="dash-page-title">
          {light ? <>{light} </> : null}
          <strong>{bold}</strong>
        </h1>
        {sub ? <p className="dash-page-sub">{sub}</p> : null}
      </div>
      {right ? <div className="dash-top__right">{right}</div> : null}
    </header>
  );
}
