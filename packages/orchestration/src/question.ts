const INTERROGATIVE_START =
  /^(?:so,?\s+|and\s+|okay,?\s+|ok,?\s+|alright,?\s+|now,?\s+|well,?\s+|great,?\s+)?(what|what's|whats|why|how|when|where|who|whom|whose|which|can|could|would|will|do|does|did|is|are|was|were|have|has|had|should|shall|may|might|tell me|walk me|describe|explain|give me|talk (?:me )?(?:through|about)|share|name|list|define|compare|implement|write|design)\b/i;

const QUESTION_PHRASES =
  /\b(what about|how about|why should we|tell me about|walk me through|how would you|what would you|can you (?:explain|tell|describe|walk|give)|could you (?:explain|tell|describe|walk|give)|describe a time|give (?:me )?an example|why do you|why did you|what is your|what's your|what are your|how do you|how did you|what do you think|any questions|difference between|what happens (?:if|when)|how does|time complexity|what is the|what are the)\b/i;

/** Interviewer requests that expect an answer but are phrased as statements (no "?"). */
const ANSWER_REQUEST =
  /\b(i'?d (?:like|love) to (?:hear|know|learn|understand)|i want to (?:hear|know|understand)|let'?s (?:talk|discuss|start with|move on to|dive into|go through)|please (?:explain|describe|tell|walk|share|introduce|talk)|introduce yourself|(?:introduction|summary|overview) (?:about|of) yourself|give (?:me |us )?(?:a |an )?(?:brief |short |quick )?(?:introduction|overview|summary|example))\b/i;

/** A wh-question clause anywhere ("…because if I use it what is the difference…"). STT often drops the "?". */
const WH_CLAUSE = /\b(what|how|why|which|where|when|who)\s+(is|are|was|were|do|does|did|would|could|can|should|will|have|has)\b/i;

const FOLLOW_UP =
  /^(?:and |but |so )?(why|how so|how come|what else|then what|such as|for example|like what|can you elaborate|elaborate|go on|tell me more|what about (?:it|that|this)|and then|why not|really)\??\.?$/i;

/**
 * Keeps the question part of an utterance: everything up to the last '?' when the
 * tail after it is short filler/noise (STT sometimes appends stray words after a pause).
 */
export function extractQuestion(text: string): string {
  const t = text.trim();
  const idx = t.lastIndexOf('?');
  if (idx === -1 || idx === t.length - 1) return t;
  const tail = t.slice(idx + 1).trim();
  if (tail.length > 0 && analyzeQuestion(tail).score < 0.5 && tail.split(/\s+/).length <= 12) return t.slice(0, idx + 1);
  return t;
}

export interface QuestionAnalysis {
  score: number;
  isQuestion: boolean;
  isFollowUp: boolean;
}

/**
 * Cheap, deterministic interrogative-intent scoring on finalized transcript
 * text. Manual "Ask" always works regardless of this score.
 */
export function analyzeQuestion(raw: string): QuestionAnalysis {
  const text = raw.trim().replace(/\s+/g, ' ');
  if (!text) return { score: 0, isQuestion: false, isFollowUp: false };
  const words = text.split(' ').length;
  const isFollowUp = FOLLOW_UP.test(text);
  let score = 0;
  if (/\?\s*["')\]]?\s*$/.test(text)) score += 0.6;
  else if (text.includes('?')) score += 0.35;
  // Look at the start of the last sentence too ("I see you built X. How did you scale it")
  const sentences = text.split(/(?<=[.!?])\s+/);
  const last = sentences[sentences.length - 1] ?? text;
  // Also each clause: a greeting or name often comes first ("Hello, Katty, give me a brief introduction").
  const clauses = text.split(/[,;:]\s+|(?<=[.!?])\s+/);
  if (INTERROGATIVE_START.test(text) || INTERROGATIVE_START.test(last) || clauses.some((c) => INTERROGATIVE_START.test(c))) score += 0.45;
  else if (WH_CLAUSE.test(text)) score += 0.3;
  if (QUESTION_PHRASES.test(text)) score += 0.35;
  if (ANSWER_REQUEST.test(text)) score += 0.55;
  if (isFollowUp) score += 0.5;
  if (words < 3 && !isFollowUp) score -= 0.35;
  if (/^(yes|yeah|yep|no|nope|okay|ok|right|sure|thanks|thank you|mm+|uh+|um+|hmm+)\b[.!]?$/i.test(text)) score = 0;
  score = Math.max(0, Math.min(1, score));
  return { score, isQuestion: score >= 0.5, isFollowUp };
}
