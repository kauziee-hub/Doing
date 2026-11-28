import type { DesktopAction, DesktopControl, DesktopView } from './desktop';

export interface MessageGoal {
  recipient: string;
  body: string;
  send: boolean;
  frequent?: boolean;
}
const clean = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
export function requestsMessageSend(text: string): boolean {
  text=text.replace(/["“][\s\S]*["”]/g,' [quoted message] ');
  if (/\b(?:don't|do not|dont|never|draft|not yet|without sending)\b/i.test(text)) return false;
  return (
    /\b(?:send|post|publish|submit|apply|confirm|save)\b/i.test(text) ||
    /^(?:(?:please|just|now|yes|okay|ok)\b[, ]*|(?:can|could|would) you\s+)*(?:message|text|dm)\s+/i.test(text.trim())
  );
}

/** Carry only an unfinished, host-owned message, never an old model summary. */
export function messageRequest(text: string, pending: MessageGoal | null = null): MessageGoal | null {
  const t = text.trim();
  let match =
    /^(?:(?:please|just)\s+|(?:can|could|would) you\s+)?(?:message|text|dm|send(?: a message)? to)\s+(.+?)\s+(?:in|on|via|using)\s+whatsapp\s*:?\s*["“]([\s\S]+)["”]\s*[.!]?$/i.exec(
      t,
    );
  if (!match)
    match = /^(?:please\s+)?(?:send|draft)\s+["“]([\s\S]+)["”]\s+to\s+(.+?)\s+(?:in|on|via|using)\s+whatsapp[.!]?$/i
      .exec(t)
      ?.map((v, i, a) => (i === 1 ? a[2]! : i === 2 ? a[1]! : v)) as RegExpExecArray | null;
  if (match) return { recipient: match[1]!.trim(), body: match[2]!, send: requestsMessageSend(t) };
  if (
    pending &&
    /\b(?:send|message|text|dm)\b/i.test(t) &&
    /\b(?:it|the message|same message|most frequent|frequently contacted)\b/i.test(t)
  ) {
    if (/\b(?:instead|different|another|new message|change the message)\b/i.test(t)) return null;
    const directed =
      /\bto\s+(.+?)\s*[.!]?$/i.exec(t)?.[1] ??
      /\b(?:message|text|dm)\s+(?:the most frequent\s+)?(.+?)\s+(?:the|same) message/i.exec(t)?.[1];
    return {
      ...pending,
      ...(directed ? { recipient: directed.trim() } : {}),
      send: requestsMessageSend(t),
      frequent: /\b(?:most frequent|frequently contacted)\b/i.test(t),
    };
  }
  return null;
}

export const isComposer = (c: DesktopControl) =>
  c.actions.includes('type') && /message|compose|chat input/i.test(c.name) && !/search|find/i.test(c.name);
const evidence = (c: DesktopControl) => `${c.name} ${c.context ?? ''}`;
export function recipientVisible(view: DesktopView, recipient: string): boolean {
  const name = clean(recipient);
  return (
    view.controls.some((c) => {
      const label = clean(c.name).replace(
        /^(?:chat with|conversation with|contact|chat header)\s*:\s*|^(?:chat with|conversation with)\s+/,
        '',
      );
      return (
        label === name &&
        (/^(?:chat with|conversation with|contact:|chat header:)/i.test(c.name) ||
          /(?:chat|conversation|contact).{0,12}(?:header|title|info)|(?:header|title).{0,12}(?:chat|conversation|contact)|role=banner|type=50034/i.test(
            c.context ?? '',
          ))
      );
    }) || clean(view.title) === `${name} - whatsapp`
  );
}
function occurrences(view: DesktopView, body: string): number {
  return view.controls.filter(
    (c) =>
      !c.actions.includes('type') &&
      !/Edit|ComboBox/i.test(c.type) &&
      (c.name === body ||
        c.name.endsWith(`: ${body}`) ||
        (c.name.includes(body) && /outgoing|sent message|message bubble|role=log|role=row/i.test(c.context ?? ''))),
  ).length;
}

/** All send checks use the fresh app observation and exact user-authored payload. */
export class MessageTask {
  attempted = false;
  constructor(readonly goal: MessageGoal) {}
  instruction(): string {
    return `${this.goal.send ? 'Send' : 'Draft'} the exact message ${JSON.stringify(this.goal.body)} to ${JSON.stringify(this.goal.recipient)} in WhatsApp. Search contacts, open the matching chat, verify its header, then type the exact message.${this.goal.frequent ? ' Choose the most frequent matching contact only if observed frequency evidence identifies one; otherwise ask which contact.' : ''}`;
  }
  next(view: DesktopView): DesktopAction | { kind: 'answer' | 'done'; text: string } | null {
    const composer = view.controls.find(isComposer);
    if (recipientVisible(view, this.goal.recipient) && composer) {
      if (composer.value !== this.goal.body) return { kind: 'app_action', target: composer.id, action: 'type', text: this.goal.body };
      if (!this.goal.send) return { kind: 'done', text: `The exact draft is ready in ${this.goal.recipient}’s chat.` };
      const send = view.controls.filter((c) => c.actions.includes('click') && /^(?:send|send message)$/i.test(c.name));
      if (send.length === 1) return { kind: 'app_action', target: send[0]!.id, action: 'click' };
      if (composer.actions.includes('enter')) return { kind: 'app_action', target: composer.id, action: 'enter' };
      return null;
    }
    if (this.ambiguous(view))
      return {
        kind: 'answer',
        text: 'Several contacts match, and WhatsApp has not shown which is most frequent. Tell me the exact contact.',
      };
    const search = view.controls.filter((c) => c.actions.includes('type') && /search|find/i.test(c.name));
    if (search.length === 1 && clean(search[0]!.value) !== clean(this.goal.recipient))
      return { kind: 'app_action', target: search[0]!.id, action: 'type', text: this.goal.recipient };
    const exact = view.controls.filter(
      (c) => c.actions.includes('click') && clean(c.name).replace(/^open (.+) chat$/, '$1') === clean(this.goal.recipient),
    );
    if (exact.length === 1) return { kind: 'app_action', target: exact[0]!.id, action: 'click' };
    return null;
  }
  guard(view: DesktopView, action: DesktopAction, control: DesktopControl): boolean {
    if (this.ambiguous(view) && (action.action === 'enter' || (action.action === 'click' && /ListItem|DataItem/i.test(control.type))))
      throw new Error('Several contacts match and their frequency is not verified. Tell me the exact contact. Nothing was sent.');
    if (!/^WhatsApp(?:\.|$)/i.test(view.process) && view.process !== 'DoingMessagingFixture')
      throw new Error('The message task must stay in WhatsApp. Nothing was sent.');
    const sending = (action.action === 'enter' && isComposer(control)) || /^(?:send|send message)(?:\s|$)/i.test(control.name);
    if (action.action === 'type' && isComposer(control)) {
      if (!recipientVisible(view, this.goal.recipient)) throw new Error('The intended chat header is not verified. Nothing was sent.');
      if (action.text !== this.goal.body) throw new Error('The proposed message differs from your exact text. Nothing was sent.');
    } else if (
      action.action === 'type' &&
      (!/search|find/i.test(control.name) || clean(action.text ?? '') !== clean(this.goal.recipient))
    ) {
      throw new Error('Only the requested contact search and exact message may be typed. Nothing was sent.');
    }
    if (
      this.goal.frequent &&
      action.action === 'click' &&
      /ListItem|DataItem/i.test(control.type) &&
      view.controls.filter(
        (c) => c.actions.includes('click') && /ListItem|DataItem/i.test(c.type) && clean(c.name).startsWith(clean(this.goal.recipient)),
      ).length > 1 &&
      !/most frequent|frequently contacted.*(?:first|rank 1)|frequency rank:?\s*1\b/i.test(evidence(control))
    )
      throw new Error('The selected contact is not the observed most frequent match. Nothing was sent.');
    if (sending) {
      if (this.attempted) throw new Error('Send was already attempted. Check the chat before sending again.');
      if (!this.goal.send) throw new Error('This message is a draft. Nothing was sent.');
      if (!recipientVisible(view, this.goal.recipient)) throw new Error('The intended chat header is not verified. Nothing was sent.');
      if (!view.controls.some((c) => isComposer(c) && c.value === this.goal.body))
        throw new Error('The exact message is not visible in the composer. Nothing was sent.');
    }
    // Enter in a search box is search, not sending a message.
    return sending;
  }
  confirmed(before: DesktopView, after: DesktopView): boolean {
    return (
      recipientVisible(after, this.goal.recipient) &&
      after.controls.some((c) => isComposer(c) && !c.value.trim()) &&
      occurrences(after, this.goal.body) > occurrences(before, this.goal.body)
    );
  }
  result(): string {
    return `Your message appears in ${this.goal.recipient}’s WhatsApp chat.`;
  }
  incomplete(reason: string): string {
    if (!this.goal.send) return `Draft only. ${reason}`;
    return `Not sent. ${/\?|couldn't|cannot|can't|unavailable|not accessible|which|missing/i.test(reason) ? reason : 'The message task did not finish. Check the chat or tell me which contact to use.'}`;
  }
  ambiguous(view: DesktopView): boolean {
    const matches = view.controls.filter(
      (c) => c.actions.includes('click') && /ListItem|DataItem/i.test(c.type) && clean(c.name).startsWith(clean(this.goal.recipient)),
    );
    if (matches.length < 2) return false;
    return (
      !this.goal.frequent ||
      matches.filter((c) => /most frequent|frequently contacted.*(?:first|rank 1)|frequency rank:?\s*1\b/i.test(evidence(c))).length !== 1
    );
  }
}
