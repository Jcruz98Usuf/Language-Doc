/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Translation engine facade.
 *
 * The rest of the application (and therefore the browser) never sees which
 * provider answers: it calls translateText() and receives the same
 * `{ translatedText }` contract as before.
 *
 * Provider selection (server side only):
 *   TRANSLATION_PROVIDER=auto        dedicated local MT if it is reachable, else Ollama  (default)
 *   TRANSLATION_PROVIDER=local-mt    force the dedicated local translation model
 *   TRANSLATION_PROVIDER=ollama      force the local chat model (Qwen)
 *
 * Translation is the highest-priority interactive operation: it is never queued
 * behind profile extraction (see the debounce in ConversationView) and it falls
 * back to the chat model rather than failing the user's conversation.
 */

import { isOllamaError } from "../ollama";
import { HfLocalMtProvider, HF_LOCAL_MT_PROVIDER_ID, isHfLocalMtCached } from "./hfLocalMtProvider";
import {
  buildCapabilityRegistry,
  buildLanguageCapabilities,
  EXPERIMENTAL_LANGUAGES,
  resolveDedicatedLegs,
  type LanguageCapability,
} from "./languagePairs";
export { buildLanguageCapabilities, type LanguageCapability } from "./languagePairs";
import { LocalMtTranslationProvider } from "./localMtProvider";
import { OllamaTranslationProvider } from "./ollamaProvider";
import type { TranslationProvider, TranslationRequest, TranslationResult } from "./types";

export { normalizeDomain, normalizeLanguage } from "./types";
export type { TranslationProvider, TranslationRequest, TranslationResult } from "./types";
export { LOCAL_MT_PROVIDER_ID, getLocalMtConfig } from "./localMtProvider";
export {
  HfLocalMtProvider,
  HF_LOCAL_MT_PROVIDER_ID,
  getHfLocalMtConfig,
  isHfLocalMtCached,
} from "./hfLocalMtProvider";
export { OLLAMA_TRANSLATION_PROVIDER_ID } from "./ollamaProvider";
export {
  buildCapabilityRegistry,
  EXPERIMENTAL_LANGUAGES,
  LOCAL_MT_MODELS,
  resolveDedicatedLegs,
  type CapabilityState,
} from "./languagePairs";

const ollamaProvider = new OllamaTranslationProvider();
const localMtProvider = new LocalMtTranslationProvider();
const hfLocalMtProvider = new HfLocalMtProvider();

export type ProviderSelection = "auto" | "local-mt-hf" | "local-mt" | "ollama";

const READINESS_TTL_MS = 10_000;
const readinessCache = new Map<string, { at: number; ready: boolean; detail: string | null }>();

/** Readiness probes are cached briefly so /api/health stays fast. */
async function cachedReadiness(provider: TranslationProvider) {
  const cached = readinessCache.get(provider.id);
  if (cached && Date.now() - cached.at < READINESS_TTL_MS) {
    return { ready: cached.ready, detail: cached.detail };
  }

  const result = await provider.readiness();
  readinessCache.set(provider.id, { at: Date.now(), ready: result.ready, detail: result.detail });
  return result;
}

export function getConfiguredSelection(): ProviderSelection {
  const raw = (process.env.TRANSLATION_PROVIDER ?? "auto").trim().toLowerCase();
  if (raw === "local-mt-hf" || raw === "local-mt" || raw === "ollama") return raw;
  return "auto";
}

export function getProviderById(id: string): TranslationProvider {
  if (id === localMtProvider.id) return localMtProvider;
  if (id === hfLocalMtProvider.id) return hfLocalMtProvider;
  return ollamaProvider;
}

/**
 * Resolves which provider should serve translation right now. In "auto" mode a
 * dedicated local translation model wins when it is available, because it is
 * purpose built for the job; otherwise the local chat model answers. Priority:
 * in-process opus-mt (cached) -> dedicated-MT HTTP sidecar -> Ollama/Qwen.
 */
export async function resolveTranslationProvider(
  sourceLanguage?: string,
  targetLanguage?: string
): Promise<{
  provider: TranslationProvider;
  selection: ProviderSelection;
  /** True when a chat model is standing in for a dedicated MT direction. */
  unvalidatedFallback: boolean;
  /** True when the answer is produced by a two-stage English-pivoted path. */
  pivoted: boolean;
}> {
  const selection = getConfiguredSelection();
  const pair = sourceLanguage && targetLanguage ? { sourceLanguage, targetLanguage } : null;
  const pivoted = pair ? isPivoted(pair) : false;

  if (selection === "local-mt-hf") {
    return { provider: hfLocalMtProvider, selection, unvalidatedFallback: false, pivoted };
  }
  if (selection === "local-mt") {
    return { provider: localMtProvider, selection, unvalidatedFallback: false, pivoted };
  }
  if (selection === "ollama") {
    return { provider: ollamaProvider, selection, unvalidatedFallback: true, pivoted: false };
  }

  // auto mode: use dedicated local MT for this exact direction when its weights
  // are cached. Otherwise the chat model answers, which is recorded as an
  // unvalidated fallback rather than presented as a validated translation.
  if (pair && hfLocalMtProvider.supportsCached(pair.sourceLanguage, pair.targetLanguage)) {
    return { provider: hfLocalMtProvider, selection, unvalidatedFallback: false, pivoted };
  }

  if (pair) {
    const dedicatedReady =
      (await cachedReadiness(hfLocalMtProvider)).ready || (await cachedReadiness(localMtProvider)).ready;
    if (dedicatedReady) {
      return { provider: ollamaProvider, selection, unvalidatedFallback: true, pivoted: false };
    }
  }

  if ((await cachedReadiness(hfLocalMtProvider)).ready) {
    return { provider: hfLocalMtProvider, selection, unvalidatedFallback: false, pivoted };
  }
  if ((await cachedReadiness(localMtProvider)).ready) {
    return { provider: localMtProvider, selection, unvalidatedFallback: false, pivoted };
  }
  return { provider: ollamaProvider, selection, unvalidatedFallback: true, pivoted: false };
}

