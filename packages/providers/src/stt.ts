import type { SttProviderId } from '@doing/contracts';
import type { ProviderError } from './errors';

export interface SttOptions {
  /** Language code (e.g. en, en-US). Empty = automatic detection. */
  language: string;
  vocabulary: string[];
}

export interface SttHandlers {
  /** Speculative text for the utterance in progress (replaces the previous interim). */
  onInterim(text: string): void;
  /** Stable text to append to the utterance in progress. */
  onFinalSegment(text: string): void;
  /** The provider believes the speaker finished this utterance. */
  onUtteranceEnd(): void;
  onError(err: ProviderError): void;
  /** Connection closed. `expected` is true when we closed it ourselves. */
  onClose(expected: boolean, reason: string): void;
}

export interface SttSession {
  sendAudio(pcm16le: Buffer): boolean;
  endOfSpeech(): void;
  /** The speaker just went quiet (may resume). Utterance transcribers refresh their live text now. */
  silenceStarted?(): void;
  close(): void;
  readonly isOpen: boolean;
  readonly bufferedBytes: number;
}

export interface StreamingTranscriptionProvider {
  readonly id: SttProviderId;
  readonly label: string;
  /** Provider-enforced maximum continuous session length, or null. */
  readonly maxSessionMs: number | null;
  /** Wants endOfSpeech() when the local VAD hears speech stop (Whisper utterances). */
  readonly wantsEndOfSpeech?: boolean;
  /** Silence that ends an utterance for the local VAD (default 450 ms). Fast local finals use less. */
  readonly speechEndHangoverMs?: number;
  open(opts: SttOptions, handlers: SttHandlers, signal?: AbortSignal): Promise<SttSession>;
}
