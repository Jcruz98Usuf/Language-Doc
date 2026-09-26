/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Ollama/Qwen translation provider.
 *
 * This is the baseline provider: it asks the local chat model (OLLAMA_MODEL,
 * default qwen3:1.7b) to translate. It requires no extra runtime, but a small
 * general-purpose chat model is not a dedicated translation model, so quality
 * on East African languages is limited (see benchmarks/translation/README.md).
 */

import { askModel, checkOllamaHealth, getOllamaConfig } from "../ollama";
import { cleanTranslationOutput } from "../textSanitizer";
import {
  normalizeDomain,
  normalizeLanguage,
  type ProviderReadiness,
  type TranslationProvider,
  type TranslationRequest,
  type TranslationResult,
} from "./types";

/**
 * Translation system prompts per domain. Kept compact: prompt evaluation is the
 * most expensive part of a local CPU inference, and shorter prompts measurably
 * reduce latency on small models.
 *
 * Exported so the Phase 1.5 translation benchmark exercises the exact prompts
 * used in production (benchmarks/translation/providers.ts).
 */
export const SYSTEM_PROMPTS: Record<string, string> = {
  clinic: [
    "You are a medical interpreter for English and East African languages.",
    "You are not a doctor: never diagnose, never suggest tests, medication or treatment.",
    "Keep names, numbers, dates and clinical terms exactly as written.",
    "Translate faithfully and briefly; never add information.",
    "Reply with the translation only.",
  ].join(" "),
  hotel: [
    "You are a hotel, lodge and safari interpreter for English and East African languages.",
    "Keep guest names, room types, nights, dates and prices exactly as written.",
    "Use warm, polite hospitality wording.",
    "Translate faithfully and briefly; never add information.",
    "Reply with the translation only.",
  ].join(" "),
  office: [
    "You are a business interpreter for English and East African languages.",
    "Keep names, dates, owners, action items and deadlines exactly as written.",
    "Use professional corporate wording.",
    "Translate faithfully and briefly; never add information.",
    "Reply with the translation only.",
  ].join(" "),
};

export const OLLAMA_TRANSLATION_PROVIDER_ID = "ollama";

/**
 * Optional per-task model override.
 *
 * The Translation Engine and the Intelligence Engine (summarize / parse-dialogue)
 * can run different local models on the same Ollama runtime. Unset means both use
 * OLLAMA_MODEL, so default behaviour is unchanged. Benchmarking showed that a
 * larger local model translates Swahili noticeably better but several times
 * slower, so this stays off by default until a model passes the quality gate
 * (benchmarks/translation/README.md).
 */
export function getTranslationModelOverride(): string | undefined {
  const configured = (process.env.OLLAMA_TRANSLATION_MODEL ?? "").trim();
  return configured || undefined;
}

export class OllamaTranslationProvider implements TranslationProvider {
  readonly id = OLLAMA_TRANSLATION_PROVIDER_ID;
  readonly label = "Ollama local chat model (general purpose)";

  supports(sourceLanguage: string, targetLanguage: string): boolean {
    const source = normalizeLanguage(sourceLanguage);
    const target = normalizeLanguage(targetLanguage);
    // A general purpose chat model accepts any pair it can read. Quality is
    // reported by the benchmark rather than claimed here.
    return source.length > 0 && target.length > 0 && source !== target;
  }

  async readiness(): Promise<ProviderReadiness> {
    const health = await checkOllamaHealth();
    if (!health.reachable) {
      return { ready: false, detail: health.error ?? "Local inference engine is unreachable." };
    }

    const override = getTranslationModelOverride();
    if (override && !health.installedModels.includes(override)) {
      return {
        ready: false,
        detail: `OLLAMA_TRANSLATION_MODEL "${override}" is not installed (run "ollama pull ${override}").`,
      };
    }

    if (!health.modelInstalled) {
      return { ready: false, detail: health.hint ?? `Model "${health.model}" is not installed.` };
    }
    return { ready: true, detail: null };
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    const domain = normalizeDomain(request.domain);
    const source = request.sourceLanguage.trim() || "English";
    const target = request.targetLanguage.trim() || "Swahili";
    // Only include a context line when the caller supplied one: small models
    // will happily echo an auto-generated context line back as the answer.
    const context = (request.context ?? "").trim();
    const message = request.text.slice(0, 4000);

    const userPrompt = [
      `Translate from ${source} to ${target}. Reply with the translation only.`,
      ...(context ? [`Context: ${context}`] : []),
      "",
      "---",
      message,
      "---",
    ].join("\n");

    const startedAt = Date.now();
    const { text, model } = await askModel({
      messages: [
        { role: "system", content: SYSTEM_PROMPTS[domain] },
        { role: "user", content: userPrompt },
      ],
      // Unset by default: translation uses OLLAMA_MODEL unless a dedicated
      // translation model was benchmarked and configured.
      model: getTranslationModelOverride(),
      temperature: 0.2,
      maxOutputTokens: 160,
      timeoutMs: requestTimeoutMs(),
      signal: request.signal,
    });

    const cleaned = cleanTranslationOutput(text) || text;

    return {
      text: cleaned,
      provider: this.id,
      model,
      durationMs: Date.now() - startedAt,
    };
  }
}

function requestTimeoutMs(): number {
  return getOllamaConfig().generateTimeoutMs;
}