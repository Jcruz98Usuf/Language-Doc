/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Local speech-to-text, running IN-PROCESS via transformers.js (ONNX Runtime for
 * Node) - the same pattern as the local-mt-hf translation provider. This is what
 * replaces the browser's cloud-based SpeechRecognition on the host laptop: the
 * audio never leaves this machine.
 *
 *   Browser mic -> POST /api/transcribe -> this provider -> text
 *
 * Engine : OpenAI Whisper (MIT), exported to ONNX by the Xenova ports (MIT)
 * Runtime: @huggingface/transformers (Apache-2.0) + onnxruntime-node (MIT)
 * Weights: downloaded once on first use (same trust model as `ollama pull`),
 *          then inference is fully offline.
 *
 * Model choice matters: for English the `.en` checkpoints are more accurate per
 * parameter than the multilingual ones, and they are what the host laptop needs.
 * A multilingual checkpoint is only loaded for non-English speech.
 */

import fs from "fs";
import path from "path";
import { SttError } from "./types";
import type {
  SpeechToTextProvider,
  SttReadiness,
  TranscriptionRequest,
  TranscriptionResult,
} from "./types";

export const WHISPER_ONNX_PROVIDER_ID = "stt-whisper-onnx";

export interface WhisperModelSpec {
  /** Hugging Face repo id of the ONNX export. */
  model: string;
  /** Human label used in logs and /api/health. */
  label: string;
  /** English-only checkpoints decode English better than multilingual ones. */
  englishOnly: boolean;
  /** Approximate download size of the quantised ONNX export. */
  approxMb: number;
  license: string;
}

/**
 * Only these four exports are used. Both upstream projects are MIT, which
 * matches the redistributable / no-cloud posture already verified for the
 * opus-mt translation models (see benchmarks/translation/README.md).
 */
export const WHISPER_MODELS: Record<string, WhisperModelSpec> = {
  "tiny.en": {
    model: "Xenova/whisper-tiny.en",
    label: "whisper-tiny.en",
    englishOnly: true,
    approxMb: 41,
    license: "MIT (code: whisper.cpp/OpenAI Whisper; weights: openai/whisper MIT; ONNX export: Xenova MIT)",
  },
  "base.en": {
    model: "Xenova/whisper-base.en",
    label: "whisper-base.en",
    englishOnly: true,
    approxMb: 78,
    license: "MIT (openai/whisper)",
  },
  tiny: {
    model: "Xenova/whisper-tiny",
    label: "whisper-tiny",
    englishOnly: false,
    approxMb: 41,
    license: "MIT (openai/whisper)",
  },
  base: {
    model: "Xenova/whisper-base",
    label: "whisper-base",
    englishOnly: false,
    approxMb: 78,
    license: "MIT (openai/whisper)",
  },
};

/**
 * Whisper's own language coverage, narrowed to the languages this app offers.
 * Luganda, Kinyarwanda, Somali, Luo, Kikuyu and Kalenjin are NOT in Whisper's
 * 99-language set, so local STT is honestly refused for them instead of
 * producing confident nonsense.
 */
export const WHISPER_LANGUAGES = ["english", "french", "swahili"] as const;

export interface WhisperOnnxConfig {
  cacheDir: string;
  englishModel: string;
  multilingualModel: string;
  timeoutMs: number;
}

export function getWhisperOnnxConfig(): WhisperOnnxConfig {
  const cacheDir = (process.env.STT_WHISPER_CACHE ?? "benchmarks/translation/.hf-cache").trim();
  const englishModel = (process.env.STT_WHISPER_MODEL_EN ?? "base.en").trim();
  const multilingualModel = (process.env.STT_WHISPER_MODEL_MULTI ?? "tiny").trim();
  const timeoutMs = Number.parseInt(process.env.STT_WHISPER_TIMEOUT_MS ?? "", 10) || 120_000;

  return {
    cacheDir: cacheDir.length > 0 ? cacheDir : "benchmarks/translation/.hf-cache",
    englishModel: englishModel.length > 0 ? englishModel : "base.en",
    multilingualModel: multilingualModel.length > 0 ? multilingualModel : "tiny",
    timeoutMs,
  };
}

function resolveSpec(name: string): WhisperModelSpec {
  const spec = WHISPER_MODELS[name];
  if (!spec) {
    throw new SttError(
      "unavailable",
      `Unknown local STT model "${name}". Supported: ${Object.keys(WHISPER_MODELS).join(", ")}.`
    );
  }
  return spec;
}

