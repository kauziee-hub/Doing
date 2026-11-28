import { it, expect } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { LocalAgent } from '../../apps/desktop/electron/main/local/agent';
import { createLocalPlanner } from '../../apps/desktop/electron/main/local/planner';
import { createDesktopHost } from '../../apps/desktop/electron/main/local/desktop';
import { createAnswerProvider } from '../../packages/providers/src/index';
import type { PcHost } from '../../apps/desktop/electron/main/local/pc';
import type { AppServices } from '../../apps/desktop/electron/main/services';

// Explicit opt-in: real local inference + native Windows UIA3; no external messages.
it.skipIf(process.env.DOING_MESSAGING_NATIVE !== '1')(
  'native messaging continues through contact search, exact draft, one Send and local-model readback',
  async () => {
    const folder = await mkdtemp(join(tmpdir(), 'doing-messaging-fixture-'));
    let fixture: ReturnType<typeof spawn> | undefined;
    try {
      const source = await readFile('tests/fixtures/messaging-control.cs', 'utf8');
      const compile = join(folder, 'compile.ps1');
      await writeFile(
        compile,
        `$ErrorActionPreference='Stop'\nAdd-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly (Join-Path $PSScriptRoot 'DoingMessagingFixture.exe') -OutputType WindowsApplication -TypeDefinition @'\n${source}\n'@`,
      );
      execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', compile], { windowsHide: true, stdio: 'pipe' });
      fixture = spawn(join(folder, 'DoingMessagingFixture.exe'), [], { stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 800));
      const native = createDesktopHost(resolve('apps/desktop/resources/desktop-control-uia3.ps1'));
      const desktop = {
        inspect: async (name: string, signal: AbortSignal) => {
          const view = await native.inspect(name === 'WhatsApp' ? 'DoingMessagingFixture' : name, signal);
          return view;
        },
        act: async (...args: Parameters<typeof native.act>) => {
          const view = await native.act(...args);
          return view;
        },
      };
      let launches = 0;
      const pc = {
        listApps: async () => [{ name: 'WhatsApp', id: 'LOCAL FIXTURE' }],
        launchApp: async () => {
          launches++;
        },
      } as unknown as PcHost;
      const provider = createAnswerProvider({ baseUrl: 'http://127.0.0.1:11435/v1' });
      const services = {
        engine: { status: () => ({ ready: true, tier: 'gpu' }) },
        ensureEngine: async () => {},
        resolveProvider: () => ({ model: 'qwen3.5:4b', provider }),
      } as unknown as AppServices;
      const realPlan = createLocalPlanner(services);
      let plans = 0;
      const agent = new LocalAgent(
        async (...args) => {
          plans++;
          const action = await realPlan(...args);
          return action;
        },
        undefined,
        pc,
        desktop,
      );
      agent.desktopAccess(true);
      const task = 'Message Alex Example in WhatsApp "HI FROM DOING - LOCAL TEST"';
      const began = Date.now();
      agent.send(task);
      while (agent.status().busy && Date.now() - began < 150000) await new Promise((r) => setTimeout(r, 250));
      expect(agent.status().busy).toBe(false);
      const view = await desktop.inspect('WhatsApp', new AbortController().signal);
      const report = {
        task,
        elapsedMs: Date.now() - began,
        launches,
        plans,
        reply: agent.status().messages.at(-1)?.text,
        sendOnce: view.controls.some((c) => c.name === 'Send count: 1'),
        exactMessage: view.controls.some((c) => c.name === 'Sent: HI FROM DOING - LOCAL TEST'),
      };
      await writeFile('test-results/messaging-native-report.json', JSON.stringify(report, null, 2));
      console.log(JSON.stringify(report));
      const readback = await realPlan(
        'What exact message appears in the current chat? Read only; do not type or send.',
        {
          folder: false,
          desktop: true,
          app: true,
          history: [],
          observation: JSON.stringify({ app: view.process, title: view.title, controls: view.controls }),
          recent: [],
        },
        new AbortController().signal,
      );
      expect(['answer', 'done']).toContain(readback.kind);
      if (readback.kind === 'answer' || readback.kind === 'done') expect(readback.text).toContain('HI FROM DOING');
      expect(report.launches).toBe(1);
      expect(report.sendOnce).toBe(true);
      expect(report.exactMessage).toBe(true);
      expect(report.reply).toContain('appears in Alex Example');
    } finally {
      fixture?.kill();
      await new Promise((r) => setTimeout(r, 300));
      if (resolve(folder).startsWith(resolve(tmpdir()) + sep + 'doing-messaging-fixture-'))
        await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  },
  180000,
);
