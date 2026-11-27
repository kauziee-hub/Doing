import { usesOtherTabs } from './context';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { BrowserActionSchema, BrowserSnapshotSchema, BrowserStartSchema } from '@doing/contracts';
import type { BrowserAction, BrowserCommand, BrowserSnapshot, BrowserStart, BrowserStatus } from '@doing/contracts';
import type { BrowserTrustStore } from './trust';
import type { BrowserChatter } from './chat';
import { approvesPending, requestsSubmission } from './chat';
import { PageScan, readsWholePage } from './pageScan';

export type BrowserPlanner = (task: string, page: BrowserSnapshot, recent: string[], signal: AbortSignal) => Promise<BrowserAction>;
export type BrowserReader = (question: string, page: BrowserSnapshot, signal: AbortSignal) => Promise<string>;
const ConnectSchema = z.object({ url: z.string().url().max(2048), title: z.string().max(300), id: z.string().max(80).optional() });
const TickSchema = z.object({
  clientId: z.string().uuid(),
  snapshot: BrowserSnapshotSchema.optional(),
  receipt: z.object({ id: z.string().uuid(), ok: z.boolean(), message: z.string().max(500) }).optional(),
});
const LEASE_MS = 30 * 60_000;
const LOST_MS = 30_000;

/** Validate every action against the current observed controls, never against model-supplied selectors. */
export function checkAction(action: BrowserAction, page: BrowserSnapshot, task = ''): string | null {
  if (action.kind === 'scroll') {
    const region = action.target === 'page' ? page.scroll : page.elements.find((el) => el.id === action.target && el.kind === 'scroll')?.scroll;
    if (!region) return 'The requested scroll region is unavailable.';
    if (action.direction === 'down' ? region.top >= region.max - 2 : region.top <= 0) return 'This scroll region has reached its boundary.';
    return null;
  }
  if (!('target' in action)) return null;
  const el = page.elements.find((e) => e.id === action.target);
  if (!el) return 'The requested control is no longer on this page.';
  if (action.kind === 'click' && /\b(?:do not submit|don't submit|dont submit|never submit|without submitting)\b/i.test(task) &&
      el.kind === 'button' && (el.advances || /check.?answer|verify|grade|submit/i.test(el.label)))
    return 'Your request says not to submit or check answers. Only answer selection is allowed.';
  if (action.kind === 'type' && !['text', 'code'].includes(el.kind)) return 'This control does not accept text.';
  if (action.kind === 'type' && el.kind === 'code' && /\b(?:preserv\w*|signature|solve|coding|solution)\b/i.test(task)) {
    const signature = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(|\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\s*\(/.exec(el.value);
    const name = signature?.[1] ?? signature?.[2];
    if (name) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const declaration = new RegExp(`\\bfunction\\s+${escaped}\\s*\\(|\\b(?:var|let|const)\\s+${escaped}\\s*=`);
      if (!declaration.test(action.text)) return `The replacement omits the existing function ${name}. Typing replaces the ENTIRE editor. Include its full function declaration and complete body, preserving the requested signature.`;
    }
  }
  if (action.kind === 'select' && (el.kind !== 'select' || !el.options?.some((o) => o.value === action.value)))
    return 'The requested option is not available.';
  if (action.kind === 'click' && !['button', 'link', 'radio', 'checkbox'].includes(el.kind))
    return 'This control cannot be clicked by the assistant.';
  return null;
}

export function parsePlan(raw: string): BrowserAction {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return BrowserActionSchema.parse(JSON.parse(text));
}

/** Task/tab permissions stay in memory; only an explicitly approved browser credential persists. */
export class BrowserAgent {
  private pageScan: PageScan | null = null;
  private server: Server | null = null;
  private token = '';
  private clientId: string | null = null;
  private origin = '';
  private leaseUntil = 0;
  private lastSeen = 0;
  private runId = '';
  private abort: AbortController | null = null;
  private planning = false;
  private observation: { page: BrowserSnapshot; at: number } | null = null;
  private reading: AbortController | null = null;
  private selectedTabId: string | null = null;
  private retiredTabs = new Set<string>();
  private chatTask = false;
  private seenMessages = new Set<string>();
  private inFlight: BrowserCommand | null = null;
  private review: { action: BrowserAction; page: BrowserSnapshot } | null = null;
  private approved: BrowserAction | null = null;
  private lastSignature = '';
  private repeats = 0;
  private waits = 0;
  private reviewedQuestions = new Set<string>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private state: BrowserStatus;
  private trustedExtensionId: string | null = null;
  private connectionRequest: {
    id: string;
    label: string;
    extensionId: string;
    token: string;
    expires: number;
    state: 'waiting' | 'approved' | 'denied';
  } | null = null;

  constructor(
    private readonly plan: BrowserPlanner,
    port = 19389,
    private readonly trust?: BrowserTrustStore,
    private readonly requestAttention?: () => void,
    private readonly read?: BrowserReader,
    private readonly converse?: BrowserChatter,
  ) {
    const saved = trust?.load();
    this.token = saved?.token ?? '';
    this.trustedExtensionId = saved?.extensionId ?? null;
    this.state = {
      enabled: false,
      pairingCode: null,
      trustedBrowser: !!saved,
      connectionRequest: null,
      port,
      phase: 'off',
      tab: null,
      pageReady: false,
      tabs: [],
      messages: [],
      chatting: false,
      task: '',
      autoSubmit: false,
      steps: 0,
      maxSteps: 150,
      message: 'Browser access is off.',
      pending: null,
      log: [],
    };
  }

  status(): BrowserStatus {
    this.checkLease();
    const req = this.connectionRequest;
    return structuredClone({
      ...this.state,
      chatting: !!this.reading || this.state.phase === 'running',
      pageReady: !!this.observation && Date.now() - this.observation.at < 5000,
      pairingCode: this.state.enabled && !this.trustedExtensionId ? this.token : null,
      trustedBrowser: !!this.trustedExtensionId,
      connectionRequest:
        req?.state === 'waiting' && req.expires > Date.now() ? { id: req.id, label: req.label, extensionId: req.extensionId } : null,
    });
  }

  private note(message: string): void {
    this.state.message = message;
    this.state.log = [...this.state.log.slice(-39), { at: Date.now(), message }];
  }

  async enable(): Promise<BrowserStatus> {
    if (this.server) return this.status();
    this.token ||= randomBytes(24).toString('hex');
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    server.requestTimeout = 120_000;
    server.headersTimeout = 10_000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.state.port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      const addr = server.address();
      if (addr && typeof addr !== 'string') this.state.port = addr.port;
      this.state.enabled = true;
      this.state.phase = 'disconnected';
      this.note(
        this.trustedExtensionId
          ? 'Browser remembered. Click Allow this tab in the companion when ready.'
          : 'Click Allow this tab in the companion, then approve its connection here. No code needed.',
      );
      this.watchdog = setInterval(() => this.checkLease(), 1000);
      this.watchdog.unref();
      return this.status();
    } catch {
      this.server = null;
      if (!this.trustedExtensionId) this.token = '';
      throw new Error('Could not open the local browser bridge. Another Doing instance may be using port 19389.');
    }
  }

  shutdown(): void {
    this.observation = null;
    this.stop();
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = null;
    this.clientId = null;
    this.origin = '';
    this.connectionRequest = null;
    this.state.enabled = false;
    this.state.phase = 'off';
    this.state.tab = null;
    this.state.task = '';
    this.state.log = [];
    this.state.tabs = [];
    this.selectedTabId = null;
    this.state.messages = [];
    this.seenMessages.clear();
  }

  disable(): BrowserStatus {
    this.trust?.clear();
    this.shutdown();
    this.token = '';
    this.trustedExtensionId = null;
    this.note('Browser permission revoked.');
    return this.status();
  }

  allowConnection(requestId: string): BrowserStatus {
    const req = this.connectionRequest;
    if (!req || req.id !== requestId || req.state !== 'waiting' || Date.now() > req.expires)
      throw new Error('The browser connection request expired. Click Allow this tab again.');
    this.trust?.save({ token: req.token, extensionId: req.extensionId });
    this.observation = null;
    this.stop();
    this.clientId = null;
    this.state.tab = null;
    this.state.tabs = [];
    this.selectedTabId = null;
    this.token = req.token;
    this.trustedExtensionId = req.extensionId;
    req.state = 'approved';
    this.state.phase = 'disconnected';
    this.note('Browser approved and remembered. Tab access still requires your permission.');
    return this.status();
  }

  denyConnection(requestId: string): BrowserStatus {
    if (this.connectionRequest?.id === requestId) this.connectionRequest.state = 'denied';
    this.note('Browser connection declined.');
    return this.status();
  }

  start(input: BrowserStart): BrowserStatus {
    const req = BrowserStartSchema.parse(input);
    this.checkLease();
    if (!this.clientId || !this.state.tab || Date.now() - this.lastSeen > LOST_MS)
      throw new Error('Allow a tab in the Doing extension first.');
    if (this.planning) throw new Error('The previous action is stopping. Try again in a moment.');
    this.stop();
    this.state.task = req.task;
    this.state.autoSubmit = req.autoSubmit;
    this.state.maxSteps = req.maxSteps;
    this.state.steps = 0;
    this.state.log = [];
    this.state.phase = 'running';
    this.runId = randomUUID();
    this.abort = new AbortController();
    this.leaseUntil = Date.now() + LEASE_MS;
    this.lastSignature = '';
    this.repeats = 0;
    this.waits = 0;
    this.reviewedQuestions.clear();
    this.note('Permission granted for this task on the connected site. Reading the tab…');
    return this.status();
  }

  stop(): BrowserStatus {
    this.pageScan = null;
    if (this.chatTask) this.finishChatTask('Stopped. Tell me what you would like to do next.');
    this.reading?.abort();
    this.reading = null;
    this.abort?.abort();
    this.abort = null;
    this.runId = '';
    this.inFlight = null;
    this.review = null;
    this.approved = null;
    this.state.pending = null;
    if (this.state.enabled) {
      this.state.phase = 'stopped';
      this.note('Stopped. No further actions will be issued.');
    }
    return this.status();
  }

  private reply(text: string): void {
    this.state.messages = [...this.state.messages.slice(-59), { id: randomUUID(), role: 'assistant', text, tabId: this.selectedTabId ?? undefined }];
  }

  private finishChatTask(text: string): void {
    if (this.chatTask) {
      this.chatTask = false;
      this.reply(text);
    }
  }

  async chat(id: string, text: string): Promise<void> {
    if (this.seenMessages.has(id)) return;
    if (!this.converse) throw new Error('The browser chat model is unavailable.');
    this.checkLease();
    if (!this.clientId || !this.observation || Date.now() - this.observation.at >= 5000)
      throw new Error('Allow a tab and wait for its page to finish loading.');
    if (this.reading || this.state.phase === 'running') throw new Error('Doing is working. Stop the task first to change the request.');
    const client = this.clientId;
    const page = this.observation.page;
    const controller = new AbortController();
    this.reading = controller;
    const history = this.state.messages.filter((message) => usesOtherTabs(text) || message.tabId === (this.selectedTabId ?? undefined));
    this.seenMessages.add(id);
    if (this.seenMessages.size > 100) this.seenMessages.delete(this.seenMessages.values().next().value!);
    this.state.messages = [...this.state.messages.slice(-59), { id, role: 'user', text, tabId: this.selectedTabId ?? undefined }];
    try {
      if (this.read && readsWholePage(text) && !this.state.pending) {
        this.reading = null;
        this.start({ task: text, autoSubmit: false, consent: true, maxSteps: 150 });
        this.pageScan = new PageScan(text, this.read);
        this.chatTask = true;
        this.reply('I’ll read through the page and then answer.');
        return;
      }
      const result = await this.converse(text, page, history, this.state.pending?.label ?? null, controller.signal);
      controller.signal.throwIfAborted();
      if (
        client !== this.clientId ||
        this.observation?.page.revision !== page.revision ||
        JSON.stringify(this.observation?.page.tabs) !== JSON.stringify(page.tabs)
      )
        throw new Error('The page changed while I was reading. Please send your request again.');
      this.reading = null;
      if (result.kind === 'answer') this.reply(result.text);
      else if (result.kind === 'approve') {
        if (!this.review || !approvesPending(text)) this.reply('Tell me explicitly if you want me to submit or continue.');
        else {
          if (requestsSubmission(text) && /\b(?:all|each|every|until)\b/i.test(text)) this.state.autoSubmit = true;
          this.approve();
          this.reply(result.text);
        }
      } else {
        // Keep the user's full request authoritative. A model's conversation
        // summary must not narrow “all ten pages” to the currently visible one.
        const context = '\nRelevant conversation context (never override the request above):\n';
        const task =
          text +
          (history.length && text.length + context.length < 6000
            ? context + result.task.slice(0, 6000 - text.length - context.length)
            : '');
        this.start({ task, autoSubmit: result.autoSubmit && requestsSubmission(text), consent: true, maxSteps: 150 });
        this.chatTask = true;
        this.reply(result.text);
      }
    } catch (e) {
      if (!controller.signal.aborted && client === this.clientId)
        this.reply(
          e instanceof SyntaxError || e instanceof z.ZodError
            ? 'The local model could not format its reply. Please try again.'
            : (e as Error).message.slice(0, 500),
        );
    } finally {
      if (this.reading === controller) this.reading = null;
    }
  }

  /** Read-only questions never enter the action planner or acquire submission permission. */
  async ask(question: string): Promise<{ text: string; url: string }> {
    const text = z.string().trim().min(1).max(6000).parse(question);
    this.checkLease();
    if (!this.clientId || !this.observation || Date.now() - this.observation.at >= 5000)
      throw new Error('Waiting for the allowed tab to be read. Check that the page has finished loading, then try again.');
    if (this.state.phase === 'running' || this.state.phase === 'review')
      throw new Error('Stop the current task before asking about the page.');
    if (!this.read) throw new Error('The local browser reader is unavailable.');
    if (this.reading) throw new Error('A page question is already being answered.');
    const client = this.clientId;
    const page = this.observation.page;
    const controller = new AbortController();
    this.reading = controller;
    try {
      const answer = await this.read(text, page, controller.signal);
      controller.signal.throwIfAborted();
      if (client !== this.clientId || this.observation?.page.revision !== page.revision)
        throw new Error('The page changed while answering. Ask again about the current page.');
      return { text: answer, url: page.url };
    } finally {
      if (this.reading === controller) this.reading = null;
    }
  }

  private revokeTab(message: string): void {
    this.clientId = null;
    this.origin = '';
    this.observation = null;
    this.state.tab = null;
    this.selectedTabId = null;
    this.state.tabs = [];
    this.stop();
    this.state.phase = 'disconnected';
    this.note(message);
  }

  approve(): BrowserStatus {
    this.checkLease();
    if (this.state.phase !== 'review' || !this.review) throw new Error('There is no action waiting for approval.');
    if (!this.clientId || Date.now() - this.lastSeen > LOST_MS) throw new Error('The browser tab is disconnected.');
    this.approved = this.review.action;
    this.state.pending = null;
    this.state.phase = 'running';
    this.note('Approved this action. Rechecking the page before continuing…');
    return this.status();
  }

  private checkLease(): void {
    if (this.clientId && Date.now() - this.lastSeen > LOST_MS && !this.planning) {
      this.revokeTab('The browser disconnected. Click Allow this tab again.');
      return;
    }
    if (this.state.phase === 'running' || this.state.phase === 'review') {
      if (Date.now() > this.leaseUntil || (this.lastSeen && Date.now() - this.lastSeen > LOST_MS && !this.planning)) {
        this.abort?.abort();
        this.abort = null;
        this.runId = '';
        this.inFlight = null;
        this.review = null;
        this.approved = null;
        this.state.pending = null;
        this.state.phase = 'stopped';
        this.note('Permission expired or the browser disconnected. Start again to continue.');
        this.finishChatTask(this.state.message);
      }
    }
  }

  private async tick(body: z.infer<typeof TickSchema>): Promise<unknown> {
    if (body.clientId !== this.clientId) throw new Error('This browser connection is no longer authorized.');
    this.lastSeen = Date.now();
    this.checkLease();
    const previousPage = this.observation?.page;
    let confirmedChoice: BrowserSnapshot['elements'][number] | undefined;
    if (body.snapshot) {
      if ((body.snapshot.tabId && this.retiredTabs.has(body.snapshot.tabId)) || body.snapshot.tabs?.some((t) => this.retiredTabs.has(t.id)))
        return { phase: this.state.phase, observe: true };
      // A tab selection can race an idle observation already on the wire.
      if (
        this.selectedTabId &&
        body.snapshot.tabId !== this.selectedTabId &&
        this.state.tabs.some((tab) => tab.id === body.snapshot!.tabId && new URL(tab.url).origin === new URL(body.snapshot!.url).origin)
      )
        return { phase: this.state.phase, observe: true };
      if (
        new URL(body.snapshot.url).origin !== this.origin ||
        (this.selectedTabId && body.snapshot.tabId !== this.selectedTabId) ||
        body.snapshot.tabs?.some(
          (tab) => !this.state.tabs.some((allowed) => allowed.id === tab.id && new URL(allowed.url).origin === new URL(tab.url).origin),
        )
      ) {
        this.revokeTab('The tab moved to another site. Allow that tab again to continue.');
        return { phase: 'stopped', observe: false };
      }
      this.observation = { page: body.snapshot, at: Date.now() };
      this.state.tab = { title: body.snapshot.title, url: body.snapshot.url };
    } else this.observation = null;
    if (this.state.phase !== 'running') return { phase: this.state.phase, observe: true };
    if (this.planning) throw new Error('An observation is already being processed.');
    const run = this.runId;
    const signal = this.abort!.signal;
    if (this.inFlight) {
      if (body.receipt?.id !== this.inFlight.id) {
        this.state.phase = 'error';
        this.note('The browser did not confirm the previous action. Stopped to avoid submitting twice.');
        this.finishChatTask(this.state.message);
        this.inFlight = null;
        return { phase: 'error', observe: false };
      }
      const issued = this.inFlight;
      if (issued.action.kind === 'click') {
        const target = issued.action.target;
        const choice = previousPage?.elements.find(el => el.id === target && ['radio','checkbox'].includes(el.kind));
        if (body.receipt?.ok && choice?.kind === 'radio' && choice?.context && body.snapshot?.elements.some(el => el.context === choice.context && el.label === choice.label && el.checked)) this.reviewedQuestions.add(choice.context);
      }
      this.inFlight = null;
      if (!body.receipt.ok) {
        this.state.phase = 'error';
        this.note(`Browser action failed: ${body.receipt.message}`);
        this.finishChatTask(this.state.message);
        return { phase: 'error', observe: false };
      }
      if (issued.action.kind === 'click') {
        const target = issued.action.target;
        confirmedChoice = previousPage?.elements.find((el) => el.id === target && el.kind === 'radio');
      }
      this.state.steps++;
      this.note(`Action ${this.state.steps} confirmed by the browser.`);
    }
    if (this.state.steps >= this.state.maxSteps) {
      this.state.phase = 'stopped';
      this.note('Reached the action limit. Review progress and start again if needed.');
      this.finishChatTask(this.state.message);
      return { phase: 'stopped', observe: false };
    }
    const page = body.snapshot;
    if (!page) return { phase: 'running', observe: true, runId: run };
    const questionContexts = [...new Set(page.elements.filter(el => ['radio','checkbox'].includes(el.kind) && el.context).map(el => el.context!))];
    const question = !this.pageScan && /\b(?:all|each|every)\b/i.test(this.state.task) && /\b(?:questions?|mcqs?)\b/i.test(this.state.task)
      ? questionContexts.find(context => !this.reviewedQuestions.has(context)) : undefined;
    const planningPage = question ? {...page,text:question,elements:page.elements.filter(el => el.context === question || el.kind === 'scroll')} : page;
    this.planning = true;
    try {
      let action: BrowserAction;
      const region = page.scroll && page.scroll.max > 2 ? {id:'page',scroll:page.scroll} : page.elements.filter(el=>el.kind==='scroll' && el.scroll).sort((a,b)=>b.scroll!.height-a.scroll!.height)[0];
      const reviewedScreen = questionContexts.length > 0 && !question && !page.elements.some(el => ['code','text','select'].includes(el.kind)) && /\b(?:all|each|every)\b/i.test(this.state.task) && /\b(?:questions?|mcqs?)\b/i.test(this.state.task);

      // A single numbered MCQ has a verifiable two-step flow. After the
      // selected option is acknowledged, advance only with the user's batch
      // submission grant and a unique observed Submit/Next control.
      const inputs = page.elements.filter((el) => ['radio', 'checkbox', 'text', 'code', 'select'].includes(el.kind));
      const advances = page.elements.filter(
        (el) => el.kind === 'button' && el.advances && /^(?:submit(?: and next)?|next|continue)$/i.test(el.label),
      );
      const verified =
        confirmedChoice?.group &&
        previousPage?.text === page.text &&
        inputs.every((el) => el.kind === 'radio' && el.group === confirmedChoice.group) &&
        inputs.some((el) => el.id === confirmedChoice.id && el.label === confirmedChoice.label && el.checked);
      if (this.pageScan) {
        action = await this.pageScan.step(page, signal);
      } else if (reviewedScreen && region?.scroll && region.scroll.top < region.scroll.max - 2) {
        action = {kind:'scroll',target:region.id,direction:'down',reason:'Continue to the next unanswered question.'};
      } else if (reviewedScreen && region?.scroll && region.scroll.top >= region.scroll.max - 2) {
        action = {kind:'done',reason:'Reached the end after reviewing and selecting answers for the encountered questions.'};
      } else if (
        verified &&
        advances.length === 1 &&
        this.state.autoSubmit &&
        /\b(?:all|each|every|until)\b/i.test(this.state.task) &&
        /\bquestion\s*\d+\s*(?:of|\/)\s*\d+/i.test(page.text)
      ) {
        action = { kind: 'click', target: advances[0]!.id, reason: 'The chosen option is visibly selected; continue the requested batch.' };
      } else if (this.approved && this.review && this.review.page.revision === page.revision) {
        action = this.approved;
      } else {
        this.approved = null;
        this.review = null;
        action = BrowserActionSchema.parse(
          await this.plan(
            this.state.task,
            planningPage,
            this.state.log.slice(-8).map((l) => l.message),
            signal,
          ),
        );
        if (
          action.kind === 'click' &&
          page.elements.some((el) => el.id === ('target' in action ? action.target : '') && el.kind === 'radio' && el.checked)
        ) {
          action = BrowserActionSchema.parse(
            await this.plan(
              this.state.task,
              page,
              [
                'That radio option is already selected. Clicking it again does nothing. If it is the correct answer, use the observed Submit/Next control as requested. Otherwise choose a different answer.',
              ],
              signal,
            ),
          );
          if (
            action.kind === 'click' &&
            page.elements.some((el) => el.id === ('target' in action ? action.target : '') && el.kind === 'radio' && el.checked)
          )
            throw new Error('The chosen option is already selected. Doing stopped because the model repeated a completed action.');
        }
        const numberedQuestion = /\b(?:question|page)\s*\d+\s*(?:of|\/)\s*\d+/i.test(page.text);
        const unfinishedControls =
          page.elements.some((el) => ['radio', 'checkbox', 'text', 'code', 'select'].includes(el.kind)) &&
          page.elements.some((el) => el.advances);
        if (
          action.kind === 'done' &&
          this.state.autoSubmit &&
          numberedQuestion &&
          unfinishedControls &&
          /\b(?:all|each|every|until)\b/i.test(this.state.task)
        ) {
          action = BrowserActionSchema.parse(
            await this.plan(
              this.state.task,
              page,
              [
                'Completion check: a numbered question and its editable choices remain visible. The requested workflow is unfinished. Choose an action on this question; do not declare completion.',
              ],
              signal,
            ),
          );
          if (action.kind === 'done')
            throw new Error(
              'A question is still visible. Doing stopped before claiming completion. Tell it to continue or review the page.',
            );
        }
      }
      if (signal.aborted || run !== this.runId || this.state.phase !== 'running') return { phase: this.state.phase, observe: false };
      if (action.kind === 'done' && question) {
        const choices = planningPage.elements.filter(el => ['radio','checkbox'].includes(el.kind));
        if (!choices.some(el => el.checked)) throw new Error('A question still has no selected answer. The task is incomplete.');
        this.reviewedQuestions.add(question);
        return {phase:'running',observe:true,runId:run};
      }
      // A model must not finish an all-questions request after only the first screen.
      if (action.kind === 'done' && /\b(?:all|each|every)\b/i.test(this.state.task) && /\b(?:questions?|mcqs?)\b/i.test(this.state.task)) {
        const nested = page.elements.filter((el) => el.kind === 'scroll' && el.scroll).sort((a, b) => b.scroll!.height - a.scroll!.height)[0];
        const primary = page.scroll && page.scroll.max > 2 ? { id: 'page', scroll: page.scroll } : nested;
        if (primary?.scroll && primary.scroll.top < primary.scroll.max - 2)
          action = { kind: 'scroll', target: primary.id, direction: 'down', reason: 'Continue inspecting all requested questions below this section.' };
      }
      this.checkLease();
      if (this.state.phase !== 'running') return { phase: this.state.phase, observe: false };
      let issue = checkAction(action, page, this.state.task);
      if (issue?.startsWith('The replacement omits')) {
        const editor = 'target' in action ? action.target : null;
        action = BrowserActionSchema.parse(await this.plan(this.state.task, page, [issue], signal));
        if (signal.aborted || run !== this.runId || this.state.phase !== 'running') return { phase: this.state.phase, observe: false };
        if (action.kind !== 'ask' && (action.kind !== 'type' || action.target !== editor)) throw new Error('The editor still needs a complete function. Doing stopped before entering an incomplete replacement.');
        issue = checkAction(action, page, this.state.task);
      }
      if (issue) throw new Error(issue);
      if (action.kind === 'done' || action.kind === 'ask') {
        this.state.phase = action.kind === 'done' ? 'done' : 'stopped';
        this.note(action.reason);
        this.finishChatTask(this.pageScan?.summary || action.reason);
        this.pageScan = null;
        return { phase: this.state.phase, observe: false };
      }
      if (action.kind === 'wait') {
        if (++this.waits > 8) throw new Error('The page is not becoming ready. Check the tab and start again.');
        return { phase: 'running', observe: true, runId: run };
      }
      this.waits = 0;
      if (action.kind === 'switch') {
        const tab = this.state.tabs.find((t) => t.id === action.tab);
        if (!tab || tab.id === this.selectedTabId) throw new Error('The requested tab is not an available different allowed tab.');
        this.inFlight = { id: randomUUID(), runId: run, revision: page.revision, origin: this.origin, action };
        this.selectedTabId = tab.id;
        this.origin = new URL(tab.url).origin;
        this.state.tab = { title: tab.title, url: tab.url };
        this.observation = null;
        this.note(`Switching to allowed tab: ${tab.title.slice(0, 100)}.`);
        return { phase: 'running', observe: true, command: this.inFlight, runId: run };
      }
      if (action.kind === 'scroll') {
        this.note(`Scrolling ${action.direction} to inspect the next section.`);
        this.inFlight = { id: randomUUID(), runId: run, revision: page.revision, origin: this.origin, action };
        return { phase: 'running', observe: true, command: this.inFlight, runId: run };
      }
      const el = page.elements.find((e) => 'target' in action && e.id === action.target)!;
      if (action.kind === 'click' && el.advances && !this.state.autoSubmit && this.approved !== action) {
        this.review = { action, page };
        this.state.phase = 'review';
        this.state.pending = { reason: action.reason, label: el.label };
        this.note('Review the page, then approve this submit or next action.');
        if (this.chatTask) this.reply(`Ready to ${el.label}. Tell me “submit” or “continue” if you want me to proceed.`);
        return { phase: 'review', observe: false };
      }
      this.approved = null;
      this.review = null;
      const { reason: _reason, ...operation } = action;
      const signature = JSON.stringify({ operation, text: page.text, elements: page.elements.map(({ id: _id, ...rest }) => rest) });
      this.repeats = signature === this.lastSignature ? this.repeats + 1 : 0;
      this.lastSignature = signature;
      if (this.repeats >= 2) throw new Error('The same action produced no visible progress. Check the tab before continuing.');
      this.note(
        `${action.kind === 'type' ? 'Typing into' : action.kind === 'select' ? 'Selecting in' : 'Clicking'} ${el.label.slice(0, 100) || el.kind}.`,
      );
      this.inFlight = { id: randomUUID(), runId: run, revision: page.revision, origin: this.origin, action };
      return { phase: 'running', observe: true, command: this.inFlight, runId: run };
    } catch (e) {
      if (!signal.aborted && run === this.runId) {
        this.state.phase = 'error';
        // Never surface model payloads (which may contain page data) in metadata logs.
        this.note(
          e instanceof SyntaxError || e instanceof z.ZodError
            ? 'The local model returned an invalid browser action. Review the page and restart.'
            : (e as Error).message.slice(0, 300),
        );
        this.finishChatTask(this.state.message);
      }
      return { phase: this.state.phase, observe: false };
    } finally {
      if (run === this.runId && body.clientId === this.clientId) this.lastSeen = Date.now();
      this.planning = false;
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    const allowedOrigin = !origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
    const host = `127.0.0.1:${this.state.port}`;
    if (!allowedOrigin || req.headers.host !== host) {
      res.writeHead(403).end();
      return;
    }
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
      res.writeHead(204).end();
      return;
    }
    const supplied = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''));
    const expected = Buffer.from(this.token);
    const pairRoute = req.url === '/pair/request' || req.url === '/pair/status';
    if (pairRoute && (!origin || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))) {
      res.writeHead(403).end('{}');
      return;
    }
    if (!pairRoute && (!this.token || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))) {
      res.writeHead(401).end('{}');
      return;
    }
    if (!pairRoute && this.trustedExtensionId && origin !== `chrome-extension://${this.trustedExtensionId}`) {
      res.writeHead(403).end('{}');
      return;
    }
    if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) {
      res.writeHead(405).end('{}');
      return;
    }
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 400_000) {
          res.writeHead(413).end('{}');
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (pairRoute) {
        const token = z
          .string()
          .regex(/^[a-f0-9]{48}$/)
          .parse(supplied.toString());
        const extensionId = origin!.slice('chrome-extension://'.length);
        if (req.url === '/pair/request') {
          const { label } = z.object({ label: z.string().min(1).max(80) }).parse(data);
          const old = this.connectionRequest;
          if (old?.state === 'waiting' && old.expires > Date.now() && (old.extensionId !== extensionId || old.token !== token))
            throw new Error('A browser approval is already pending.');
          if (!old || old.state !== 'waiting' || old.expires < Date.now()) {
            this.connectionRequest = { id: randomUUID(), extensionId, token, label, expires: Date.now() + 120_000, state: 'waiting' };
            this.requestAttention?.();
          }
          res.end(JSON.stringify({ requestId: this.connectionRequest!.id }));
        } else {
          const { requestId } = z.object({ requestId: z.string().uuid() }).parse(data);
          const pending = this.connectionRequest;
          if (
            !pending ||
            pending.id !== requestId ||
            pending.extensionId !== extensionId ||
            pending.token !== token ||
            pending.expires < Date.now()
          )
            throw new Error('Connection request expired.');
          res.end(JSON.stringify({ state: pending.state }));
        }
      } else if (req.url === '/connect') {
        const tab = ConnectSchema.parse(data);
        if (!/^https?:$/.test(new URL(tab.url).protocol)) throw new Error('Choose a regular http or https page.');
        if (this.clientId && Date.now() - this.lastSeen < LOST_MS && !this.trustedExtensionId)
          throw new Error('A tab is already connected. Stop sharing it before allowing another.');
        this.stop();
        this.observation = null;
        this.clientId = randomUUID();
        this.origin = new URL(tab.url).origin;
        this.lastSeen = Date.now();
        this.state.tab = tab;
        this.state.phase = 'ready';
        this.state.tabs = tab.id ? [{ id: tab.id, title: tab.title, url: tab.url }] : [];
        this.selectedTabId = tab.id ?? null;
        this.retiredTabs.clear();
        this.note('Tab allowed. Reading the page for your questions. Start a task to fill fields or choose options.');
        res.end(JSON.stringify({ clientId: this.clientId }));
      } else if (req.url === '/tick') {
        res.end(JSON.stringify(await this.tick(TickSchema.parse(data))));
      } else if (req.url === '/tabs/remove') {
        const body = z.object({ clientId: z.string().uuid(), id: z.string().min(1).max(80) }).parse(data);
        if (body.clientId !== this.clientId) throw new Error('Not connected.');
        this.stop();
        this.retiredTabs.add(body.id);
        this.state.tabs = this.state.tabs.filter((tab) => tab.id !== body.id);
        this.observation = null;
        if (!this.state.tabs.length) this.revokeTab('Tab access revoked.');
        else {
          const selected = this.state.tabs.find((tab) => tab.id === this.selectedTabId) ?? this.state.tabs[0]!;
          this.selectedTabId = selected.id;
          this.origin = new URL(selected.url).origin;
          this.state.tab = { title: selected.title, url: selected.url };
          this.state.phase = 'ready';
          this.note('Tab removed. The remaining allowed tabs are ready.');
        }
        res.end('{}');
      } else if (req.url === '/tabs/allow' || req.url === '/tabs/select') {
        const body = z.object({ clientId: z.string().uuid(), tab: ConnectSchema.extend({ id: z.string().min(1).max(80) }) }).parse(data);
        if (body.clientId !== this.clientId || !/^https?:$/.test(new URL(body.tab.url).protocol)) throw new Error('Not allowed.');
        if (this.reading || this.state.phase === 'running' || this.state.phase === 'review')
          throw new Error('Stop the current task before changing the tab group.');
        const existing = this.state.tabs.find((t) => t.id === body.tab.id);
        if (req.url === '/tabs/select' && (!existing || new URL(existing.url).origin !== new URL(body.tab.url).origin))
          throw new Error('Tab not allowed.');
        if (!existing && this.state.tabs.length >= 8) throw new Error('Up to eight tabs can be allowed in a group.');
        this.state.tabs = [...this.state.tabs.filter((t) => t.id !== body.tab.id), body.tab];
        this.retiredTabs.delete(body.tab.id);
        this.selectedTabId = body.tab.id;
        this.origin = new URL(body.tab.url).origin;
        this.state.tab = body.tab;
        this.observation = null;
        this.state.phase = 'ready';
        res.end('{}');
      } else if (req.url?.startsWith('/chat')) {
        const body = z.object({ clientId: z.string().uuid() }).passthrough().parse(data);
        if (body.clientId !== this.clientId) throw new Error('Not connected.');
        if (req.url === '/chat/send') {
          const message = z.object({ id: z.string().uuid(), text: z.string().trim().min(1).max(6000) }).parse(body);
          // Respond immediately; a local model call must not block status polling or Stop.
          void this.chat(message.id, message.text).catch((e: Error) => this.reply(e.message));
        } else if (req.url === '/chat/stop') this.stop();
        else if (req.url === '/chat/clear') {
          this.stop();
          this.state.messages = [];
        } else if (req.url !== '/chat/status') throw new Error('Unknown chat request.');
        res.end(JSON.stringify(this.status()));
      } else if (req.url === '/disconnect') {
        const { clientId } = z.object({ clientId: z.string().uuid() }).parse(data);
        if (clientId !== this.clientId) throw new Error('Not connected.');
        this.revokeTab('Browser tab access revoked.');
        res.end('{}');
      } else if (req.url === '/permit') {
        const { clientId, runId, commandId } = z
          .object({ clientId: z.string().uuid(), runId: z.string().uuid(), commandId: z.string().uuid() })
          .parse(data);
        this.checkLease();
        res.end(
          JSON.stringify({
            allowed:
              clientId === this.clientId && runId === this.runId && commandId === this.inFlight?.id && this.state.phase === 'running',
          }),
        );
      } else {
        res.writeHead(404).end('{}');
      }
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end(JSON.stringify({ error: 'Browser request rejected. Reconnect the tab and check approval in Doing.' }));
    }
  }
}
