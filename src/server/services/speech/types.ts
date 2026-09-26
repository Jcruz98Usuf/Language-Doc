/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Local text-to-speech contract (Phase 7B, Stage 1 - standard voice).
 *
 * This is the exact counterpart of the speech-to-text contract: the browser
 * calls `POST /api/speech/synthesize` and receives playable audio. Which engine,
 * model and voice answer is decided server side and nowhere else, and the
 * browser never talks to the engine.
 *
 *   Browser -> POST /api/speech/synthesize -> TextToSpeechProvider -> audio/wav
 *
 * Why the browser engine was replaced: `window.speechSynthesis` is implemented
 * by the operating system or the browser vendor and, on several platforms, by a
 * remote service, so voice output contradicted the local-first guarantee the
 * rest of the application is built on. Everything here runs on this machine.
 */

/** Languages with a local voice in this build. */
export const TTS_LANGUAGES = ["english", "french"] as const;
export type TtsLanguage = (typeof TTS_LANGUAGES)[number];

/**
 * Only the model's built-in catalogue voices are available. Voice matching
 * ("clone") is a separate Stage 2 capability that needs the gated
 * kyutai/pocket-tts cloning weights, which are not installed; it is recognised
 * here so it can be refused honestly instead of silently ignored.
 */
export const TTS_VOICE_MODES = ["standard", "clone"] as const;
export type TtsVoiceMode = (typeof TTS_VOICE_MODES)[number];

/** Hard cap on one request. Mirrors the sidecar's own cap. */
export const MAX_TTS_TEXT_CHARS = 500;

/**
 * Normalizes the text to speak and enforces the request limits.
 *
 * Rejection is explicit: text that is too long is refused rather than silently
 * truncated, so the UI can say what happened instead of playing something the
 * user did not ask for.
 */
export function normalizeSpeechText(value: unknown): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length === 0) {
    throw new TtsError("empty-text", "There is nothing to play for that line.");
  }
  if (text.length > MAX_TTS_TEXT_CHARS) {
    throw new TtsError(
      "text-too-long",
      `Local voice playback handles up to ${MAX_TTS_TEXT_CHARS} characters. ` +
        "This line is longer - please read it on screen instead."
    );
  }
  return text;
}

export type TtsErrorCode =
  | "unsupported-language"
  | "unsupported-voice-mode"
  | "voice-matching-unavailable"
  | "text-too-long"
  | "empty-text"
  | "bad-request"
  | "busy"
  | "timeout"
  | "cancelled"
  | "engine-unavailable"
  | "synthesis-failed";

export class TtsError extends Error {
  readonly code: TtsErrorCode;

  constructor(code: TtsErrorCode, message: string) {
    super(message);
    this.name = "TtsError";
    this.code = code;
  }
}

export function isTtsError(error: unknown): error is TtsError {
  return error instanceof TtsError;
}

export interface SpeechRequest {
  /** Text to speak, already normalized by the facade. */
  text: string;
  /** Validated language id: "english" or "french". */
  language: TtsLanguage;
  /** Validated voice mode: "standard" in this build. */
  voiceMode: TtsVoiceMode;
  signal?: AbortSignal;
}

export interface SynthesizedSpeech {
  /** Complete 16-bit PCM WAV, held in memory only. */
  audio: Buffer;
  mimeType: "audio/wav";
  sampleRate: number;
  /** Length of the generated speech, for the UI and for real-time-factor logs. */
  durationSeconds: number;
  provider: string;
  model: string;
  voice: string;
  voiceMode: TtsVoiceMode;
  /** Wall-clock synthesis time reported by the engine. */
  synthesisMs: number;
  /** Time the engine spent loading the model for this request (0 when already hot). */
  modelLoadMs?: number;
  /** Time from synthesis start to the first decoded audio chunk. */
  firstAudioMs: number;
  /** True when the engine hit the hard audio-duration ceiling for this request. */
  truncated?: boolean;
  /** True when the clip was served from the in-memory replay cache. */
  cached: boolean;
}

export interface SpeechReadiness {
  ready: boolean;
  detail: string;
}

export interface TextToSpeechProvider {
  /** Stable id used in configuration and the health endpoint. */
  readonly id: string;
  /** Human readable label for reports and logs. */
  readonly label: string;
  /** Cheap probe used by the health endpoint before any audio is requested. */
  readiness(): Promise<SpeechReadiness>;
  /** Synthesizes one utterance. Throws TtsError on failure. */
  synthesize(request: SpeechRequest): Promise<SynthesizedSpeech>;
}

/** Friendly aliases so callers can pass "en"/"fr" as well as full names. */
const LANGUAGE_ALIASES: Record<string, TtsLanguage> = {
  en: "english",
  eng: "english",
  english: "english",
  fr: "french",
  fra: "french",
  french: "french",
};

export function normalizeTtsLanguage(value: unknown): TtsLanguage | null {
  const key = String(value ?? "").trim().toLowerCase();
  return LANGUAGE_ALIASES[key] ?? null;
}

export function isTtsLanguageSupported(value: unknown): boolean {
  return normalizeTtsLanguage(value) !== null;
}

/**
 * Resolves the requested voice mode. Unknown values are rejected (never coerced
 * to a default) because silently speaking with the wrong voice is worse than
 * saying that the request cannot be served.
 */
export function normalizeVoiceMode(value: unknown): TtsVoiceMode | null {
  const key = String(value ?? "standard").trim().toLowerCase();
  return (TTS_VOICE_MODES as readonly string[]).includes(key) ? (key as TtsVoiceMode) : null;
}
