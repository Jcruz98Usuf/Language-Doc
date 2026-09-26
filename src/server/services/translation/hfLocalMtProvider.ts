/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Dedicated local translation provider running IN-PROCESS via transformers.js
 * (ONNX Runtime for Node). This is the "translation engine" the Phase 1.5 plan
 * calls for: a purpose-built Marian/opus-mt model per language direction, kept
 * fully local — weights are downloaded once (same trust model as `ollama pull`)
 * and cached under TRANSLATION_MT_HF_CACHE, after which inference is offline.
 *
 *   Express ── TranslationProvider (this file) ── opus-mt ONNX (local disk)
 *   Express ── Intelligence Engine ── Ollama / Qwen (summarize, parse-dialogue)
 *
 * The browser never sees any of this; it still calls POST /api/translate.
 *
 * Model selection (env, defaults = Apache-2.0 Helsinki-NLP opus-mt ONNX ports):
 *   TRANSLATION_MT_HF_MODELS="en-sw=Xenova/opus-mt-en-sw,sw-en=Xenova/opus-mt-sw-en"
 */

import fs from "fs";
import path from "path";
import { cleanTranslationOutput } from "../textSanitizer";
import { listDedicatedDirections, resolveDedicatedLegs, type TranslationLeg } from "./languagePairs";
import {
  normalizeLanguage,
  type ProviderReadiness,
  type TranslationProvider,
  type TranslationRequest,
  type TranslationResult,
} from "./types";

export const HF_LOCAL_MT_PROVIDER_ID = "local-mt-hf";

/**
 * Direction -> ONNX model id, derived from the verified language pair registry
 * (src/server/services/translation/languagePairs.ts). Only directions whose
 * upstream licence was verified are listed there, so nothing unverified can be
 * loaded by accident.
 */
export const DEFAULT_HF_MODELS: Record<string, string> = Object.fromEntries(
  listDedicatedDirections().map(({ direction, spec }) => [direction, spec.model])
);

const TRANSLATE_TIMEOUT_MS = 30_000;
const pipelines = new Map<string, Promise<any>>();

export interface HfLocalMtConfig {
  cacheDir: string;
  /** direction (en-sw / sw-en / en-fr / fr-en) -> model repo id */
  models: Record<string, string>;
}

export function getHfLocalMtConfig(): HfLocalMtConfig {
  const cacheDir = (process.env.TRANSLATION_MT_HF_CACHE ?? "benchmarks/translation/.hf-cache").trim();
  const raw = (process.env.TRANSLATION_MT_HF_MODELS ?? "").trim();
  const models: Record<string, string> = { ...DEFAULT_HF_MODELS };

  if (raw) {
    for (const pair of raw.split(",")) {
      const [direction, repo] = pair.split("=").map((part) => part.trim());
      if (direction && repo) models[direction] = repo;
    }
  }
  return { cacheDir, models };
}

/**
 * Cheap readiness probe: is the transformers.js runtime installed, and which
 * dedicated directions already have their weights in the local cache?
 */
export function isHfLocalMtCached(): { packagePresent: boolean; cached: string[]; missing: string[] } {
  const { cacheDir, models } = getHfLocalMtConfig();
  const packagePresent = fs.existsSync(path.resolve("node_modules", "@huggingface", "transformers", "package.json"));
  const cached: string[] = [];
  const missing: string[] = [];

  for (const [direction, repo] of Object.entries(models)) {
    const modelDir = path.resolve(cacheDir, repo, "onnx");
    if (fs.existsSync(modelDir)) cached.push(direction);
    else missing.push(direction);
  }
  return { packagePresent, cached, missing };
}

export class HfLocalMtProvider implements TranslationProvider {
  readonly id = HF_LOCAL_MT_PROVIDER_ID;
  readonly label = "Dedicated local translation model (opus-mt via ONNX Runtime, in-process)";

  /** True when a dedicated direction (direct or English-pivoted) is defined. */
  supports(sourceLanguage: string, targetLanguage: string): boolean {
    return resolveDedicatedLegs(sourceLanguage, targetLanguage) !== null;
  }

