import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgent } from './agent';
import type { FileAction, LocalPlanner } from './agent';
import { isAdminApp, isExecutable, matchApps, searchTerms, whatsappUri } from './pc';
import type { InstalledApp, PcHost } from './pc';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs.length = 0;
});

const APPS: InstalledApp[] = [
  { name: 'Spotify', id: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
  { name: 'WhatsApp', id: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App' },
  { name: 'Notepad', id: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App' },
  { name: 'Windows PowerShell', id: '{1AC14E77}\\WindowsPowerShell\\v1.0\\powershell.exe' },
  { name: 'Microsoft Teams', id: 'MSTeams_8wekyb3d8bbwe!MSTeams' },
  { name: 'Microsoft Teams (work)', id: 'MSTeamsWork' },
];

function fakeHost(over: Partial<PcHost> = {}) {
  const calls: string[] = [];
  const host: PcHost = {
    findFiles: async () => [],
    openPath: async (p) => void calls.push(`open ${p}`),
    revealPath: (p) => void calls.push(`reveal ${p}`),
    listApps: async () => APPS,
    launchApp: async (a) => void calls.push(`launch ${a.name}`),
    media: async (c) => void calls.push(`media ${c}`),
    setVolume: async (l) => (calls.push(`volume ${l}`), l),
    setBrightness: async (l) => (calls.push(`brightness ${l}`), l),
    setDarkMode: async (on) => (calls.push(`dark ${on}`), on),
    openUri: async (u) => void calls.push(`uri ${u}`),
    ...over,
  };
  return { host, calls };
}
/** A planner that takes the given steps, then says done. */
const steps = (...actions: FileAction[]): LocalPlanner => async (_t, ctx) => actions[ctx.recent.length] ?? { kind: 'done', text: 'Done (model text, not shown).' };
async function run(agent: LocalAgent, text: string) {
  agent.send(text);
  await vi.waitFor(() => expect(agent.status().busy).toBe(false));
  return agent.status().messages.at(-1)?.text ?? '';
}

it('keeps search text, app names and WhatsApp links safe', () => {
  expect(searchTerms("where is my 'resume'; DROP TABLE file.pdf")).toEqual(['resume', 'DROP', 'TABLE', 'file.pdf']);
  expect(searchTerms('the file')).toEqual([]);
  expect(matchApps('spotify app', APPS).map((a) => a.name)).toEqual(['Spotify']);
  expect(matchApps('teams', APPS).map((a) => a.name)).toEqual(['Microsoft Teams', 'Microsoft Teams (work)']);
  expect(matchApps('zzz', APPS)).toEqual([]);
  expect(isAdminApp('Windows PowerShell')).toBe(true);
  expect(isAdminApp('Spotify')).toBe(false);
  expect(isExecutable('C:\\x\\setup.EXE')).toBe(true);
  expect(isExecutable('C:\\x\\notes.pdf')).toBe(false);
  expect(whatsappUri('+91 98765-43210', 'Hi, running late & sorry')).toBe('whatsapp://send?phone=919876543210&text=Hi%2C%20running%20late%20%26%20sorry');
  expect(whatsappUri('Mom', 'hi')).toBeNull();
  expect(whatsappUri('123', 'hi')).toBeNull();
});

it('finds files anywhere, then opens only what it found; programs are shown, not run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'doing-pc-'));
  dirs.push(dir);
  const doc = join(dir, 'Quarterly report.pdf');
  const exe = join(dir, 'setup.exe');
  await writeFile(doc, 'x');
  await writeFile(exe, 'x');
  const { host, calls } = fakeHost({ findFiles: async () => [{ path: doc, size: 1, modified: null }, { path: exe, size: 1, modified: null }] });
  const agent = new LocalAgent(steps({ kind: 'find_files', query: 'quarterly report' }, { kind: 'open_found', path: doc, reveal: false }), undefined, host);
  const reply = await run(agent, 'Find my quarterly report and open it');
  expect(reply).toContain('Found 2 files');
  expect(reply).toContain(`Opened \`${doc}\`.`);
  expect(calls).toEqual([`open ${doc}`]);
  // A found program is shown in File Explorer, never run.
  const a2 = new LocalAgent(steps({ kind: 'find_files', query: 'setup' }, { kind: 'open_found', path: exe, reveal: false }), undefined, fakeHost({ findFiles: async () => [{ path: exe, size: 1, modified: null }] }).host);
  expect(await run(a2, 'find setup and open it')).toContain('showed it in File Explorer instead of running it');
  // A path the model made up is refused.
  const a3 = new LocalAgent(steps({ kind: 'open_found', path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', reveal: false }), undefined, host);
  expect(await run(a3, 'open the hosts file')).toContain('only open files I found for you');
});

it('opens apps by name, asks when unsure, and leaves system tools alone', async () => {
  const { host, calls } = fakeHost();
  expect(await run(new LocalAgent(steps({ kind: 'open_app', name: 'spotify' }), undefined, host), 'open spotify')).toBe('Opened Spotify.');
  expect(await run(new LocalAgent(steps({ kind: 'open_app', name: 'teams' }), undefined, host), 'open teams')).toContain('Which one?');
  expect(await run(new LocalAgent(steps({ kind: 'open_app', name: 'powershell' }), undefined, host), 'open powershell')).toContain("I don't open system tools");
  expect(calls).toEqual(['launch Spotify']);
});

it('plays music through Spotify search, sets volume and dark mode, opens Settings pages', async () => {
  const { host, calls } = fakeHost();
  expect(await run(new LocalAgent(steps({ kind: 'play_music', query: 'Blinding Lights The Weeknd' }), undefined, host), 'play blinding lights')).toContain('Opened Spotify search');
  expect(await run(new LocalAgent(steps({ kind: 'volume', level: 30 }), undefined, host), 'volume 30')).toBe('Volume set to 30%.');
  expect(await run(new LocalAgent(steps({ kind: 'dark_mode', on: true }), undefined, host), 'dark mode on')).toBe('Dark mode is on.');
  expect(await run(new LocalAgent(steps({ kind: 'open_settings', page: 'bluetooth' }), undefined, host), 'turn on bluetooth')).toContain('Opened Settings → bluetooth');
  expect(calls).toEqual(['uri spotify:search:Blinding%20Lights%20The%20Weeknd', 'volume 30', 'dark true', 'uri ms-settings:bluetooth']);
});

it('drafts WhatsApp messages for the user to send, and asks for a number instead of guessing', async () => {
  const { host, calls } = fakeHost();
  const reply = await run(new LocalAgent(steps({ kind: 'whatsapp', phone: '+44 7700 900123', text: 'On my way' }), undefined, host), 'whatsapp +44 7700 900123 on my way');
  expect(reply).toContain('press Enter to send');
  expect(calls).toEqual(['uri whatsapp://send?phone=447700900123&text=On%20my%20way']);
  expect(await run(new LocalAgent(steps({ kind: 'whatsapp', phone: '', text: 'hi' }), undefined, host), 'whatsapp mom hi')).toContain('country code');
  expect(calls).toHaveLength(1);
});

it('stops a model that repeats the same action', async () => {
  const { host, calls } = fakeHost();
  const agent = new LocalAgent(async () => ({ kind: 'media', command: 'next' }), undefined, host);
  await run(agent, 'next song');
  expect(calls).toEqual(['media next', 'media next']);
});

it('points clear requests at the right PC action', async () => {
  const { pcHint } = await import('./planner');
  expect(pcHint('where is my VitaSense deep dive file?')).toMatch(/find_files/);
  expect(pcHint('find report.pdf')).toMatch(/find_files/);
  expect(pcHint('open calculator')).toMatch(/open_app/);
  expect(pcHint('turn on bluetooth')).toMatch(/open_settings/);
  expect(pcHint('show it in the folder')).toMatch(/reveal true/);
  expect(pcHint('set the volume to 40')).toBeNull();
  expect(pcHint('open notes.txt')).toBeNull();
  expect(pcHint('what is the capital of France?')).toBeNull();
});

it('searches straight away for plain find requests', async () => {
  const { directFind } = await import('./pc');
  expect(directFind('find my resume')).toBe('resume');
  expect(directFind('where is my VitaSense deep dive file?')).toBe('VitaSense deep dive');
  expect(directFind('find report.pdf and open it')).toBe('report.pdf');
  expect(directFind('where is the meeting tomorrow?')).toBeNull();
  expect(directFind('find a good restaurant')).toBeNull();
  const { host } = fakeHost({ findFiles: async (q) => [{ path: `C:\\Users\\x\\${q}.pdf`, size: 1, modified: null }] });
  const asked: number[] = [];
  const agent = new LocalAgent(async (_t, ctx) => (asked.push(ctx.recent.length), { kind: 'done', text: 'model text' }), undefined, host);
  agent.send('find my resume');
  await vi.waitFor(() => expect(agent.status().busy).toBe(false));
  expect(agent.status().messages.at(-1)?.text).toContain('Found this file');
  expect(asked).toEqual([]); // a plain find replies at once, without the model
  agent.send('find my resume and open it');
  await vi.waitFor(() => expect(agent.status().busy).toBe(false));
  expect(asked).toEqual([1]); // with a follow-up, the model picks the next step
});

it('opens installed apps straight away and refuses system tools without asking the model', async () => {
  const { directOpen } = await import('./pc');
  expect(directOpen('open spotify')).toBe('spotify');
  expect(directOpen('launch the calculator app')).toBe('calculator');
  expect(directOpen('open notes.txt')).toBeNull();
  expect(directOpen('open the website')).toBeNull();
  const { host, calls } = fakeHost();
  const asked: number[] = [];
  const planner: LocalPlanner = async (_t, ctx) => (asked.push(ctx.recent.length), { kind: 'done', text: 'x' });
  expect(await run(new LocalAgent(planner, undefined, host), 'open spotify')).toBe('Opened Spotify.');
  expect(await run(new LocalAgent(planner, undefined, host), 'open powershell')).toContain("I don't open system tools");
  expect(calls).toEqual(['launch Spotify']);
  expect(asked).toEqual([]);
  // A model that pastes its action into an answer doesn't show the raw JSON.
  expect(await run(new LocalAgent(async () => ({ kind: 'answer', text: 'Sure. {"kind":"open_app","name":"X"}' }), undefined, host), 'hello')).toBe('Sure.');
});
