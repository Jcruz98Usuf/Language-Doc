/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Local voice playback for the HOST laptop (Phase 7B, Stage 1).
 *
 * Fetches playable audio from the server's local engine and plays it with an
 * `HTMLAudioElement`. It deliberately does NOT use the browser's built-in speech
 * engine: that voice is implemented by the platform vendor and, on several
 * platforms, by a remote service, which is exactly the privacy gap this phase
 * closes. (Kept out of the license block above: bundlers preserve license
 * comments verbatim, and the production audit asserts the shipped bundle carries
 * no browser- or cloud-speech identifier at all.)
 *
 *   this module -> POST /api/speech/synthesize -> audio/wav (generated locally)
 *
 * The response is a complete clip held in a blob URL, so replaying the same line
 * is instant and never re-synthesises on this machine. Blob URLs are revoked when
 * the cache evicts them, when a session ends, and when the page goes away.
 */

import { Language } from "../types";

/**
 * Mirrors MAX_TTS_TEXT_CHARS on the server (duplicated rather than imported:
 * server modules must never be pulled into the browser bundle).
 */
export const MAX_LOCAL_SPEECH_CHARS = 500;

/** Languages with a local voice in this build. */
const VOICE_LANGUAGES: Record<string, string> = {
  [Language.ENGLISH]: "english",
  [Language.FRENCH]: "french",
};

/** Failure from the local engine, carrying the server's own code and message. */
export class LocalSpeechError extends Error {
  readonly code: string;
  /** True when the request itself was the problem, so the reason is actionable. */
  readonly inputProblem: boolean;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalSpeechError";
    this.code = code;
    this.inputProblem =
      code === "unsupported-language" ||
      code === "text-too-long" ||
      code === "empty-text" ||
      code === "unsupported-voice-mode" ||
      code === "voice-matching-unavailable";
  }
}

/** Human-readable reason playback cannot run on this device, or null when it can. */
export function playbackFailureReason(): string | null {
  if (typeof window === "undefined") return "Voice playback runs in the browser.";
  if (typeof window.Audio !== "function") {
    return "This browser cannot play audio. Please read the translated line on screen.";
  }
  return null;
}

export function isLocalPlaybackSupported(): boolean {
  return playbackFailureReason() === null;
}

/** Server-side mapping, mirrored so the UI can explain the limit before asking. */
export function localSpeechLanguage(language: Language): string | null {
  return VOICE_LANGUAGES[language] ?? null;
}

export function canPlayLocally(text: string, language: Language): boolean {
  const trimmed = text.trim();
  return (
    isLocalPlaybackSupported() &&
    localSpeechLanguage(language) !== null &&
    trimmed.length > 0 &&
    trimmed.length <= MAX_LOCAL_SPEECH_CHARS
  );
}

/* ------------------------------------------------------------------ */
/* Clip cache (blob URLs, memory only)                                */
/* ------------------------------------------------------------------ */

const MAX_CACHED_CLIPS = 4;
const clips = new Map<string, string>();

function clipKey(language: string, text: string): string {
  return `${language}\u0000${text}`;
}

function storeClip(key: string, blob: Blob): string {
  const existing = clips.get(key);
  if (existing) URL.revokeObjectURL(existing);

  const url = URL.createObjectURL(blob);
  clips.set(key, url);

  while (clips.size > MAX_CACHED_CLIPS) {
    const oldest = clips.keys().next();
    if (oldest.done) break;
    const evicted = clips.get(oldest.value);
    clips.delete(oldest.value);
    if (evicted) URL.revokeObjectURL(evicted);
  }
  return url;
}

/** Releases every cached clip. Called when a private session ends. */
export function releasePlaybackCache(): void {
  for (const url of clips.values()) URL.revokeObjectURL(url);
  clips.clear();
  stopLocalPlayback();
}

/* ------------------------------------------------------------------ */
/* Playback                                                           */
/* ------------------------------------------------------------------ */

interface ActivePlayback {
  audio: HTMLAudioElement;
  stop: () => void;
}

let active: ActivePlayback | null = null;

/** Stops whatever is playing. Safe to call at any time. */
export function stopLocalPlayback(): void {
  const current = active;
  active = null;
  current?.stop();
}

async function fetchSpeech(text: string, language: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch("/api/speech/synthesize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, language, voiceMode: "standard" }),
    signal,
  });

  if (!response.ok) {
    let code = "synthesis-failed";
    let message = "Local voice playback unavailable.";
    try {
      const payload = (await response.json()) as { error?: unknown; code?: unknown };
      if (typeof payload?.code === "string") code = payload.code;
      if (typeof payload?.error === "string" && payload.error.trim()) message = payload.error;
    } catch {
      /* keep the defaults */
    }
    throw new LocalSpeechError(code, message);
  }

  const blob = await response.blob();
  if (blob.size === 0) {
    throw new LocalSpeechError("synthesis-failed", "Local voice playback unavailable.");
  }
  return blob;
}

/**
 * Synthesizes (or replays from the clip cache) and plays one line.
 *
 * Resolves when playback finishes or is superseded; rejects with
 * `LocalSpeechError` when the local engine cannot deliver audio, so the caller
 * can say why instead of failing silently. Starting a new line stops the
 * previous one, which is what makes the speaker button a toggle.
 */
export async function playLocalSpeech(
  text: string,
  language: Language,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  const unsupported = playbackFailureReason();
  if (unsupported) throw new LocalSpeechError("unsupported-browser", unsupported);

  const languageId = localSpeechLanguage(language);
  if (!languageId) {
    throw new LocalSpeechError(
      "unsupported-language",
      "Local voice playback supports English and French only. Please read this line on screen."
    );
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new LocalSpeechError("empty-text", "There is nothing to play for that line.");
  }
  if (trimmed.length > MAX_LOCAL_SPEECH_CHARS) {
    throw new LocalSpeechError(
      "text-too-long",
      `Local voice playback handles up to ${MAX_LOCAL_SPEECH_CHARS} characters. ` +
        "This line is longer - please read it on screen."
    );
  }

  stopLocalPlayback();

  const key = clipKey(languageId, trimmed);
  const cachedUrl = clips.get(key);
  const url = cachedUrl ?? storeClip(key, await fetchSpeech(trimmed, languageId, options.signal));

  const audio = new Audio(url);

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const onEnded = () => finish();
    const onFailed = () =>
      finish(new LocalSpeechError("playback-failed", "This browser could not play the generated audio."));

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onFailed);
      if (active?.audio === audio) active = null;
      if (error) reject(error);
      else resolve();
    };

    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onFailed);

    active = {
      audio,
      stop: () => {
        try {
          audio.pause();
        } catch {
          /* already stopped */
        }
        finish();
      },
    };

    if (options.signal) {
      options.signal.addEventListener(
        "abort",
        () => {
          if (active?.audio === audio) stopLocalPlayback();
          finish();
        },
        { once: true }
      );
    }

    void audio.play().catch((error: unknown) => {
      finish(
        new LocalSpeechError(
          "playback-failed",
          error instanceof Error && error.name === "NotAllowedError"
            ? "This browser blocked playback. Tap the speaker button again to hear the line."
            : "This browser could not play the generated audio."
        )
      );
    });
  });
}
