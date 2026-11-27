import { useState } from 'react';
import { cx } from '@hirora/ui';
import { PageHeader } from '../App';
import { Knowledge } from './Knowledge';
import { Profiles } from './Profiles';

const TABS = ['Profile', 'Documents'] as const;
type Tab = (typeof TABS)[number];

/** Interview and meeting prep in one place: who you are, and the documents answers draw on. */
export function Prep({ initial = 'Profile' }: { initial?: Tab }) {
  const [tab, setTab] = useState<Tab>(initial);
  return (
    <>
      <PageHeader light="Your" bold="prep" sub="Who you are and the documents answers draw on. Stored on this PC." />
      <div className="dash-tabs" role="tablist" aria-label="Prep sections">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={cx('dash-tab', tab === t && 'is-active')} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {tab === 'Profile' ? <Profiles bare /> : <Knowledge bare />}
    </>
  );
}
