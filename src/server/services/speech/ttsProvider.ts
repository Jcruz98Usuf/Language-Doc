/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Local text-to-speech engine facade (Phase 7B, Stage 1 - standard voice).
 *
 * The exact counterpart of the speech-to-text facade: the browser calls
 * `POST /api/speech/synthesize` and receives playable audio. Which engine,
 * model and voice answer is decided here and nowhere else, and the browser is
 * never told and never talks to the engine.
 *
 *   Browser -> POST /api/speech/synthesize -> TextToSpeechProvider -> audio/wav
 *
 * Why the browser engine was replaced: `window.speechSynthesis` is implemented
 * by the operating system or the browser vendor and, on several platforms, by a
 * remote service, so voice output contradicted the local-first guarantee the
 * rest of the application is built on.
 *
 * Engine order:
 *   1. the in-process Pocket TTS worker (a local Python process owned by
 *      Express, see pocketTtsProvider.ts)
 *   2. nothing else. There is deliberately no cloud fallback and no
 *      operating-system voice as a backstop: when the engine is unavailable the
 *      UI says "Local voice playback unavailable." and typing keeps working.
 *
 * Retention: synthesized audio lives in a small in-memory cache and is returned
 * to the caller. Nothing in this pipeline is written to disk, and the cache is
 * dropped when a private session ends.
 */

import { createHash } from "crypto";
import {
  POCKET_TTS_PROVIDER_ID,
  POCKET_TTS_MODEL_ID,
  POCKET_TTS_VOICES,
  pocketTtsProvider,
  pocketTtsReadiness,
} from "./pocketTtsProvider";
import {
  MAX_TTS_TEXT_CHARS,
  TTS_LANGUAGES,
  TtsError,
  normalizeSpeechText,
  normalizeTtsLanguage,
  normalizeVoiceMode,
  type SpeechRequest,
  type SynthesizedSpeech,
  type TextToSpeechProvider,
} from "./types";

export { POCKET_TTS_PROVIDER_ID, POCKET_TTS_MODEL_ID, POCKET_TTS_VOICES, pocketTtsProvider } from "./pocketTtsProvider";
export {
  MAX_TTS_TEXT_CHARS,
  TTS_LANGUAGES,
  TtsError,
  isTtsError,
  normalizeSpeechText,
  normalizeTtsLanguage,
  normalizeVoiceMode,
  isTtsLanguageSupported,
} from "./types";
export type {
  SpeechReadiness,
  SpeechRequest,
  SynthesizedSpeech,
  TextToSpeechProvider,
  TtsErrorCode,
  TtsLanguage,
  TtsVoiceMode,
} from "./types";

export type TtsSelection = "auto" | "pocket-tts";

/**
 * Only the Pocket TTS worker can be selected, so this value exists to make the
 * health endpoint explicit rather than to offer a choice: a cloud or
 * browser-engine selection would contradict the local-first guarantee.
 */
export function getTtsSelection(): TtsSelection {
  const raw = (process.env.SPEECH_TTS_PROVIDER ?? "auto").trim().toLowerCase();
  return raw === "pocket-tts" ? "pocket-tts" : "auto";
}

export function resolveTtsProvider(): TextToSpeechProvider {
  return pocketTtsProvider;
}

/* ------------------------------------------------------------------ */
/* Replay cache                                                       */
/* ------------------------------------------------------------------ */

/**
 * Replaying the same line is the common case in a live session (the patient
 * asks to hear it again) and synthesis costs seconds of CPU, so identical
 * requests are served from memory. Entries are keyed by a hash of the exact
 * synthesis inputs, which also means no message text is retained as a key.
 *
 * Bounded twice over - at most CACHE_MAX_ENTRIES entries and CACHE_MAX_BYTES of
 * encoded audio - and every entry expires after CACHE_TTL_MS. Nothing is written
 * to disk, and the whole cache is dropped when a session ends.
 */
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 24;
const CACHE_MAX_BYTES = 32 * 1024 * 1024;

interface CacheEntry {
  at: number;
  bytes: number;
  value: SynthesizedSpeech;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<SynthesizedSpeech>>();

function cacheKey(request: SpeechRequest): string {
  return createHash("sha256")
    .update(`${request.language}\u0000${request.voiceMode}\u0000${request.text}`, "utf8")
    .digest("hex");
}

function readCache(key: string): SynthesizedSpeech | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  // Refresh recency: Map preserves insertion order.
  cache.delete(key);
  cache.set(key, entry);
  return { ...entry.value, cached: true };
}

