import { randomUUID, createHash } from 'node:crypto';
import { lstat, realpath, readdir, readFile, writeFile, mkdir, rename, unlink, rmdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, extname } from 'node:path';
import { z } from 'zod';
import type { LocalStatus, LocalMessage } from '@doing/contracts';

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
  z.object({ kind: z.literal('mkdir'), path: z.string().min(1).max(500) }),
  z.object({
    kind: z.literal('move'),
    path: z.string().min(1).max(500),
    destination: z.string().min(1).max(500),
  }),
]);
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
  | { kind: 'mkdir'; path: string };
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
  private state: LocalStatus = {
    folder: null,
    busy: false,
    message: '',
    messages: [],
    changes: [],
    canUndo: false,
  };
  constructor(private readonly plan: LocalPlanner) {}
  status(): LocalStatus {
    return structuredClone({
      ...this.state,
      folder: this.root,
      busy: !!this.controller,
      canUndo: !this.controller && this.undoStack.length > 0,
    });
  }
  async allow(folder: string): Promise<LocalStatus> {
    if (this.controller) throw new Error('Stop the current request before changing folders.');
    const path = await realpath(folder);
    if (!(await lstat(path)).isDirectory()) throw new Error('Choose a folder.');
    this.root = path;
    this.undoStack = [];
    this.state.messages = [];
    this.state.changes = [];
    this.state.message = 'Folder ready.';
    return this.status();
  }
  revoke(): LocalStatus {
    this.stop();
    this.root = null;
    this.undoStack = [];
    this.state.changes = [];
    this.state.messages = [];
    return this.status();
  }
  stop(): LocalStatus {
    if (this.controller && !this.controller.signal.aborted) {
      this.controller.abort();
      this.reply('Stopped. Completed file changes can be undone.');
    }
    this.state.message = 'Stopping…';
    return this.status();
  }
  clear(): LocalStatus {
    this.stop();
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
    try {
      let observation = this.root
        ? await this.list('')
        : 'No folder allowed. Answer general questions; ask the user to choose a folder for file work.';
      for (let step = 0; step < 30; step++) {
        signal.throwIfAborted();
        this.state.message = step ? 'Working with your files…' : 'Thinking…';
        const action = FileActionSchema.parse(
          await this.plan(
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
          this.reply(action.text);
          return;
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
          if (action.kind === 'write') {
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
