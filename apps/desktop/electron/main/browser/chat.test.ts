import { describe, expect, it } from 'vitest';
import { approvesPending, requestsSubmission } from './chat';

describe('submission permission expressed in chat', () => {
  it('recognizes requests to submit or continue without a checkbox', () => {
    expect(requestsSubmission('Fill the answers, submit each page and go next until results.')).toBe(true);
    expect(requestsSubmission('Save this application now.')).toBe(true);
    expect(requestsSubmission('Submit all remaining pages without asking again.')).toBe(true);
    expect(requestsSubmission('Select the answers without asking me again.')).toBe(false);
    expect(approvesPending('Yes, go ahead and submit.')).toBe(true);
  });
  it('does not treat negated instructions or ordinary typing as submission permission', () => {
    for (const text of [
      'Fill the answers, do not submit.',
      "Don't submit yet",
      'Type the code without submitting it',
      'Do not submit without asking again.',
      'Only explain the submit button',
      'Fill the answers',
    ])
      expect(requestsSubmission(text)).toBe(false);
    for (const text of ['no', 'not yet', 'wait, do not submit', 'stop', 'Tell me about the page'])
      expect(approvesPending(text)).toBe(false);
  });
});
