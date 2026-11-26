import { asksAboutShownProblem } from './screen';

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

/** Only filler words: "okay", "yeah, sure", "hmm". */
const FILLER_ONLY =
  /^(?:(?:hey|hi|hello|oh|ok|okay|alright|so|um+|uh+|hmm+|mm+|yeah|yes|yep|no|nope|right|sure|cool|nice|great|good|perfect|thanks|thank you|got it|i see|makes sense|fine)[\s,.!?]*)+$/i;
/** Talk that is never meant to be answered: asking someone to wait or come over. */
const CHATTER = /\b(wait (?:a|one|for a) (?:minute|second|sec|moment|bit)|hold on|one (?:sec|second|moment|minute)|give me (?:a|one) (?:second|sec|minute|moment)|come here|come (?:over|inside|in)|be right back|brb|just a (?:second|sec|minute|moment))\b/i;
/** Call logistics: audio, video, screen sharing. Usually not an interview question. */
const LOGISTICS = /\b(hear me|hear you|see my screen|see your screen|share (?:your|my|the) screen|screen ?share|on mute|unmute|you'?re muted|my audio|your audio|my mic|your mic|connection|lagging|frozen|my camera|your camera|video is off|turn on (?:your|the) (?:camera|video))\b/i;
/** Starts by calling someone by name: "Hey Rahul, …", "Priya, can you …". */
const VOCATIVE = /^(?:(?:hey|hi|hello|oi|yo|listen|ok|okay|so),?\s+)?[A-Z][a-z]+,\s/;
/** Casual-question signals worth a closer look even without a "?" ("so ur last company what stack u used"). */
const CASUAL_SIGNAL = /\?|\b(you|your|yourself|u|ur|urself|what|why|how|when|where|which|who|tell|explain|describe|walk|talk|share|show|give|elaborate|difference|experience|project)\b/i;

/** A question aimed at the candidate, or a classic interview/technical request. */
const INTERVIEW_SIGNAL = /\b(you|your|yourself|explain|describe|walk me|tell me|compare|design|implement|difference between|how would|how does|how do|what are the|why should)\b/i;
/** People don't swear at candidates: likely a reaction in the room or on a video. */
const PROFANITY = /\b(fuck\w*|f\*+k|shit\w*|damn|wtf|crap|bloody|bullshit)\b/i;

export type Triage = 'answer' | 'check' | 'ignore';

/**
 * First pass over what the other side said, before any answer starts (a new answer
 * cancels the one on screen, so chatter must never reach the answer engine):
 * - `ignore`: filler, "wait a minute", "hey Rahul, come here";
 * - `answer`: an unmistakable, complete question (no extra latency);
 * - `check`: anything that might be a question (casual, short, addressed by name,
 *   call logistics). A quick model check decides with the conversation as context.
 */
export function triageUtterance(raw: string): { triage: Triage; score: number } {
  const text = raw.trim().replace(/\s+/g, ' ');
  const { score } = analyzeQuestion(text);
  const words = text ? text.split(' ').length : 0;
  if (!text || FILLER_ONLY.test(text) || isFragment(text)) return { triage: 'ignore', score: 0 };
  // A coding problem put on the screen ("Here's the problem, take your time", "open the link I
  // sent"): not phrased as a question, but it asks for an answer from the screen.
  if (asksAboutShownProblem(text)) return { triage: 'answer', score: Math.max(score, 0.8) };
  if (CHATTER.test(text) && score < 0.5) return { triage: 'ignore', score };
  const vocative = VOCATIVE.test(text);
  const logistics = LOGISTICS.test(text);
  // Instant answer only for questions clearly aimed at the candidate or clearly interview-style;
  // anything else that looks like a question (reactions, swearing, small talk) gets the check.
  const clean = !vocative && !logistics && !PROFANITY.test(text) && INTERVIEW_SIGNAL.test(text);
  if (clean && ((score >= 0.8 && words >= 5) || (ANSWER_REQUEST.test(text) && score >= 0.5))) return { triage: 'answer', score };
  if (score >= 0.3 || (words >= 4 && CASUAL_SIGNAL.test(text))) return { triage: 'check', score };
  return { triage: 'ignore', score };
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Whether live text and the final transcript ask the same thing, so an answer started
 * from the live text can stand: one contains the other with at most 3 extra words at
 * the end (the tail the live text hadn't caught yet), or they share almost all words.
 */
export function sameQuestion(a: string, b: string): boolean {
  const A = words(a);
  const B = words(b);
  if (A.length === 0 || B.length === 0) return false;
  const within = (short: string[], long: string[]): boolean => {
    for (let i = 0; i + short.length <= long.length; i++) {
      let ok = true;
      for (let j = 0; j < short.length; j++) {
        if (short[j] !== long[i + j]) {
          ok = false;
          break;
        }
      }
      if (ok) return long.length - (i + short.length) <= 3;
    }
    return false;
  };
  if (within(A, B) || within(B, A)) return true;
  const setA = new Set(A);
  const setB = new Set(B);
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  const jaccard = inter / (setA.size + setB.size - inter);
  return jaccard >= 0.85 && Math.abs(A.length - B.length) <= 3;
}

/** Ends on a word that needs more after it: "Can you tell me", "the difference between". */
const DANGLING = /\b(?:(?:tell|show|give|walk|remind) me|about|the|a|an|to|of|and|or|but|with|for|your|tell|explain|describe|between|regarding|like to)\s*[,.?!…-]*$/i;

/** Speech that stopped mid-question (a pause, not the end): never answered on its own. */
export function isFragment(text: string): boolean {
  const t = text.trim();
  return !t || DANGLING.test(t);
}
