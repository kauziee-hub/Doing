import { randomUUID, createHash } from 'node:crypto';
import { lstat, realpath, readdir, readFile, writeFile, mkdir, rename, unlink, rmdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, extname } from 'node:path';
import { z } from 'zod';
import type { LocalStatus, LocalMessage } from '@doing/contracts';
import { SETTINGS_PAGES, directFind, directOpen, isAdminApp, isExecutable, matchApps, whatsappUri } from './pc';
import type { PcHost, SettingsPage } from './pc';

export const FileActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('answer'), text: z.string().min(1).max(16000) }),
  z.object({ kind: z.literal('done'), text: z.string().min(1).max(3000) }),
  z.object({ kind: z.literal('list'), path: z.string().max(500) }),
  z.object({ kind: z.literal('read'), path: z.string().min(1).max(500) }),
  z.object({
    kind: z.literal('write'),
    path: z.string().min(1).max(500),
    text: z.string().max(60000),
  }),
  z.object({ kind: z.literal('delete'), path: z.string().min(1).max(500) }),
  z.object({ kind: z.literal('mkdir'), path: z.string().min(1).max(500) }),
  z.object({
    kind: z.literal('move'),
    path: z.string().min(1).max(500),
    destination: z.string().min(1).max(500),
  }),
  // PC-wide actions (0.5.2): fixed host code, no folder permission needed.
  z.object({ kind: z.literal('find_files'), query: z.string().min(1).max(120) }),
  z.object({ kind: z.literal('open_found'), path: z.string().min(1).max(500), reveal: z.boolean() }),
  z.object({ kind: z.literal('open_app'), name: z.string().min(1).max(80) }),
  z.object({ kind: z.literal('media'), command: z.enum(['play_pause', 'next', 'previous', 'volume_up', 'volume_down', 'mute']) }),
  z.object({ kind: z.literal('play_music'), query: z.string().min(1).max(120) }),
  z.object({ kind: z.literal('volume'), level: z.number().int().min(0).max(100) }),
  z.object({ kind: z.literal('brightness'), level: z.number().int().min(0).max(100) }),
  z.object({ kind: z.literal('dark_mode'), on: z.boolean() }),
  z.object({ kind: z.literal('open_settings'), page: z.enum(Object.keys(SETTINGS_PAGES) as [SettingsPage, ...SettingsPage[]]) }),
  z.object({ kind: z.literal('whatsapp'), phone: z.string().max(20), text: z.string().min(1).max(2000) }),
]);
const PC_KINDS = new Set(['find_files', 'open_found', 'open_app', 'media', 'play_music', 'volume', 'brightness', 'dark_mode', 'open_settings', 'whatsapp']);
type PcAction = Extract<z.infer<typeof FileActionSchema>, { kind: 'find_files' | 'open_found' | 'open_app' | 'media' | 'play_music' | 'volume' | 'brightness' | 'dark_mode' | 'open_settings' | 'whatsapp' }>;
const isPcAction = (a: z.infer<typeof FileActionSchema>): a is PcAction => PC_KINDS.has(a.kind);
const MEDIA_DONE: Record<string, string> = { play_pause: 'Pressed play/pause.', next: 'Skipped to the next track.', previous: 'Went back to the previous track.', volume_up: 'Turned the volume up.', volume_down: 'Turned the volume down.', mute: 'Toggled mute.' };
export type FileAction = z.infer<typeof FileActionSchema>;
export type LocalPlanner = (
  text: string,
  context: {
    folder: boolean;
    history: LocalMessage[];
    observation: string;
    recent: string[];
  },
  signal: AbortSignal,
) => Promise<FileAction>;
type Undo =
  | { kind: 'write'; path: string; before: string | null; after: string }
  | { kind: 'move'; path: string; destination: string; identity: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'trash'; path: string };
