import { expect, it, vi } from 'vitest';
import { LocalAgent } from './agent';
import { musicRequest, musicSimilarity, playSpotify, songChoices } from './music';
import type { DesktopHost, DesktopView } from './desktop';
import type { PcHost } from './pc';

const view: DesktopView = {
  handle: '12',
  processId: 1,
  process: 'Spotify',
  title: 'Spotify Premium',
  controls: [
    {
      id: 'old-player',
      name: 'Play',
      value: '',
      type: 'Button',
      actions: ['click'],
    },
    {
      id: 'playlist',
      name: 'Play Blue Sky',
      value: '',
      type: 'Button',
      actions: ['click'],
      context: 'Search results | Blue Sky | Playlist • Example',
    },
    {
      id: 'track',
      name: 'Play Blue Sky',
      value: '',
      type: 'Button',
      actions: ['click'],
      context: 'Search results | Blue Sky | Song • Example Artist',
    },
  ],
};
const signal = () => new AbortController().signal;
it('understands named-song requests and follow-ups without repeating the planner search loop', () => {
  expect(musicRequest('Play bum ba diga diga in Spotify')).toBe('bum ba diga diga');
  expect(musicRequest('play bum ba diga diga song in spotify')).toBe('bum ba diga diga');
  expect(musicRequest('yes play the song', 'Blue Sky')).toBe('Blue Sky');
  expect(musicRequest('yes play the song')).toBeNull();
  expect(musicRequest('play chess')).toBeNull();
  expect(musicSimilarity('bum ba diga diga', 'Bum Baa Diga Diga (From "Example")')).toBe(1);
  expect(musicSimilarity('Blnding Lights', 'Blinding Lights')).toBeGreaterThan(0.9);
});
it('matches song buttons using row context and excludes global player/playlist buttons', () => {
  expect(songChoices('blu sky', view).map((c) => c.control.id)).toEqual(['track']);
  expect(songChoices('Blue Sky by Example Artist', view)[0]?.score).toBe(1);
  expect(songChoices('Blue Sky by Another Artist', view)[0]?.score).toBeLessThan(0.72);
});
it('plays a clear close match and reports success only after playback is confirmed', async () => {
  let playing = false;
  const pc = {
    spotifyPlayback: async () => ({
      title: 'Blue Sky',
      artist: 'Example Artist',
      playing,
    }),
  } as PcHost;
  const desktop: DesktopHost = {
    inspect: vi.fn(async () => view),
    act: vi.fn(async () => {
      playing = true;
      return view;
    }),
  };
  expect(await playSpotify('blu sky', 'play blu sky in Spotify', desktop, pc, signal())).toContain('Playing “Blue Sky” by Example Artist.');
  expect(desktop.act).toHaveBeenCalledWith(
    view,
    view.controls[2],
    expect.objectContaining({ target: 'track', action: 'click' }),
    expect.anything(),
  );
});
it('asks about ambiguous names and never clicks the first arbitrary result', async () => {
  const candidates = {
    ...view,
    controls: [
      {
        ...view.controls[2]!,
        id: 'one',
        name: 'Play Blue Sky',
        context: 'Search results | Blue Sky | Song • First Artist',
      },
      {
        ...view.controls[2]!,
        id: 'two',
        name: 'Play Blue Skiy',
        context: 'Search results | Blue Skiy | Song • Other Artist',
      },
    ],
  };
  const desktop = { inspect: vi.fn(async () => candidates), act: vi.fn() };
  expect(await playSpotify('blue ski', 'play blue ski', desktop, {} as PcHost, signal())).toContain('Which song did you mean?');
  expect(desktop.act).not.toHaveBeenCalled();
});
it('does not reinterpret global Play as the requested song or claim an unconfirmed start', async () => {
  const desktop = {
    inspect: vi.fn(async () => view),
    act: vi.fn(async () => view),
  };
  const pc = {
    spotifyPlayback: async () => ({
      title: 'Unrelated song',
      artist: 'Other Artist',
      playing: true,
    }),
  } as PcHost;
  vi.useFakeTimers();
  try {
    const result = playSpotify('Blue Sky', 'play Blue Sky', desktop, pc, signal());
    await vi.runAllTimersAsync();
    expect(await result).toContain("hasn't confirmed");
    expect(desktop.act).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
it('hands search straight to the native music workflow and keeps yes-play context', async () => {
  let playing = false;
  const plan = vi.fn(async () => ({
    kind: 'play_music' as const,
    query: 'wrong repeated search',
  }));
  const pc = {
    listApps: async () => [{ name: 'Spotify', id: 'spotify' }],
    openUri: vi.fn(async () => {}),
    spotifyPlayback: async () => ({
      title: 'Blue Sky',
      artist: 'Example Artist',
      playing,
    }),
  } as unknown as PcHost;
  const desktop = {
    inspect: vi.fn(async () => view),
    act: vi.fn(async () => {
      playing = true;
      return view;
    }),
  };
  const agent = new LocalAgent(plan, undefined, pc, desktop);
  agent.desktopAccess(true);
  agent.send('Play blu sky in Spotify');
  await vi.waitFor(() => expect(agent.status().busy).toBe(false));
  expect(agent.status().messages.at(-1)?.text).toContain('Playing “Blue Sky”');
  agent.send('yes play the song');
  await vi.waitFor(() => expect(agent.status().busy).toBe(false));
  expect(agent.status().messages.at(-1)?.text).toContain('Already playing');
  expect(plan).not.toHaveBeenCalled();
  expect(desktop.act).toHaveBeenCalledOnce();
  expect(agent.status().messages.at(-1)?.text).not.toContain('Read Spotify');
});


it('verifies playback after an uncertain invocation without issuing a duplicate click',async()=>{
 let playing=false;const pc={spotifyPlayback:async()=>({title:'Blue Sky',artist:'Example Artist',playing})} as PcHost;
 const desktop={inspect:vi.fn(async()=>view),act:vi.fn(async()=>{playing=true;throw new Error('Provider did not return');})};
 expect(await playSpotify('Blue Sky','play Blue Sky',desktop,pc,signal())).toContain('Playing “Blue Sky”');
 expect(desktop.act).toHaveBeenCalledOnce();
});
