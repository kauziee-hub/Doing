/**
 * Does a question point at something on the screen ("add RBAC to this code", "what does this
 * function do", "can you see my screen")? Used by the `auto` screen setting: only those
 * questions carry a screen capture, so the rest stay as fast as before.
 */
const SHOWN_THINGS =
  'code|snippet|function|method|class|module|file|script|program|query|schema|table|diagram|design|architecture|slide|page|doc|document|screen|error|exception|bug|output|log|stack ?trace|ui|form|component|api|endpoint|route|handler|controller|service|model|middleware|chart|graph|config|test|repo|project|implementation|example|problem|question|algorithm|line|step|option';

const PATTERNS: RegExp[] = [
  // "this/that/these/the above/the following <thing>"
  new RegExp(`\\b(this|that|these|those|above|following|current|shared|same)\\s+(\\w+\\s+)?(${SHOWN_THINGS})s?\\b`, 'i'),
  // "which of these", "any of those": pointing at a set of shown things.
  /\b(which|what|any|all|each|some|none) (one )?of (these|those|them)\b/i,
  /\b(these|those)\b/i,
  // Explicit references to the screen or to something being shown.
  /\b(on|in) (the|my|your|this) (screen|slide|page|window|editor|tab|terminal|share)\b/i,
  /\b(screen ?share|sharing|i'?m showing|i am showing|i'?ve shared|shown here|you can see|can you see|do you see|look at|looking at|see here|over here|right here)\b/i,
  // Tasks on an unnamed shown thing: "add RBAC to this", "fix this", "explain this", "in here".
  /\b(add|implement|apply|establish|integrate|refactor|fix|debug|optimi[sz]e|explain|review|improve|extend|change|update|convert|complete|finish|test|secure)\b[^.?!]{0,60}\b(this|that|it|here)\b/i,
  /\b(in|into|to|from|on) (this|here)\b(?!\s+(company|role|team|position|job|interview|call|meeting))/i,
];

export function refersToScreen(question: string): boolean {
  const q = question.trim();
  if (!q) return false;
  return PATTERNS.some((p) => p.test(q));
}
