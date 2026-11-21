import { useEffect } from 'react';
import { useLive } from './store';

/** Applies the user's theme choice (system / light / dark) to <html data-theme>. */
export function useTheme(): void {
  const pref = useLive((s) => s.settings?.appearance.theme ?? 'system');
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = pref === 'dark' || (pref === 'system' && mq.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [pref]);
}
