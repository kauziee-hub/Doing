/**
 * Does a question point at something on the screen ("add RBAC to this code", "what does this
 * function do", "can you see my screen")? Used by the `auto` screen setting: only those
 * questions carry a screen capture, so the rest stay as fast as before.
 *
 * Conversation is full of "this", "that", "it" and "see" that have nothing to do with a screen
 * ("Where do you see yourself in five years?", "How do you look at failure?", "Tell me about one
 * of those projects", "What did you learn from this project?", "How would you improve it?").
 * A capture for those adds 1-3 s and can answer about whatever happens to be on screen, so a
 * match needs something shown: a named thing (code, slide, query...), the screen itself, or a
 * bare "this"/"here" as the object of a task ("fix this", "add RBAC to this").
 */
const SHOWN_THINGS =
  'code|snippet|function|method|class|module|file|script|program|query|schema|table|diagram|design|architecture|slide|page|doc|document|screen|error|exception|bug|output|log|stack ?trace|ui|form|component|api|endpoint|route|handler|controller|service|model|middleware|chart|graph|config|test|repo|implementation|example|algorithm|line|step|option';

/** Nouns that make "this/that X" about the conversation, not the screen. */
const TALK_THINGS = 'company|role|team|position|job|interview|call|meeting|project|experience|internship|course|hackathon|competition|situation|time|question|problem|idea|work|point|decision|answer|challenge';

const PATTERNS: RegExp[] = [
  // "this/that/these/the above/the following <shown thing>"
  new RegExp(`\\b(this|that|these|those|above|following|current|shared|same)\\s+(\\w+\\s+)?(${SHOWN_THINGS})s?\\b`, 'i'),
  // "which of these routes", "which one of those": a set of shown things (not "those projects").
  new RegExp(`\\b(which|what|any|all|each|some|none) (one )?of (these|those)\\b(?!\\s+(\\w+\\s+)?(${TALK_THINGS})s?\\b)`, 'i'),
  // Explicit references to the screen or to something being shown.
  /\b(on|in) (the|my|your|this) (screen|slide|page|window|editor|tab|terminal|share)\b/i,
  /\b(screen ?share|sharing (my|the|your) screen|i'?m sharing|i am sharing|i'?m showing|i am showing|i'?ve shared|shown here|see here|over here|right here)\b/i,
  // Looking at something: "can you see my screen", "look at this", but not "see yourself" or "look at failure".
  /\b(you can see|can you see|do you see|look at|looking at|take a look at)\s+(this|these|those|here|my (screen|code|slide)|the (screen|code|slide|page|diagram|error|output)|what i'?m)\b/i,
  // A task on a bare "this"/"here": "fix this", "add RBAC to this", "explain what's here".
  /\b(add|implement|apply|establish|integrate|refactor|fix|debug|optimi[sz]e|explain|review|improve|extend|change|update|convert|complete|finish|secure)\b[^.?!]{0,60}\b(this|here)\b(?!\s+(\w+\s+)?(company|role|team|position|job|interview|call|meeting|project|experience|internship|course|hackathon|competition|situation|time)\b)/i,
  /\b(in|into|to|from|on) (this|here)\b(?!\s+(\w+\s+)?(company|role|team|position|job|interview|call|meeting|project|experience|internship|course|hackathon|competition|situation|time)\b)/i,
];

export function refersToScreen(question: string): boolean {
  const q = question.trim();
  if (!q) return false;
  return PATTERNS.some((p) => p.test(q));
}
