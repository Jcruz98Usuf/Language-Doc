/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Local speech-to-text facade (Phase 7A).
 *
 * The browser only ever sees `POST /api/transcribe -> { text }`. Which engine
 * answers, and with which model, is decided here and nowhere else - the same
 * rule the translation engine follows.
 *
 * Engine order:
 *   1. in-process Whisper ONNX (no extra binary, offline after first download)
 *   2. local whisper.cpp sidecar over HTTP (only if one is configured/reachable)
 *
 * Privacy: audio is decoded in memory, transcribed, and dropped. Nothing is
 * written to disk and no audio, transcript or metadata is sent anywhere.
 */

import type { SpeechToTextProvider, TranscriptionRequest, TranscriptionResult } from "./types";
import {
  WhisperOnnxProvider,
  WHISPER_ONNX_PROVIDER_ID,
  WHISPER_LANGUAGES,
  getWhisperOnnxConfig,
  isHfRuntimePresent,
  whisperCacheStatus,
} from "./whisperOnnxProvider";
import { WhisperCppProvider, WHISPER_CPP_PROVIDER_ID } from "./whisperCppProvider";

export { SttError, isSttError } from "./types";
export type { PcmAudio, SpeechToTextProvider, TranscriptionRequest, TranscriptionResult } from "./types";
export {
  WHISPER_MODELS,
  WHISPER_LANGUAGES,
  getWhisperOnnxConfig,
  whisperCacheStatus,
} from "./whisperOnnxProvider";

export type SttSelection = "auto" | "whisper-onnx" | "whisper-cpp";

const onnxProvider = new WhisperOnnxProvider();
const cppProvider = new WhisperCppProvider();

export function getSttSelection(): SttSelection {
  const raw = (process.env.STT_PROVIDER ?? "auto").trim().toLowerCase();
  if (raw === "whisper-onnx" || raw === "whisper-cpp") return raw;
  return "auto";
}

/**
 * Maps an application language onto a Whisper language name. Unsupported
 * languages deliberately pass through unchanged so the provider can refuse them
 * with a clear message instead of guessing.
 */
export function normalizeSpeechLanguage(language?: string): string {
  return (language ?? "").trim().toLowerCase();
}

export function isSpeechLanguageSupported(language?: string): boolean {
  const normalized = normalizeSpeechLanguage(language) || "english";
  return (WHISPER_LANGUAGES as readonly string[]).includes(normalized);
}

/**
 * Resolves the provider for this request. In `auto` the in-process engine wins
 * whenever its runtime is installed; the sidecar is only considered when no
 * in-process runtime exists, or when it is explicitly selected.
 */
export async function resolveSttProvider(): Promise<{
  provider: SpeechToTextProvider;
  selection: SttSelection;
}> {
  const selection = getSttSelection();

  if (selection === "whisper-cpp") return { provider: cppProvider, selection };
  if (selection === "whisper-onnx") return { provider: onnxProvider, selection };

  if (isHfRuntimePresent()) return { provider: onnxProvider, selection };

  const sidecar = await cppProvider.readiness();
  if (sidecar.ready) return { provider: cppProvider, selection };

  return { provider: onnxProvider, selection };
}

export async function transcribeAudio(request: TranscriptionRequest): Promise<TranscriptionResult> {
  const { provider } = await resolveSttProvider();
  return provider.transcribe(request);
}

/**
 * Engine status for /api/health. Reports engine, model ids and whether weights
 * are already local - model identifiers and licences only, never filesystem
 * paths, cache locations or environment values.
 */
export async function describeSttEngine(): Promise<{
  role: string;
  provider: string;
  model: string;
  multilingualModel: string;
  languages: string;
  audioRetention: string;
  available: boolean;
  weightsCached: { english: boolean; multilingual: boolean };
  selection: SttSelection;
  detail: string;
}> {
  const config = getWhisperOnnxConfig();
  const status = whisperCacheStatus();
  const selection = getSttSelection();
  const usingSidecar = selection === "whisper-cpp";
  const onnxReadiness = await onnxProvider.readiness();
  // Only probe the sidecar over HTTP when it is actually the selected engine:
  // /api/health must stay fast when no sidecar is configured.
  const cppReadiness = usingSidecar
    ? await cppProvider.readiness()
    : { ready: false, detail: "whisper.cpp sidecar not selected." };

  const active = usingSidecar ? cppReadiness : onnxReadiness;

  return {
    role: "host/laptop speech-to-text (local, offline after the one-time weight download)",
    provider: usingSidecar ? WHISPER_CPP_PROVIDER_ID : WHISPER_ONNX_PROVIDER_ID,
    model: config.englishModel,
    multilingualModel: config.multilingualModel,
    languages: WHISPER_LANGUAGES.join(", "),
    audioRetention: "in memory only - never written to disk, dropped after transcription",
    available: active.ready,
    weightsCached: { english: status.english, multilingual: status.multilingual },
    selection,
    detail: active.detail,
  };
}

/**
 * Loads the English model in the background at boot when its weights are already
 * local, so the first utterance is not slowed by a cold model load. Never
 * downloads: if the weights are missing, the first /api/transcribe triggers the
 * one-time download and says so in the log.
 */
export async function warmUpStt(): Promise<void> {
  if (!isHfRuntimePresent()) {
    console.log(
      "[stt] local speech-to-text runtime not installed; laptop voice input will report itself unavailable."
    );
    return;
  }

  const status = whisperCacheStatus();
  if (!status.english && !status.multilingual) {
    const { englishModel } = getWhisperOnnxConfig();
    console.log(
      `[stt] local Whisper weights not downloaded yet (${englishModel}); the first voice input downloads them once, then runs offline.`
    );
    return;
  }

  try {
    const readiness = await describeSttEngine();
    if (!readiness.available) {
      console.log(`[stt] ${readiness.detail}`);
      return;
    }
    console.log(`[stt] local speech-to-text ready (${readiness.model}, provider ${readiness.provider})`);
  } catch (error) {
    console.warn(`[stt] warm-up skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}
