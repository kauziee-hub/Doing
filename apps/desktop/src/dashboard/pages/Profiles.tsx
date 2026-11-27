import { useEffect, useState } from 'react';
import { Plus, Save, Trash2, CheckCircle2 } from 'lucide-react';
import type { PersonalProfile, ProjectCard, SessionProfile } from '@hirora/contracts';
import { Badge, Button, Card, EmptyState, Field } from '@hirora/ui';
import { invoke } from '../../shared/api';
import { PageHeader } from '../App';
import { useLive } from '../../shared/store';

const emptyCard = (): ProjectCard => ({
  id: '',
  title: '',
  role: '',
  technologies: [],
  outcomes: '',
  evidence: '',
  star: { situation: '', task: '', action: '', result: '' },
  visibility: 'use_in_answers',
  updatedAt: 0,
});

const emptySession = (): SessionProfile => ({
  id: '',
  name: '',
  company: '',
  role: '',
  interviewType: '',
  jobDescription: '',
  companyNotes: '',
  tone: '',
  answerLength: '',
  technicalDepth: '',
  mode: null,
  allowedResources: '',
  updatedAt: 0,
});

export function Profiles({ bare = false }: { bare?: boolean } = {}) {
  const toast = useLive((s) => s.toast);
  const refreshSettings = useLive((s) => s.refreshSettings);
  const [profile, setProfile] = useState<PersonalProfile | null>(null);
  const [cards, setCards] = useState<ProjectCard[]>([]);
  const [card, setCard] = useState<ProjectCard | null>(null);
  const [sessions, setSessions] = useState<{ profiles: SessionProfile[]; activeId: string | null }>({ profiles: [], activeId: null });
  const [session, setSession] = useState<SessionProfile | null>(null);

  useEffect(() => {
    void invoke('profile:get').then(setProfile);
    void invoke('cards:list').then(setCards);
    void invoke('sessionProfiles:list').then(setSessions);
  }, []);

  return (
    <>
      {bare ? null : <PageHeader light="Your" bold="profiles" sub="Used for answers about you and for each company or meeting." />}
      <div className="dash-cols">
        <div>
          <Card title="Personal profile" actions={<Button variant="primary" size="sm" icon={<Save size={13} />} onClick={async () => { if (profile) { setProfile(await invoke('profile:set', profile)); toast('info', 'Profile saved and indexed'); } }}>Save</Button>}>
            {profile ? (
              <>
                <div className="vc-grid2">
                  <Field label="Full name"><input className="vc-input" value={profile.fullName} onChange={(e) => setProfile({ ...profile, fullName: e.target.value })} /></Field>
                  <Field label="Headline"><input className="vc-input" value={profile.headline} placeholder="e.g. Backend engineer, 6 years, payments" onChange={(e) => setProfile({ ...profile, headline: e.target.value })} /></Field>
                </div>
                <Field label="Summary" hint="Facts only — the answer engine treats this as evidence about you."><textarea className="vc-textarea" value={profile.summary} onChange={(e) => setProfile({ ...profile, summary: e.target.value })} /></Field>
                <Field label="Skills (comma-separated)"><input className="vc-input" value={profile.skills.join(', ')} onChange={(e) => setProfile({ ...profile, skills: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></Field>
                <Field label="Speaking style"><input className="vc-input" placeholder="e.g. plain English, short sentences, light humour" value={profile.speakingStyle} onChange={(e) => setProfile({ ...profile, speakingStyle: e.target.value })} /></Field>
              </>
            ) : null}
          </Card>

          <Card title={`Project cards (${cards.length})`} actions={<Button size="sm" icon={<Plus size={13} />} onClick={() => setCard(emptyCard())}>New card</Button>}>
            {cards.length === 0 && !card ? <EmptyState title="No project cards">Reusable STAR stories with measurable outcomes and evidence. Private cards are never put into prompts.</EmptyState> : null}
            {cards.map((c) => (
              <div key={c.id} className="dash-check">
                <div className="dash-check__body">
                  <div className="dash-check__title">{c.title} {c.visibility === 'private' ? <Badge>private</Badge> : <Badge tone="ok">used in answers</Badge>}</div>
                  <div className="dash-check__desc">{[c.role, c.technologies.join(', ')].filter(Boolean).join(' · ')}</div>
                </div>
                <Button size="sm" onClick={() => setCard(c)}>Edit</Button>
                <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} aria-label={`Delete ${c.title}`} onClick={async () => { if (confirm(`Delete card “${c.title}”?`)) setCards(await invoke('cards:delete', { id: c.id })); }} />
              </div>
            ))}
            {card ? (
              <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                <div className="vc-grid2">
                  <Field label="Project title"><input className="vc-input" value={card.title} onChange={(e) => setCard({ ...card, title: e.target.value })} /></Field>
                  <Field label="Your role"><input className="vc-input" value={card.role} onChange={(e) => setCard({ ...card, role: e.target.value })} /></Field>
                </div>
                <Field label="Technologies (comma-separated)"><input className="vc-input" value={card.technologies.join(', ')} onChange={(e) => setCard({ ...card, technologies: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></Field>
                <Field label="Measurable outcomes" hint="Only numbers you can back up."><textarea className="vc-textarea" value={card.outcomes} onChange={(e) => setCard({ ...card, outcomes: e.target.value })} /></Field>
                <Field label="Evidence / links"><input className="vc-input" value={card.evidence} onChange={(e) => setCard({ ...card, evidence: e.target.value })} /></Field>
                <div className="vc-grid2">
                  {(['situation', 'task', 'action', 'result'] as const).map((k) => (
                    <Field key={k} label={k[0]!.toUpperCase() + k.slice(1)}><textarea className="vc-textarea" value={card.star[k]} onChange={(e) => setCard({ ...card, star: { ...card.star, [k]: e.target.value } })} /></Field>
                  ))}
                </div>
                <Field label="Visibility">
                  <select className="vc-select" value={card.visibility} onChange={(e) => setCard({ ...card, visibility: e.target.value as ProjectCard['visibility'] })}>
                    <option value="use_in_answers">Use in answers</option>
                    <option value="private">Private (never put into prompts)</option>
                  </select>
                </Field>
                <div className="vc-row">
                  <Button variant="primary" disabled={!card.title.trim()} onClick={async () => { setCards(await invoke('cards:upsert', card)); setCard(null); }}>Save card</Button>
                  <Button variant="ghost" onClick={() => setCard(null)}>Cancel</Button>
                </div>
              </div>
            ) : null}
          </Card>
        </div>

        <div>
          <Card title="Company / job profiles" actions={<Button size="sm" icon={<Plus size={13} />} onClick={() => setSession(emptySession())}>New</Button>}>
            <div className="dash-check">
              <div className="dash-check__body"><div className="dash-check__title">No profile</div><div className="dash-check__desc">Generic answers.</div></div>
              {sessions.activeId === null ? <Badge tone="ok"><CheckCircle2 size={11} /> active</Badge> : <Button size="sm" onClick={async () => { setSessions(await invoke('sessionProfiles:setActive', { id: null })); await refreshSettings(); }}>Use</Button>}
            </div>
            {sessions.profiles.map((p) => (
              <div key={p.id} className="dash-check">
                <div className="dash-check__body">
                  <div className="dash-check__title">{p.name}</div>
                  <div className="dash-check__desc">{[p.company, p.role, p.interviewType].filter(Boolean).join(' · ')}</div>
                </div>
                {sessions.activeId === p.id ? <Badge tone="ok"><CheckCircle2 size={11} /> active</Badge> : <Button size="sm" onClick={async () => { setSessions(await invoke('sessionProfiles:setActive', { id: p.id })); await refreshSettings(); }}>Use</Button>}
                <Button size="sm" onClick={() => setSession(p)}>Edit</Button>
                <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} aria-label={`Delete ${p.name}`} onClick={async () => { if (confirm(`Delete profile “${p.name}”?`)) setSessions(await invoke('sessionProfiles:delete', { id: p.id })); }} />
              </div>
            ))}
          </Card>
          {session ? (
            <Card title={session.id ? 'Edit profile' : 'New profile'}>
              <Field label="Profile name"><input className="vc-input" value={session.name} placeholder="e.g. Acme — Senior Backend, round 2" onChange={(e) => setSession({ ...session, name: e.target.value })} /></Field>
              <div className="vc-grid2">
                <Field label="Company"><input className="vc-input" value={session.company} onChange={(e) => setSession({ ...session, company: e.target.value })} /></Field>
                <Field label="Role"><input className="vc-input" value={session.role} onChange={(e) => setSession({ ...session, role: e.target.value })} /></Field>
                <Field label="Interview / meeting type"><input className="vc-input" value={session.interviewType} placeholder="system design, behavioural, standup…" onChange={(e) => setSession({ ...session, interviewType: e.target.value })} /></Field>
                <Field label="Desired tone"><input className="vc-input" value={session.tone} onChange={(e) => setSession({ ...session, tone: e.target.value })} /></Field>
                <Field label="Allowed resources / rules"><input className="vc-input" value={session.allowedResources} placeholder="e.g. practice only; notes allowed" onChange={(e) => setSession({ ...session, allowedResources: e.target.value })} /></Field>
              </div>
              <Field label="Job description" hint="Indexed as company/job evidence."><textarea className="vc-textarea" value={session.jobDescription} onChange={(e) => setSession({ ...session, jobDescription: e.target.value })} /></Field>
              <Field label="Company notes" hint="Your own research. Doing will not invent company facts."><textarea className="vc-textarea" value={session.companyNotes} onChange={(e) => setSession({ ...session, companyNotes: e.target.value })} /></Field>
              <div className="vc-row">
                <Button variant="primary" disabled={!session.name.trim()} onClick={async () => { setSessions(await invoke('sessionProfiles:upsert', session)); setSession(null); }}>Save profile</Button>
                <Button variant="ghost" onClick={() => setSession(null)}>Cancel</Button>
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