const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.tsv',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.html',
  '.css',
  '.py',
  '.rs',
  '.yaml',
  '.yml',
  '.xml',
  '.log',
  '.sql',
  '.svg',
]);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Files are available only under the folder selected in the native picker. No model shell/code executes. */
export class LocalAgent {
  private root: string | null = null;
  private controller: AbortController | null = null;
  private undoStack: Undo[] = [];
  private pendingDelete: { path: string; identity: string } | null = null;
  /** Paths found by find_files in this conversation: the only places outside the folder Doing may open. */
  private found = new Set<string>();
  private state: LocalStatus = {
    folder: null,
    busy: false,
    message: '',
    messages: [],
    changes: [],
    canUndo: false,
  };
  constructor(
    private readonly plan: LocalPlanner,
    private readonly trash?: (path: string) => Promise<void>,
    private readonly pc?: PcHost,
  ) {}
  status(): LocalStatus {
    return structuredClone({
      ...this.state,
      folder: this.root,
      busy: !!this.controller,
      canUndo: !this.controller && this.undoStack.length > 0 && this.undoStack.at(-1)?.kind !== 'trash',
    });
  }
  async allow(folder: string): Promise<LocalStatus> {
    if (this.controller) throw new Error('Stop the current request before changing folders.');
    const path = await realpath(folder);
    if (!(await lstat(path)).isDirectory()) throw new Error('Choose a folder.');
    this.root = path;
    this.pendingDelete = null;
    this.undoStack = [];
    this.state.messages = [];
    this.state.changes = [];
    this.state.message = 'Folder ready.';
    return this.status();
  }
  revoke(): LocalStatus {
    this.stop();
    this.root = null;
    this.pendingDelete = null;
    this.undoStack = [];
    this.state.changes = [];
    this.state.messages = [];
    return this.status();
  }
  stop(): LocalStatus {
    this.pendingDelete = null;
    if (this.controller && !this.controller.signal.aborted) {
      this.controller.abort();
      this.reply('Stopped. Review completed changes below.');
    }
    this.state.message = 'Stopping…';
    return this.status();
  }
  clear(): LocalStatus {
    this.stop();
    this.found.clear();
    this.state.messages = [];
    this.state.message = '';
    return this.status();
  }
  private reply(text: string): void {
    this.state.messages = [...this.state.messages.slice(-39), { id: randomUUID(), role: 'assistant', text }];
  }
  private async path(name: string): Promise<string> {
    if (!this.root) throw new Error('Choose a folder before asking me to work with files.');
    if ((await realpath(this.root)) !== this.root) throw new Error('The allowed folder changed. Choose it again.');
    if (
      isAbsolute(name) ||
      /[:\x00-\x1f]/.test(name) ||
      name
        .split(/[\\/]/)
        .some(
          (part) =>
            part !== '.' &&
            (part === '..' ||
              /^\.(?:git|env)(?:\.|$)/i.test(part) ||
              /[. ]$/.test(part) ||
              /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
        )
    )
      throw new Error('That path is outside the allowed file scope.');
    const candidate = resolve(this.root, name || '.');
    const rel = relative(this.root, candidate);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('The path must stay inside your allowed folder.');
    let current = this.root;
    for (const component of rel.split(/[\\/]/).filter(Boolean)) {
      current = resolve(current, component);
      const entry = await lstat(current).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
      if (entry?.isSymbolicLink()) throw new Error('Linked folders and files need a separate folder permission.');
    }
    return candidate;
  }
  private async list(name: string): Promise<string> {
    const dir = await this.path(name);
    const entries = await readdir(dir, { withFileTypes: true });
    return JSON.stringify({
      path: name || '.',
      entries: entries
        .filter((e) => !e.name.startsWith('.') && !e.isSymbolicLink())
        .slice(0, 100)
        .map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'folder' : 'file',
        })),
      truncated: entries.length > 100,
    });
  }
  private async read(name: string): Promise<string> {
    if (!TEXT_EXTENSIONS.has(extname(name).toLowerCase()))
      throw new Error(
        'For this task, use a text, code, Markdown, JSON or CSV file. Add PDFs and Word documents in Library for questions about their contents.',
      );
    const path = await this.path(name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 60000) throw new Error('Choose a text file smaller than 60 KB.');
    return readFile(path, 'utf8');
  }
  async undo(): Promise<LocalStatus> {
    if (this.controller) throw new Error('Stop the task before undoing a change.');
    const entry = this.undoStack.at(-1);
    if (!entry) return this.status();
    if (entry.kind === 'trash') throw new Error('Restore this item from the Windows Recycle Bin.');
    if (entry.kind === 'write') {
      const path = await this.path(entry.path);
      if (digest(await readFile(path, 'utf8')) !== entry.after)
        throw new Error('This file changed outside Doing. Undo was stopped to preserve those changes.');
      if (entry.before === null) await unlink(path);
      else await writeFile(path, entry.before, 'utf8');
    } else if (entry.kind === 'move') {
      const original = await this.path(entry.path);
      const destination = await this.path(entry.destination);
      const stat = await lstat(destination);
      if (`${stat.dev}:${stat.ino}` !== entry.identity)
        throw new Error('The moved item was replaced outside Doing. Undo was stopped to preserve it.');
      if (
        await lstat(original).then(
          () => true,
          () => false,
        )
      )
        throw new Error('The original location is now occupied.');
      await rename(destination, original);
    } else await rmdir(await this.path(entry.path));
    this.undoStack.pop();
    this.state.changes.pop();
    this.reply('Undid the last file change.');
    return this.status();
  }
  /** Runs one PC-wide action and returns what actually happened (the reply is built from this, not from the model). */
  private async runPc(action: PcAction, signal: AbortSignal): Promise<string> {
    const pc = this.pc;
    if (!pc) throw new Error('PC actions are unavailable in this build.');
    signal.throwIfAborted();
    switch (action.kind) {
      case 'find_files': {
        const files = await pc.findFiles(action.query);
        for (const f of files) this.found.add(f.path.toLowerCase());
        if (!files.length) return `I couldn't find a file matching “${action.query}”. I searched Windows Search and your Desktop, Documents, Downloads, Pictures, Music, Videos and OneDrive folders.`;
        const shown = files.slice(0, 10).map((f) => `- \`${f.path}\``).join('\n');
        return `Found ${files.length === 1 ? 'this file' : `${files.length} files`} matching “${action.query}”:\n${shown}${files.length > 10 ? `\n…and ${files.length - 10} more.` : ''}`;
      }
      case 'open_found': {
        const target = resolve(action.path);
        const rel = this.root ? relative(this.root, target) : '..';
        const inFolder = isAbsolute(action.path) && !rel.startsWith('..') && !isAbsolute(rel);
        if (!this.found.has(action.path.toLowerCase()) && !inFolder) throw new Error('I can only open files I found for you in this chat. Ask me to find it first.');
        await lstat(target).catch(() => {
          throw new Error('That file is no longer there.');
        });
        if (action.reveal || isExecutable(target)) {
          pc.revealPath(target);
          return action.reveal ? `Showed \`${target}\` in File Explorer.` : `\`${target}\` is a program or shortcut, so I showed it in File Explorer instead of running it.`;
        }
        await pc.openPath(target);
        return `Opened \`${target}\`.`;
      }
      case 'open_app': {
        if (isAdminApp(action.name)) throw new Error(`I don't open system tools like “${action.name}”. Open it from the Start menu if you need it.`);
        const matches = matchApps(action.name, await pc.listApps()).filter((a) => !isAdminApp(a.name));
        if (!matches.length) return `I couldn't find an installed app called “${action.name}”.`;
        if (matches.length > 1) return `Which one? ${matches.map((a) => `“${a.name}”`).join(', ')}.`;
        await pc.launchApp(matches[0]!);
        return `Opened ${matches[0]!.name}.`;
      }
      case 'media':
        await pc.media(action.command);
        return MEDIA_DONE[action.command]!;
      case 'play_music': {
        const spotify = matchApps('Spotify', await pc.listApps())[0];
        const q = encodeURIComponent(action.query);
        if (spotify) {
          await pc.openUri(`spotify:search:${q}`);
          return `Opened Spotify and searched for “${action.query}”. Press play on the song you want; Doing can't start a specific track.`;
        }
        await pc.openUri(`https://open.spotify.com/search/${q}`);
        return `Spotify isn't installed, so I opened its web search for “${action.query}” in your browser.`;
      }
      case 'volume': {
        const now = await pc.setVolume(action.level);
        return `Volume set to ${now}%.`;
      }
      case 'brightness': {
        const now = await pc.setBrightness(action.level).catch(() => {
          throw new Error("Windows can't change this screen's brightness (external monitors usually can't).");
        });
        return `Brightness set to ${now}%.`;
      }
      case 'dark_mode': {
        const on = await pc.setDarkMode(action.on);
        if (on !== action.on) throw new Error('Windows did not apply the theme change.');
        return `Dark mode is ${on ? 'on' : 'off'}.`;
      }
      case 'open_settings':
        await pc.openUri(SETTINGS_PAGES[action.page]);
        return `Opened Settings → ${action.page.replace(/_/g, ' ')}. Change it there.`;
      case 'whatsapp': {
        if (!matchApps('WhatsApp', await pc.listApps()).length) return "WhatsApp isn't installed on this PC.";
        const uri = whatsappUri(action.phone, action.text);
        if (!uri) return "Tell me their WhatsApp number with the country code (for example +91 98765 43210). WhatsApp doesn't let other apps find contacts by name.";
        await pc.openUri(uri);
        return `Opened WhatsApp with your message to +${action.phone.replace(/\D/g, '')} ready. Check it and press Enter to send; Doing never sends messages itself.`;
      }
    }
  }
  send(text: string): LocalStatus {
    if (this.controller) throw new Error('Stop the current request first.');
    const controller = new AbortController();
    this.controller = controller;
    const history = this.state.messages.slice();
    this.state.messages = [...history.slice(-39), { id: randomUUID(), role: 'user', text }];
    void this.run(text, history, controller);
    return this.status();
  }
  private async run(text: string, history: LocalMessage[], controller: AbortController): Promise<void> {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10 * 60_000)]);
    const recent: string[] = [];
    const observedFiles = new Map<string, string>();
    const confirmed: LocalStatus['changes'] = [];
    const receipts: string[] = [];
    let pcSteps = 0;
    const requestedChange = /\b(?:delete|remove|trash|recycle|move|rename|create|write|edit|append|save|organize|update)\b/i.test(text) || /^(?:yes|yep|ok|okay|do it)\b/i.test(text);
    let completionRetries = 0;
    const approval = this.pendingDelete && /^(?:yes|yep|ok|okay|do it|delete it)(?:[.! ]|$)/i.test(text.trim()) ? this.pendingDelete : null;
    if (!approval) this.pendingDelete = null;
    try {
      let observation = this.root
        ? await this.list('')
        : 'No folder allowed. Answer general questions; ask the user to choose a folder for file work.';
      for (let step = 0; step < 30; step++) {
        signal.throwIfAborted();
        this.state.message = step ? 'Working with your files…' : 'Thinking…';
        // Clear "find …" and "open <installed app>" requests skip the model's first step (it kept asking instead of acting).
        const found = !approval && step === 0 && this.pc ? directFind(text) : null;
        const appName = !approval && step === 0 && this.pc && !found ? directOpen(text) : null;
        const openApp = appName && (isAdminApp(appName) || matchApps(appName, await this.pc!.listApps()).length) ? appName : null;
        const action = FileActionSchema.parse(
          found ? { kind: 'find_files', query: found } : openApp ? { kind: 'open_app', name: openApp } : approval && !recent.length ? {kind:'delete',path:approval.path} : await this.plan(
            text,
            {
              folder: !!this.root,
              history,
              observation,
              recent: recent.slice(-8),
            },
            signal,
          ),
        );
        signal.throwIfAborted();
        if (action.kind === 'answer' || action.kind === 'done') {
          if (receipts.length) {
            const files = confirmed.map((change) => `${change.kind === 'trashed' ? 'Moved to Recycle Bin:' : change.kind === 'created' ? 'Created' : change.kind === 'updated' ? 'Updated' : change.kind === 'folder' ? 'Created folder' : 'Moved'} ${change.path}.`);
            this.reply([...receipts, ...files].join('\n\n'));
          } else if (confirmed.length) {
            this.reply(confirmed.map((change) => `${change.kind === 'trashed' ? 'Moved to Recycle Bin:' : change.kind === 'created' ? 'Created' : change.kind === 'updated' ? 'Updated' : change.kind === 'folder' ? 'Created folder' : 'Moved'} ${change.path}.`).join('\n'));
          } else if (requestedChange && !/^\s*(?:how|why|what|explain|can i)\b/i.test(text) && (/\b(?:delete|remove|trash|recycle|rename|move)\b/i.test(text) || action.kind === 'done' || /\b(?:deleted|removed|created|saved|renamed|updated|moved|completed|done)\b/i.test(action.text))) {
            if (completionRetries++ === 0) { observation = 'No filesystem changes have happened. Do not claim completion. Execute an available tool, or ask a factual clarification. ' + observation; continue; }
            this.reply('No files were changed. I could not complete that request. Tell me the exact file or folder to use.');
          } else this.reply(action.text.replace(/\{\s*"kind"\s*:[^{}]*\}/g, '').trim() || 'Done.');
          return;
        }
        if (isPcAction(action)) {
          const done = await this.runPc(action, signal);
          receipts.push(done);
          if (++pcSteps >= 3 || receipts.filter((r) => r === done).length > 1) {
            this.reply(receipts.join('\n\n'));
            return;
          }
          observation = `RESULT: ${done}\nIf the request needs one more step (for example opening a file you just found), take it. Otherwise reply done.`;
          recent.push(`${action.kind}: ${done.slice(0, 120)}`);
          continue;
        }
        if (action.kind === 'list') observation = await this.list(action.path);
        else if (action.kind === 'read') {
          const content = await this.read(action.path);
          observedFiles.set(action.path, digest(content));
          observation = JSON.stringify({ path: action.path, text: content });
        } else {
          const path = await this.path(action.path);
          if (path === this.root) throw new Error('Choose a file or subfolder, not the allowed folder itself.');
          signal.throwIfAborted();
          if (action.kind === 'delete') {
            if (!this.trash) throw new Error('Moving items to the Recycle Bin is unavailable. Nothing was deleted.');
            const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') throw new Error(`Could not find “${action.path}”. Nothing was deleted.`); throw error; });
            const identity = `${info.dev}:${info.ino}`;
            const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
            const explicit = /\b(?:delete|remove|trash|recycle)\b/i.test(text) && !/\b(?:line|paragraph|sentence|word|character)\b/i.test(text) && normalize(action.path).length > 0 && normalize(text).includes(normalize(action.path));
            if (!approval && !/\b(?:delete|remove|trash|recycle)\b/i.test(text)) throw new Error('Specify the file or folder you want moved to the Recycle Bin. Nothing was deleted.');
            if (!explicit && !approval) { this.pendingDelete = { path: action.path, identity }; this.reply(`I found “${action.path}”. Move this ${info.isDirectory() ? 'folder' : 'file'} to the Recycle Bin?`); return; }
            if (approval && (approval.path !== action.path || approval.identity !== identity)) throw new Error('The item changed since confirmation. Nothing was deleted.');
            signal.throwIfAborted();
            await this.path(action.path);
            await this.trash(path);
            const remains = await lstat(path).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
            if (remains) throw new Error('Windows did not move the item to the Recycle Bin. Nothing was confirmed deleted.');
            this.pendingDelete = null;
            this.undoStack.push({kind:'trash',path:action.path});
            this.state.changes.push({path:action.path,kind:'trashed'});
          } else if (action.kind === 'write') {
            if (!TEXT_EXTENSIONS.has(extname(action.path).toLowerCase()))
              throw new Error('Create a text, Markdown, JSON, CSV or code file.');
            const before = await lstat(path).then(
              () => this.read(action.path),
              (e: NodeJS.ErrnoException) => {
                if (e.code === 'ENOENT') return null;
                throw e;
              },
            );
            if (before !== null && (await lstat(path)).nlink > 1)
              throw new Error('This file has linked copies. Make a separate copy before editing it.');
            if (before !== null && !observedFiles.has(action.path)) {
              observedFiles.set(action.path, digest(before));
              observation = JSON.stringify({
                path: action.path,
                text: before,
                notice: 'Read before editing. Preserve all content unrelated to the requested change.',
              });
              recent.push(`read: ${action.path}`);
              continue;
            }
            if (before !== null && observedFiles.has(action.path) && observedFiles.get(action.path) !== digest(before))
              throw new Error('The file changed while I was reading it. Ask again using the current version.');
            if (before === action.text) {
              observation = 'The file already contains exactly that text. Do not repeat the write.';
              continue;
            }
            await this.path(action.path);
            signal.throwIfAborted();
            await writeFile(path, action.text, {
              encoding: 'utf8',
              flag: before === null ? 'wx' : 'w',
            });
            this.undoStack.push({
              kind: 'write',
              path: action.path,
              before,
              after: digest(action.text),
            });
            this.state.changes.push({
              path: action.path,
              kind: before === null ? 'created' : 'updated',
            });
          } else if (action.kind === 'mkdir') {
            await mkdir(path);
            this.undoStack.push({ kind: 'mkdir', path: action.path });
            this.state.changes.push({ path: action.path, kind: 'folder' });
          } else {
            const destination = await this.path(action.destination);
            const stat = await lstat(path);
            if (!stat.isFile() && !stat.isDirectory()) throw new Error('Choose a regular file or folder.');
            const inside = relative(path, destination);
            if (stat.isDirectory() && (!inside || (!inside.startsWith('..') && !isAbsolute(inside))))
              throw new Error('A folder cannot be moved into itself. Choose a different destination.');
            if (
              await lstat(destination).then(
                () => true,
                () => false,
              )
            )
              throw new Error('The destination already exists. Choose a new name.');
            // Ensure the destination parent exists; never silently create a different path.
            await realpath(dirname(destination));
            signal.throwIfAborted();
            await rename(path, destination);
            this.undoStack.push({
              kind: 'move',
              path: action.path,
              destination: action.destination,
              identity: `${stat.dev}:${stat.ino}`,
            });
            this.state.changes.push({
              path: `${action.path} → ${action.destination}`,
              kind: 'moved',
            });
          }
          confirmed.push(this.state.changes.at(-1)!);
          this.undoStack = this.undoStack.slice(-30);
          this.state.changes = this.state.changes.slice(-30);
          observation = `Confirmed ${action.kind}: ${action.path}. ${await this.list('')}`;
        }
        recent.push(`${action.kind}: ${action.path}`);
      }
      this.reply('Reached the task limit. Review the changes, then tell me what to do next.');
    } catch (e) {
      if (!controller.signal.aborted)
        this.reply(
          e instanceof z.ZodError || e instanceof SyntaxError
            ? 'The local model could not format its next step. Try a smaller request.'
            : (e as Error).message.slice(0, 500),
        );
    } finally {
      if (this.controller === controller) {
        this.controller = null;
        this.state.message = '';
        if (!this.root) {
          this.undoStack = [];
          this.state.changes = [];
        }
      }
    }
  }
}
