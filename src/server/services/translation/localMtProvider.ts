/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Dedicated local translation model provider (a.k.a. the "translation engine").
 *
 * A general purpose chat model is not a translation model. This provider talks
 * to a local, offline machine-translation runtime and is the preferred engine
 * whenever one is available; Ollama/Qwen remains the fallback.
 *
 * Expected local runtime contract (nothing here is exposed to the browser):
 *
 *   GET  {TRANSLATION_MT_URL}/health
 *        -> { "status": "ok", "model": "Helsinki-NLP/opus-mt-en-sw", ... }
 *   POST {TRANSLATION_MT_URL}/translate
 *        <- { "text": "...", "source_language": "English", "target_language": "Swahili" }
 *        -> { "translation": "..." }
 *
 * Any local runtime that speaks this contract works: a small Python/FastAPI
 * sidecar running Helsinki-NLP opus-mt / MarianMT models, an ONNX Runtime
 * service, CTranslate2, etc. See benchmarks/translation/README.md for the
 * candidate models, licences and why none is enabled by default.
 */

import { fetchWithTimeout } from "../ollama";
import { cleanTranslationOutput } from "../textSanitizer";
import {
  normalizeLanguage,
  type ProviderReadiness,
  type TranslationProvider,
  type TranslationRequest,
  type TranslationResult,
} from "./types";

export const LOCAL_MT_PROVIDER_ID = "local-mt";
export const DEFAULT_LOCAL_MT_URL = "http://127.0.0.1:5000";

const READINESS_TIMEOUT_MS = 1_500;
const TRANSLATE_TIMEOUT_MS = 30_000;

export interface LocalMtConfig {
  url: string;
  /** Languages the local runtime declares support for (comma separated env). */
  languages: string[];
}

export function getLocalMtConfig(): LocalMtConfig {
  const url = (process.env.TRANSLATION_MT_URL ?? DEFAULT_LOCAL_MT_URL).trim().replace(/\/+$/, "");
  const languages = (process.env.TRANSLATION_MT_LANGUAGES ?? "english,swahili")
    .split(",")
    .map((entry) => normalizeLanguage(entry))
    .filter((entry) => entry.length > 0);

  return { url: url.length > 0 ? url : DEFAULT_LOCAL_MT_URL, languages };
}

export class LocalMtTranslationProvider implements TranslationProvider {
  readonly id = LOCAL_MT_PROVIDER_ID;
  readonly label = "Dedicated local translation model (opus-mt / Marian / ONNX)";

  supports(sourceLanguage: string, targetLanguage: string): boolean {
    const { languages } = getLocalMtConfig();
    const source = normalizeLanguage(sourceLanguage);
    const target = normalizeLanguage(targetLanguage);
    return languages.includes(source) && languages.includes(target);
  }

  async readiness(): Promise<ProviderReadiness> {
    const { url } = getLocalMtConfig();

    try {
      const response = await fetchWithTimeout(
        `${url}/health`,
        { method: "GET", headers: { Accept: "application/json" } },
        READINESS_TIMEOUT_MS
      );

      if (!response.ok) {
        return { ready: false, detail: `Local MT runtime at ${url} answered HTTP ${response.status}.` };
      }

      const payload = (await response.json()) as { status?: string; model?: string };
      if (payload.status && payload.status !== "ok") {
        return { ready: false, detail: `Local MT runtime at ${url} reports status "${payload.status}".` };
      }

      return { ready: true, detail: payload.model ? `model: ${payload.model}` : null };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ready: false,
        detail: `No dedicated local translation runtime at ${url} (${detail}).`,
      };
    }
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    const { url } = getLocalMtConfig();
    const startedAt = Date.now();
    const controller = new AbortController();

    const forwardAbort = () => controller.abort();
    if (request.signal) {
      if (request.signal.aborted) controller.abort();
      else request.signal.addEventListener("abort", forwardAbort, { once: true });
    }

    try {
      const response = await fetchWithTimeout(
        `${url}/translate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: request.text,
            source_language: request.sourceLanguage,
            target_language: request.targetLanguage,
            domain: request.domain ?? "clinic",
            context: request.context ?? "",
          }),
        },
        TRANSLATE_TIMEOUT_MS,
        controller.signal
      );

      if (!response.ok) {
        throw new Error(`Local MT runtime rejected the request (HTTP ${response.status}).`);
      }

      const payload = (await response.json()) as { translation?: unknown; model?: unknown };
      const translation = typeof payload.translation === "string" ? payload.translation.trim() : "";

      if (!translation) {
        throw new Error("Local MT runtime returned an empty translation.");
      }

      return {
        text: cleanTranslationOutput(translation) || translation,
        provider: this.id,
        model: typeof payload.model === "string" ? payload.model : "local-mt",
        durationMs: Date.now() - startedAt,
      };
    } finally {
      request.signal?.removeEventListener("abort", forwardAbort);
    }
  }
}