/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Local speech-to-text contract (Phase 7A).
 *
 * Speech is transcribed on this machine, never by a cloud service. The browser
 * records raw audio, POSTs it to Express, and Express hands it to a local engine
 * running in this process (or, optionally, a local sidecar). No audio is written
 * to disk, and no audio leaves the host.
 *
 *   Browser mic (laptop) -> POST /api/transcribe -> SpeechToTextProvider -> text
 *
 * The browser is never told which engine answered and never talks to it.
 */

/** Local STT failure modes, surfaced to the UI as an honest banner. */
export type SttErrorCode =
  | "unavailable"
  | "model-missing"
  | "bad-audio"
  | "too-short"
  | "too-long"
  | "unsupported-language"
  | "empty-transcript"
  | "timeout"
  | "cancelled"
  | "failed";

export class SttError extends Error {
  readonly code: SttErrorCode;

  constructor(code: SttErrorCode, message: string) {
    super(message);
    this.name = "SttError";
    this.code = code;
  }
}

export function isSttError(error: unknown): error is SttError {
  return error instanceof SttError;
}

/**
 * Mono audio at the rate the engine expects. Providers receive float samples in
 * [-1, 1]; the HTTP layer does the PCM/WAV decoding and resampling.
 */
export interface PcmAudio {
  samples: Float32Array;
  sampleRate: number;
}

export interface TranscriptionRequest {
  audio: PcmAudio;
  /** Whisper language name ("english", "swahili", "french"), already validated. */
  language?: string;
  /** clinic | hotel | office - a decoding hint only, never persisted. */
  domain?: string;
  signal?: AbortSignal;
}

export interface TranscriptionResult {
  text: string;
  provider: string;
  model: string;
  /** Wall-clock time for this call, including a cold model load on first use. */
  durationMs: number;
  /** Length of the submitted audio - lets callers report a real-time factor. */
  audioSeconds: number;
}

export interface SttReadiness {
  ready: boolean;
  detail: string;
}

export interface SpeechToTextProvider {
  readonly id: string;
  readonly label: string;
  readiness(): Promise<SttReadiness>;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}