function writeCache(key: string, value: SynthesizedSpeech): void {
  cache.set(key, { at: Date.now(), bytes: value.audio.byteLength, value });

  let totalBytes = 0;
  for (const entry of cache.values()) totalBytes += entry.bytes;

  while (cache.size > CACHE_MAX_ENTRIES || totalBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const evicted = cache.get(oldest.value);
    cache.delete(oldest.value);
    totalBytes -= evicted?.bytes ?? 0;
  }
}

/** Drops every cached clip. Called when a private session ends. */
export function clearSpeechCache(): void {
  cache.clear();
}

/** Drops expired clips so idle memory is released between sessions. */
export function pruneSpeechCache(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.at > CACHE_TTL_MS) cache.delete(key);
  }
}

export function speechCacheStats(): { entries: number; bytes: number } {
  let bytes = 0;
  for (const entry of cache.values()) bytes += entry.bytes;
  return { entries: cache.size, bytes };
}

/* ------------------------------------------------------------------ */
/* Synthesis                                                          */
/* ------------------------------------------------------------------ */

/**
 * Validates the request and synthesizes it locally.
 *
 * Validation lives here, on the server, in one place: the language allow-list,
 * the text length cap and the voice mode. The browser cannot widen any of them.
 * Identical in-flight requests are collapsed so a double click cannot occupy the
 * engine twice.
 */
export async function synthesizeSpeech(request: {
  text: unknown;
  language: unknown;
  voiceMode?: unknown;
  signal?: AbortSignal;
}): Promise<SynthesizedSpeech> {
  const language = normalizeTtsLanguage(request.language);
  if (!language) {
    throw new TtsError(
      "unsupported-language",
      `Local voice playback supports ${TTS_LANGUAGES.join(" and ")} only.`
    );
  }

  const voiceMode = normalizeVoiceMode(request.voiceMode);
  if (!voiceMode) {
    throw new TtsError("unsupported-voice-mode", "That voice setting is not recognised.");
  }
  if (voiceMode === "clone") {
    // Stage 2 territory. Refused explicitly instead of quietly downgrading to the
    // standard voice: a patient must not be told their own voice was used when
    // it was not.
    throw new TtsError(
      "voice-matching-unavailable",
      "Voice matching is not available in this build. Standard voice playback still works."
    );
  }

  const text = normalizeSpeechText(request.text);
  const normalized: SpeechRequest = { text, language, voiceMode, signal: request.signal };

  const key = cacheKey(normalized);
  const cached = readCache(key);
  if (cached) return cached;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const provider = resolveTtsProvider();
  const work = (async () => {
    const result = await provider.synthesize(normalized);
    writeCache(key, result);
    return result;
  })();

  inFlight.set(key, work);
  try {
    return await work;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Engine status for /api/health.
 *
 * Reports the engine, model and voice identifiers and whether the weights are
 * already local - model identifiers only, never filesystem paths, cache
 * locations or environment values.
 */
export async function describeSpeechEngine(): Promise<{
  status: "ready" | "unavailable";
  role: string;
  provider: string;
  model: string;
  supportedLanguages: string[];
  voiceMode: string;
  voices: Record<string, string>;
  voiceMatching: { available: boolean; detail: string };
  audioRetention: string;
  selection: TtsSelection;
  cacheEntries: number;
  weightsCached: Record<string, boolean>;
  detail: string;
}> {
  const readiness = await pocketTtsReadiness();

  return {
    status: readiness.ready ? "ready" : "unavailable",
    role: "host/laptop voice playback (local, offline after the one-time weight download)",
    provider: POCKET_TTS_PROVIDER_ID,
    model: POCKET_TTS_MODEL_ID,
    supportedLanguages: [...TTS_LANGUAGES],
    voiceMode: "standard - the model's one built-in voice per language",
    voices: { ...POCKET_TTS_VOICES },
    voiceMatching: {
      available: false,
      detail:
        "Voice matching needs the separately licensed voice-cloning weights, " +
        "which are not installed on this machine.",
    },
    audioRetention: "in memory only - never written to disk, dropped when the session ends",
    selection: getTtsSelection(),
    cacheEntries: speechCacheStats().entries,
    weightsCached: readiness.modelsCached,
    detail: readiness.detail,
  };
}

/**
 * Reports voice-playback status at boot.
 *
 * Deliberately does NOT start the worker: loading a model costs ~20s and about a
 * gigabyte of memory, and a session that never uses voice should not pay for it.
 * The first replay starts it instead.
 */
export async function warmUpSpeech(): Promise<void> {
  try {
    const status = await describeSpeechEngine();
    console.log(`[tts] ${status.detail}`);
  } catch (error) {
    console.warn(`[tts] status unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}