export function isHfRuntimePresent(): boolean {
  return fs.existsSync(path.resolve("node_modules", "@huggingface", "transformers", "package.json"));
}

export function isWhisperModelCached(spec: WhisperModelSpec): boolean {
  const { cacheDir } = getWhisperOnnxConfig();
  return fs.existsSync(path.resolve(cacheDir, spec.model, "onnx"));
}

/** Cheap, offline readiness report: runtime present? weights already local? */
export function whisperCacheStatus(): { packagePresent: boolean; english: boolean; multilingual: boolean } {
  const config = getWhisperOnnxConfig();
  const packagePresent = isHfRuntimePresent();
  let english = false;
  let multilingual = false;
  try {
    english = isWhisperModelCached(resolveSpec(config.englishModel));
    multilingual = isWhisperModelCached(resolveSpec(config.multilingualModel));
  } catch {
    // Invalid model name is reported by readiness()/transcribe() with detail.
  }
  return { packagePresent, english, multilingual };
}

/** One loaded pipeline per model, reused across requests. */
const pipelines = new Map<string, Promise<any>>();

/**
 * Loads (and on first use downloads) a Whisper ONNX export. Failures are not
 * cached, so a transient download error does not poison the model forever.
 */
function loadPipeline(spec: WhisperModelSpec): Promise<any> {
  const existing = pipelines.get(spec.model);
  if (existing) return existing;

  const { cacheDir } = getWhisperOnnxConfig();
  const promise = (async () => {
    const mod: any = await import("@huggingface/transformers");
    mod.env.cacheDir = cacheDir;
    try {
      return await mod.pipeline("automatic-speech-recognition", spec.model, { dtype: "q8" });
    } catch (error) {
      // Some exports reject an all-q8 configuration; fall back to the runtime
      // default rather than failing the request outright.
      console.warn(
        `[stt] q8 load failed for ${spec.model} (${
          error instanceof Error ? error.message : String(error)
        }); retrying with default precision`
      );
      return await mod.pipeline("automatic-speech-recognition", spec.model);
    }
  })();

  pipelines.set(spec.model, promise);
  promise.catch(() => pipelines.delete(spec.model));
  return promise;
}

/**
 * Warms the speech-to-text model so the *first* spoken utterance is not slowed by
 * a cold model load.
 *
 * This is the point of the whole function: `readiness()` only reports whether the
 * weights are on disk, and calling it does not put a model in memory. Without a
 * real load here, the 2-8s ONNX session build lands inside the operator's first
 * `POST /api/transcribe`, which is what made the first recording feel far slower
 * than every one after it.
 *
 * Only models whose weights are already cached are warmed - this never triggers
 * the one-time download in the background, because a download that finishes (or
 * fails) unnoticed is worse than an honest first-use message.
 */
