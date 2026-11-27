import type { DesktopControl, DesktopHost, DesktopView } from './desktop';
import { checkDesktopAction } from './desktop';
import type { PcHost } from './pc';

export function musicRequest(text: string, previous?: string): string | null {
  const t = text.trim().replace(/[.!]+$/, '');
  const explicit = /^(?:please\s+|can you\s+|could you\s+)?play\s+(.+?)\s+(?:in|on)\s+spotify$/i.exec(t);
  if (explicit) return explicit[1]!.replace(/^(?:the\s+)?(?:song|track)\s+|\s+(?:song|track)$/gi, '').trim() || null;
  if (
    previous &&
    /^(?:yes[, ]+|okay[, ]+|ok[, ]+)?(?:please\s+)?(?:play(?:\s+(?:it|that|the song|the track|the matching song|the closest match))?|go ahead)$/i.test(
      t,
    )
  )
    return previous;
  return null;
}

export function musicName(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/\(from\b[^)]*\)|\bfrom\s+["“][^"”]*["”]/gi, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .replace(/([aeiou])\1+/g, '$1');
}
export function musicSimilarity(query: string, title: string): number {
  const a = musicName(query),
    b = musicName(title);
  if (!a || !b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const before = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = before;
    }
  }
  return 1 - row[b.length]! / Math.max(a.length, b.length);
}
export interface SongChoice {
  control: DesktopControl;
  title: string;
  score: number;
}
export function songChoices(query: string, view: DesktopView): SongChoice[] {
  const unique = new Map<string, SongChoice>();
  const namedArtist = /^(.+?)\s+by\s+(.+)$/i.exec(query);
  for (const control of view.controls) {
    if (!control.actions.includes('click') || !/^play(?:\s|$)/i.test(control.name)) continue;
    const context = control.context ?? '';
    if (!/^Search results\s*\|/i.test(context) || /(?:^|\|\s*)(?:Playlist|Podcast|Audiobook|Music video|Single|Album)\s*•/i.test(context))
      continue;
    const title = control.name.replace(/^play\s*/i, '').trim() || context.split('|')[1]?.trim() || '';
    if (!title) continue;
    const fullScore = musicSimilarity(query, title);
    const titleScore = namedArtist ? musicSimilarity(namedArtist[1]!, title) : fullScore;
    const artistMatches = !namedArtist || musicName(context).includes(musicName(namedArtist[2]!));
    const score = fullScore >= 0.84 ? fullScore : Math.max(fullScore, titleScore * (artistMatches ? 1 : 0.6));
    const key = musicName(title);
    const choice = { control, title, score };
    if (!unique.has(key) || unique.get(key)!.score < score) unique.set(key, choice);
  }
  return [...unique.values()].sort((a, b) => b.score - a.score);
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });

/** Bounded host-owned continuation: search is never reported as playback. */
async function playSpotifyOnce(query: string, request: string, desktop: DesktopHost, pc: PcHost, signal: AbortSignal): Promise<string> {
  const already = await pc.spotifyPlayback?.().catch(() => null);
  if (already?.playing && musicName(query) === musicName(already.title))
    return `Already playing “${already.title}”${already.artist ? ` by ${already.artist}` : ''}.`;
  let view: DesktopView | undefined;
  let choices: SongChoice[] = [];
  let correctedSearch = false;
  for (let attempt = 0; attempt < 8; attempt++) {
    signal.throwIfAborted();
    view = await desktop.inspect('Spotify', signal);
    const search = view.controls.find(
      (c) => c.actions.includes('type') && /what do you want to play|search/i.test(c.name) && !/address/i.test(c.name),
    );
    choices = songChoices(query, view);
    if (choices[0]?.score && choices[0].score >= 0.84) break;
    if (search && musicName(search.value) !== musicName(query) && !correctedSearch && attempt >= 2) {
      const action = {
        kind: 'app_action' as const,
        target: search.id,
        action: 'type' as const,
        text: query,
      };
      checkDesktopAction(action, view, request);
      try { await desktop.act(view, search, action, signal); } catch(error) { throw new Error((error as Error).message || 'Spotify did not accept the search text. No playback was confirmed.', {cause:error}); }
      correctedSearch = true;
      await wait(500, signal);
      continue;
    }
    choices = songChoices(query, view);
    if (choices[0]?.score && choices[0].score >= 0.84) break;
    if (attempt < 7) await wait(500, signal);
  }
  const best = choices[0];
  if (!view || !best || best.score < 0.72)
    return `I searched Spotify for “${query}”, but couldn't identify a close song match. Tell me a few more words or the artist. Nothing was played.`;
  if (best.score < 0.84 || (choices[1] && best.score - choices[1].score < 0.08))
    return `Which song did you mean? ${choices
      .slice(0, 3)
      .map((c) => `“${c.title}”`)
      .join(', ')}. Nothing was played.`;
  if (already?.playing && musicName(best.title) === musicName(already.title))
    return `Already playing “${already.title}”${already.artist ? ` by ${already.artist}` : ''}.`;
  signal.throwIfAborted();
  const action = {
    kind: 'app_action' as const,
    target: best.control.id,
    action: 'click' as const,
  };
  checkDesktopAction(action, view, request);
  let after: DesktopView = view;
  let actionFailure = '';
  try {
    after = await desktop.act(view, best.control, action, signal);
  } catch (error) {
    actionFailure = (error as Error).message || 'Windows did not return a usable control receipt.';
    if (/The app changed while I was thinking|The app control changed\. Read the app again/i.test(actionFailure)) throw error;
    // Invocation may have succeeded even when its provider fails to return.
    // Check playback; never repeat an action with an unknown outcome.
  }
  for (let i = 0; i < 6; i++) {
    signal.throwIfAborted();
    const playback = await pc.spotifyPlayback?.().catch(() => null);
    if (playback?.playing && musicName(best.title) === musicName(playback.title))
      return `Playing “${playback.title}”${playback.artist ? ` by ${playback.artist}` : ''}.${musicName(query) !== musicName(best.title) ? ' This was the closest matching song.' : ''}`;
    const nowPlaying = after.controls.find((c) => /^Now playing:/i.test(c.name));
    if (
      nowPlaying &&
      musicName(nowPlaying.name).includes(musicName(best.title)) &&
      after.controls.some((c) => /^Pause$/i.test(c.name) && !/^Search results/i.test(c.context ?? ''))
    )
      return `Spotify shows “${best.title}” playing.${musicName(query) !== musicName(best.title) ? ' This was the closest matching song.' : ''}`;
    if (i < 5) {
      await wait(500, signal);
      after = await desktop.inspect('Spotify', signal).catch(() => after);
    }
  }
  return `${actionFailure ? 'Requested playback' : 'Pressed Play'} for “${best.title}”, but Spotify hasn't confirmed that it is playing. Check its player or connected device.`;
}


export async function playSpotify(query:string,request:string,desktop:DesktopHost,pc:PcHost,signal:AbortSignal):Promise<string>{
 for(let attempt=0;;attempt++){
  try{return await playSpotifyOnce(query,request,desktop,pc,signal);}
  catch(error){
   signal.throwIfAborted();
   if(attempt>=3 || !/The app changed while I was thinking|The app control changed\. Read the app again/i.test((error as Error).message))throw error;
   await wait(500,signal);
  }
 }
}