  /**
   * True only when every leg of this direction has its weights cached locally.
   * The facade uses this per request, so a cached direction (for example
   * French↔English) is served by dedicated MT while an uncached one falls back.
   */
  supportsCached(sourceLanguage: string, targetLanguage: string): boolean {
    const resolved = resolveDedicatedLegs(sourceLanguage, targetLanguage);
    if (!resolved) return false;

    const status = isHfLocalMtCached();
    if (!status.packagePresent) return false;
    return resolved.legs.every((leg) => status.cached.includes(leg.direction));
  }

  async readiness(): Promise<ProviderReadiness> {
    const status = isHfLocalMtCached();
    if (!status.packagePresent) {
      return { ready: false, detail: "transformers.js runtime (@huggingface/transformers) is not installed." };
    }
    if (status.cached.length === 0) {
      return {
        ready: false,
        detail: `Dedicated MT weights not downloaded yet (${status.missing.join(", ")}); they download once on first use, then run offline.`,
      };
    }
    return {
      ready: true,
      detail:
        `Dedicated opus-mt ONNX cached for ${status.cached.join(", ")}` +
        (status.missing.length ? `; not downloaded: ${status.missing.join(", ")}` : ""),
    };
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    const resolved = resolveDedicatedLegs(request.sourceLanguage, request.targetLanguage);
    if (!resolved) {
      throw new Error(
        `No dedicated local MT model for ${request.sourceLanguage} → ${request.targetLanguage}.`
      );
    }

    if (!isHfLocalMtCached().packagePresent) {
      throw new Error(
        "Dedicated local MT runtime (@huggingface/transformers) is not installed. " +
          "Install it, or use TRANSLATION_PROVIDER=ollama / local-mt. See benchmarks/translation/README.md."
      );
    }

    const startedAt = Date.now();
    let text = request.text.slice(0, 1000);

    // Pivoted paths (for example French → English → Swahili) run each leg in
    // order; the caller is told about the pivot so it can flag compounded risk.
    for (const leg of resolved.legs) {
      text = await this.runLeg(leg, text, request.signal);
    }

    return {
      text: cleanTranslationOutput(text) || text,
      provider: this.id,
      model: resolved.legs.map((leg) => leg.spec.model).join(" -> "),
      durationMs: Date.now() - startedAt,
    };
  }

  /** Runs one direction leg, including its OPUS target token when required. */
  private async runLeg(leg: TranslationLeg, text: string, signal?: AbortSignal): Promise<string> {
    const { cacheDir } = getHfLocalMtConfig();
    if (!pipelines.has(leg.spec.model)) {
      const model = leg.spec.model;
      pipelines.set(
        model,
        (async () => {
          const mod: any = await import("@huggingface/transformers");
          mod.env.cacheDir = cacheDir;
          return mod.pipeline("translation", model, { dtype: "q8" });
        })()
      );
    }

    const translator = await pipelines.get(leg.spec.model)!;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);

    try {
      const results: string[] = [];
      for (const sentence of splitIntoSentences(text)) {
        // Multilingual source models (for example English→many) need the OPUS
        // target-language token in front of the text to pick the right language.
        const input = leg.spec.targetToken ? `${leg.spec.targetToken} ${sentence}` : sentence;
        const output = await translator(input, {
          max_new_tokens: 200,
          ...(signal ? { signal } : {}),
        });
        const translated = String(output?.[0]?.translation_text ?? "").trim();
        if (!translated) {
          throw new Error(`Dedicated local MT model ${leg.spec.model} returned an empty translation.`);
        }
        results.push(translated);
      }

      const combined = results.join(" ").trim();
      if (!combined) {
        throw new Error(`Dedicated local MT model ${leg.spec.model} returned an empty translation.`);
      }
      return combined;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * OPUS-MT models are trained on single sentences and degrade on long inputs
 * (measured: a two-sentence French input produced "tabol 500 mg parac tablet").
 * Each sentence is therefore translated on its own and rejoined, which is the
 * usage the model was designed for.
 */
function splitIntoSentences(text: string, maxSentences = 8): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, maxSentences);

  if (sentences.length === 0) {
    const fallback = text.trim();
    return fallback ? [fallback.slice(0, 400)] : [];
  }
  return sentences.map((sentence) => sentence.slice(0, 400));
}