export async function warmUpWhisperPipelines(): Promise<{
  warmed: string[];
  skipped: string[];
  error: string | null;
}> {
  const startedAt = Date.now();
  const config = getWhisperOnnxConfig();

  if (!isHfRuntimePresent()) {
    return { warmed: [], skipped: [], error: "transformers.js runtime is not installed." };
  }

  const warmed: string[] = [];
  const skipped: string[] = [];

  // English first: that is the host laptop's own dictation path and the one a demo
  // always hits. The multilingual checkpoint is warmed only if it is already local.
  for (const name of [config.englishModel, config.multilingualModel]) {
    if (!WHISPER_MODELS[name]) {
      skipped.push(`${name} (unknown model)`);
      continue;
    }
    const spec = resolveSpec(name);
    if (!isWhisperModelCached(spec)) {
      skipped.push(`${spec.label} (not downloaded yet)`);
      continue;
    }
    if (pipelines.has(spec.model)) {
      warmed.push(`${spec.label} (already loaded)`);
      continue;
    }

    try {
      await loadPipeline(spec);
      warmed.push(spec.label);
    } catch (error) {
      // A warm-up failure must never be fatal: the same load will be retried on
      // the first real request, which reports the error properly to the operator.
      skipped.push(`${spec.label} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  console.log(
    `[stt] speech-to-text warm-up finished in ${Date.now() - startedAt}ms (loaded: ${
      warmed.join(", ") || "none"
    }${skipped.length ? `; skipped: ${skipped.join(", ")}` : ""})`
  );

  return { warmed, skipped, error: null };
}


/** Whisper emits markers such as "[BLANK_AUDIO]" for silence - drop them. */
function normalizeTranscript(output: unknown): string {
  const raw = typeof (output as any)?.text === "string" ? ((output as any).text as string) : "";
  const cleaned = raw
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned;
}

/**
 * Whisper loops when it cannot decode the audio it was given - typically the
 * wrong language checkpoint for the speech, or a very noisy room. The output
 * looks like a success ("Buonga mga mga mga mga..."), which is far more
 * dangerous than an error, so it is detected here and reported as a failure.
 *
 * Measured: feeding English audio to the multilingual checkpoint for Swahili
 * produced exactly this pattern over 400 characters.
 */
function hasDegenerateRepetition(text: string): boolean {
  const words = text.toLowerCase().split(" ").filter(Boolean);
  if (words.length < 6) return false;

  let run = 1;
  for (let i = 1; i < words.length; i += 1) {
    run = words[i] === words[i - 1] ? run + 1 : 1;
    if (run >= 4) return true;
  }

  // A long transcript built from a handful of distinct words is also junk.
  const unique = new Set(words);
  return words.length >= 8 && unique.size <= 3;
}

function specForLanguage(language: string, config: WhisperOnnxConfig): WhisperModelSpec {
  return resolveSpec(language === "english" ? config.englishModel : config.multilingualModel);
}

export class WhisperOnnxProvider implements SpeechToTextProvider {
  readonly id = WHISPER_ONNX_PROVIDER_ID;
  readonly label = "Local Whisper (ONNX Runtime, in-process)";

  async readiness(): Promise<SttReadiness> {
    const status = whisperCacheStatus();
    const config = getWhisperOnnxConfig();
    if (!status.packagePresent) {
      return {
        ready: false,
        detail: "transformers.js runtime (@huggingface/transformers) is not installed.",
      };
    }
    if (!status.english && !status.multilingual) {
      return {
        ready: false,
        detail: `Local STT weights not downloaded yet (${status.packagePresent ? "runtime present" : "runtime missing"}); they download once on first use, then run offline.`,
      };
    }
    return {
      ready: true,
      detail:
        `Local Whisper ready (English: ${config.englishModel}` +
        `${status.english ? ", cached" : ", downloads on first use"}; ` +
        `other languages: ${config.multilingualModel}` +
        `${status.multilingual ? ", cached" : ", downloads on first use"})`,
    };
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const config = getWhisperOnnxConfig();
    const language = (request.language ?? "english").trim().toLowerCase();

    if (!(WHISPER_LANGUAGES as readonly string[]).includes(language)) {
      throw new SttError(
        "unsupported-language",
        `Local speech-to-text does not support ${request.language || "that language"} yet. Please type the message instead.`
      );
    }
    if (!isHfRuntimePresent()) {
      throw new SttError(
        "unavailable",
        "Local speech-to-text runtime is not installed (@huggingface/transformers)."
      );
    }

    const spec = specForLanguage(language, config);
    const startedAt = Date.now();

    // Loading (including the one-time download) is deliberately not timed out;
    // only the inference itself is bounded.
    const transcriber = await loadPipeline(spec);

    const options: Record<string, unknown> = {
      chunk_length_s: 30,
      stride_length_s: 5,
      // Multilingual checkpoints need the language forced, otherwise a short
      // utterance can be auto-detected as the wrong language.
      ...(spec.englishOnly ? {} : { language, task: "transcribe" }),
    };

    const text = normalizeTranscript(
      await this.inferWithinBudget(transcriber, request.audio.samples, options, request.signal)
    );

    if (!text) {
      throw new SttError(
        "empty-transcript",
        "No speech was recognised in that recording. Try again a little closer to the microphone."
      );
    }

    if (hasDegenerateRepetition(text)) {
      // Never hand back looped nonsense as if it were a transcript.
      throw new SttError(
        "empty-transcript",
        "The local engine could not make sense of that recording, so no transcript was used. " +
          "Try again, or type the message - text is translated the same way."
      );
    }

    return {
      text,
      provider: this.id,
      model: spec.model,
      durationMs: Date.now() - startedAt,
      audioSeconds: request.audio.samples.length / request.audio.sampleRate,
    };
  }

  /** Bounds a single inference and honours client disconnect. */
  private async inferWithinBudget(
    transcriber: (audio: Float32Array, options: Record<string, unknown>) => Promise<unknown>,
    samples: Float32Array,
    options: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const { timeoutMs } = getWhisperOnnxConfig();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const guard = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new SttError("timeout", `Local transcription timed out after ${timeoutMs} ms.`)),
        timeoutMs
      );
    });

    try {
      return await Promise.race([transcriber(samples, options), guard]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal?.aborted) {
        throw new SttError("cancelled", "Transcription cancelled by the caller.");
      }
    }
  }
}

