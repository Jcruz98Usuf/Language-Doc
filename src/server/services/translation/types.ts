/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Translation provider abstraction.
 *
 * Translation is a separate concern from the general "intelligence engine"
 * (summaries and structured extraction, which stay on Ollama/Qwen). The browser
 * only ever sees POST /api/translate; which provider answers is an internal
 * implementation detail.
 *
 *   Express
 *   ├── Translation Engine   -> TranslationProvider (dedicated MT model preferred)
 *   └── Intelligence Engine  -> Ollama / Qwen (summarize, parse-dialogue)
 */

export type Domain = "clinic" | "hotel" | "office";

export interface TranslationRequest {
  /** Text to translate. */
  text: string;
  /** Language name as used by the UI, for example "English" or "Swahili". */
  sourceLanguage: string;
  targetLanguage: string;
  /** Optional caller supplied context (never invented by the provider). */
  context?: string;
  domain?: Domain;
  /** Aborts the request (used when the caller disconnects or supersedes it). */
  signal?: AbortSignal;
}

export interface TranslationResult {
  /** Translated text. */
  text: string;
  /** Provider id that produced the result, for example "ollama". */
  provider: string;
  /** Concrete model or runtime behind the provider. */
  model: string;
  /** Wall clock time spent producing the translation. */
  durationMs: number;
}

export interface ProviderReadiness {
  ready: boolean;
  /** Human readable reason when `ready` is false. */
  detail: string | null;
}

export interface TranslationProvider {
  /** Stable id used in configuration and the health endpoint. */
  readonly id: string;
  /** Human readable label for reports and logs. */
  readonly label: string;
  /** True when this provider is intended to serve the given language pair. */
  supports(sourceLanguage: string, targetLanguage: string): boolean;
  /** Cheap probe used by the health endpoint and the provider selector. */
  readiness(): Promise<ProviderReadiness>;
  /** Performs the translation. Throws on failure. */
  translate(request: TranslationRequest): Promise<TranslationResult>;
}

/** Normalises a language name for comparisons ("Swahili" / "kiswahili" / "sw"). */
export function normalizeLanguage(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Anything that is not "hotel" or "office" is treated as the default clinic
 * mode. Shared by the translation providers and the intelligence engine.
 */
export function normalizeDomain(value: unknown): Domain {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "hotel" || normalized === "office") return normalized;
  return "clinic";
}

/**
 * Language pairs the East African bridge is expected to cover. Providers may
 * support more; this is what the selector judges readiness against.
 */
export const BRIDGE_LANGUAGES = [
  "english",
  "swahili",
  "kiswahili",
  "luganda",
  "kinyarwanda",
  "somali",
  "luo",
  "kikuyu",
  "kalenjin",
] as const;