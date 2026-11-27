import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAgent } from './agent';
import type { LocalPlanner } from './agent';
const folders: string[] = [];
afterEach(async () => {
  for (const path of folders) await rm(path, { recursive: true, force: true });
  folders.length = 0;
});
async function folder() {
  const path = await mkdtemp(join(tmpdir(), 'doing-file-test-'));
  folders.push(path);
  return path;
}
async function finished(agent: LocalAgent) {
  await vi.waitFor(() => expect(agent.status().busy).toBe(false));
}
it('creates a requested file, replies on completion and undoes it without changing other files', async () => {
  const root = await folder();
  await writeFile(join(root, 'keep.txt'), 'untouched');
  const plan: LocalPlanner = async (_text, ctx) =>
    ctx.recent.length ? { kind: 'done', text: 'Created plan.md.' } : { kind: 'write', path: 'plan.md', text: '# Plan\n\n- Ship it\n' };
  const agent = new LocalAgent(plan);
  await agent.allow(root);
  agent.send('Create a plan.');
  await finished(agent);
  expect(await readFile(join(root, 'plan.md'), 'utf8')).toContain('Ship it');
  expect(agent.status().messages.at(-1)?.text).toBe('Created plan.md.');
  await agent.undo();
  await expect(readFile(join(root, 'plan.md'))).rejects.toThrow();
  expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('untouched');
});
it('refuses traversal, Windows alternate streams, linked folders and edits without permission', async () => {
  const root = await folder(),
    outside = await folder();
  await writeFile(join(outside, 'secret.txt'), 'private');
  await symlink(outside, join(root, 'linked'), 'junction');
  for (const path of ['../secret.txt', 'file.txt:stream', 'linked/secret.txt', '.env', 'CON.txt']) {
    const agent = new LocalAgent(async () => ({ kind: 'read', path }));
    await agent.allow(root);
    agent.send('Read');
    await finished(agent);
    expect(agent.status().messages.at(-1)?.text).not.toBe('private');
    expect(agent.status().changes).toEqual([]);
  }
  const noScope = new LocalAgent(async () => ({
    kind: 'write',
    path: 'bad.txt',
    text: 'no',
  }));
  noScope.send('Write');
  await finished(noScope);
  expect(noScope.status().messages.at(-1)?.text).toContain('Choose a folder');
});
it('preserves edits made outside Doing when undo is requested', async () => {
  const root = await folder();
  await writeFile(join(root, 'notes.txt'), 'before');
  const agent = new LocalAgent(async (_text, ctx) =>
    ctx.recent.some((step) => step.startsWith('write:'))
      ? { kind: 'done', text: 'Updated' }
      : { kind: 'write', path: 'notes.txt', text: 'after' },
  );
  await agent.allow(root);
  agent.send('Update');
  await finished(agent);
  await writeFile(join(root, 'notes.txt'), 'user edit');
  await expect(agent.undo()).rejects.toThrow('changed outside');
  expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('user edit');
});
it('preserves a file changed outside Doing between reading and writing', async () => {
  const root = await folder();
  await writeFile(join(root, 'notes.txt'), 'before');
  const agent = new LocalAgent(async (_text, ctx) => {
    if (!ctx.recent.length) return { kind: 'read', path: 'notes.txt' };
    await writeFile(join(root, 'notes.txt'), 'user edit');
    return { kind: 'write', path: 'notes.txt', text: 'model edit' };
  });
  await agent.allow(root);
  agent.send('Edit the note');
  await finished(agent);
  expect(agent.status().messages.at(-1)?.text).toContain('changed while');
  expect(agent.status().changes).toEqual([]);
  expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('user edit');
});
it('moves files without overwriting a destination and supports undo', async () => {
  const root = await folder();
  await writeFile(join(root, 'a.txt'), 'A');
  await mkdir(join(root, 'notes'));
  const agent = new LocalAgent(async (_text, ctx) =>
    ctx.recent.length ? { kind: 'done', text: 'Moved' } : { kind: 'move', path: 'a.txt', destination: 'notes/a.txt' },
  );
  await agent.allow(root);
  agent.send('Organize');
  await finished(agent);
  expect(await readFile(join(root, 'notes/a.txt'), 'utf8')).toBe('A');
  await agent.undo();
  expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('A');
});
it('does not execute a late model action after Stop', async () => {
  let finish!: (value: { kind: 'write'; path: string; text: string }) => void;
  const agent = new LocalAgent(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const root = await folder();
  await agent.allow(root);
  agent.send('Write');
  await vi.waitFor(() => expect(finish).toBeDefined());
  agent.stop();
  finish({ kind: 'write', path: 'late.txt', text: 'late' });
  await finished(agent);
  await expect(readFile(join(root, 'late.txt'))).rejects.toThrow();
});