function isPivoted(pair: { sourceLanguage: string; targetLanguage: string }): boolean {
  return Boolean(resolveDedicatedLegs(pair.sourceLanguage, pair.targetLanguage)?.pivoted);
}

export interface TranslationEngineStatus {
  selection: ProviderSelection;
  activeProvider: string;
  activeProviderLabel: string;
  ready: boolean;
  detail: string | null;
  dedicatedLocalMt: { id: string; ready: boolean; detail: string | null };
  inProcessLocalMt: { id: string; ready: boolean; detail: string | null };
  chatModelFallback: { id: string; ready: boolean; detail: string | null };
  /** Per-direction capability states used by the demo UI badges. */
  languages: ReturnType<typeof buildCapabilityRegistry>;
  /** Languages shown as experimental because no permissive model exists. */
  experimentalLanguages: Array<{ language: string; reason: string }>;
}

/** Describes the translation engine for GET /api/health (no secrets, no paths). */
export async function describeTranslationEngine(): Promise<TranslationEngineStatus> {
  const selection = getConfiguredSelection();
  const dedicated = await cachedReadiness(localMtProvider);
  const inProcess = await cachedReadiness(hfLocalMtProvider);
  const chatModel = await cachedReadiness(ollamaProvider);
  const active = await resolveTranslationProvider();

  const readinessFor = (provider: TranslationProvider) =>
    provider.id === localMtProvider.id ? dedicated : provider.id === hfLocalMtProvider.id ? inProcess : chatModel;

  const activeReadiness = readinessFor(active.provider);
  return {
    selection,
    activeProvider: active.provider.id,
    activeProviderLabel: active.provider.label,
    ready: activeReadiness.ready,
    detail: activeReadiness.detail,
    dedicatedLocalMt: { id: localMtProvider.id, ready: dedicated.ready, detail: dedicated.detail },
    inProcessLocalMt: { id: hfLocalMtProvider.id, ready: inProcess.ready, detail: inProcess.detail },
    chatModelFallback: { id: ollamaProvider.id, ready: chatModel.ready, detail: chatModel.detail },
    languages: buildCapabilityRegistry({
      cachedDirections: isHfLocalMtCached().cached,
      chatFallbackAvailable: chatModel.ready,
    }),
    experimentalLanguages: Object.entries(EXPERIMENTAL_LANGUAGES).map(([language, reason]) => ({
      language,
      reason,
    })),
  };
}

/**
 * Language-level capability view for the demo UI: which languages are CORE,
 * DEMO READY (both directions cached on dedicated MT) or EXPERIMENTAL.
 */
export async function describeLanguageCapabilities(): Promise<{
  pivot: string;
  languages: LanguageCapability[];
  directions: ReturnType<typeof buildCapabilityRegistry>;
}> {
  const chatModel = await cachedReadiness(ollamaProvider);
  const cachedDirections = isHfLocalMtCached().cached;

  return {
    pivot: "English",
    languages: buildLanguageCapabilities({
      cachedDirections,
      chatFallbackAvailable: chatModel.ready,
    }),
    directions: buildCapabilityRegistry({
      cachedDirections,
      chatFallbackAvailable: chatModel.ready,
    }),
  };
}

/**
 * Translates text with the selected provider. If a dedicated local translation
 * model fails mid-request we fall back to the local chat model instead of
 * leaving the conversation without a translation.
 */
export async function translateText(
  request: TranslationRequest
): Promise<
  TranslationResult & { note?: string; pivoted?: boolean; unvalidatedFallback?: boolean }
> {
  const resolved = await resolveTranslationProvider(request.sourceLanguage, request.targetLanguage);
  const provider = resolved.provider;

  const annotate = (result: TranslationResult) => ({
    ...result,
    pivoted: resolved.pivoted,
    unvalidatedFallback: resolved.unvalidatedFallback,
    ...(resolved.pivoted
      ? { note: "Pivoted through English: two-stage translation, errors can compound." }
      : {}),
  });

  try {
    return annotate(await provider.translate(request));
  } catch (error) {
    if (provider.id === ollamaProvider.id) throw error;

    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[translation] ${provider.id} failed, falling back to ${ollamaProvider.id}: ${reason}`);

    const result = await ollamaProvider.translate(request);
    return {
      ...result,
      note: `Fell back from ${provider.id} (${reason})`,
      pivoted: false,
      unvalidatedFallback: true,
    };
  }
}

export function isTranslationEngineError(error: unknown): boolean {
  return isOllamaError(error);
}