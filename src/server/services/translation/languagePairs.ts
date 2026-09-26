/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Language pair registry (Phase 1.6).
 *
 * Single source of truth for which language directions the platform can serve,
 * how each one is served, and — importantly — how much it can be trusted:
 *
 *   supported    a dedicated local MT model is configured and cached; a validated
 *                demo direction (subject to benchmark + human review)
 *   experimental no dedicated model: the general chat model answers, which is NOT
 *                validated for that language. The UI must label it as such.
 *   unavailable  no provider can serve the direction at all
 *
 * Model licensing was verified against the Hugging Face API before integration.
 * Every entry records its upstream model, licence, runtime and local size so the
 * claim is auditable (see benchmarks/translation/README.md).
 *
 * NOTE ON LICENCES:
 *  - Helsinki-NLP OPUS-MT models are Apache-2.0 (verified via the HF API).
 *  - The ONNX ports under `Xenova/*` carry no licence field on their own cards;
 *    they are redistributions of the Apache-2.0 upstream weights, so the upstream
 *    licence is recorded here as the governing one.
 *  - NLLB-200 (the usual way to reach Luganda/Kikuyu/Luo) is CC-BY-NC-4.0
 *    (non-commercial) and is therefore deliberately NOT integrated.
 */

export type CapabilityState = "supported" | "experimental" | "unavailable";

export interface LocalMtModelSpec {
  /** ONNX repo actually loaded by transformers.js. */
  model: string;
  /** Upstream model the ONNX port was converted from. */
  upstream: string;
  /** Licence of the upstream weights (governs the use of the port). */
  licence: string;
  runtime: string;
  /** Approximate download size of the quantised weights, for documentation. */
  approxSize: string;
  /** OPUS target-language token required by multilingual source models. */
  targetToken?: string;
  /** Source language code for models that select languages via tokenizer codes. */
  srcLang?: string;
  /** Target language code for models that select languages via tokenizer codes. */
  tgtLang?: string;
  /**
   * "verified" (default) entries are in production and drive the demo
   * capability states. "candidate" entries can only be used when
   * TRANSLATION_ALLOW_CANDIDATES=1, so an unmeasured model can be benchmarked
   * (and optionally trialled) without ever being advertised as demo-ready.
   */
  status?: "verified" | "candidate";
  /** Date the upstream licence was verified via the HF API. */
  verifiedOn: string;
  notes?: string;
}

/**
 * Verified dedicated local MT directions. Verified 2026-09-21 via
 * https://huggingface.co/api/models/<repo> (licence field + ONNX file listing),
 * and exercised end-to-end through the provider before being listed here.
 *
 * WHY THERE IS NO SWAHILI ENTRY:
 *   No per-pair `opus-mt-en-sw` / `opus-mt-sw-en` model exists (the HF API
 *   returns 401 for both, i.e. they are not published), so Swahili would have to
 *   use the multilingual `*-mul` models. Measured through transformers.js those
 *   ports are broken for the African languages we need: with the model card's
 *   own target token (`>>swh<<`) the output echoes the token and returns
 *   pseudo-English ("...Gomormordin, doktor. A pacient have febert febert 3
 *   days"), and `mul-en` hallucinated a completely unrelated sentence for a
 *   Swahili input. They are therefore deliberately NOT registered, which keeps
 *   Swahili on the clearly-labelled unvalidated chat-model fallback instead of
 *   pretending dedicated MT is serving it.
 *   NLLB-200 does cover Swahili but is CC-BY-NC-4.0 (non-commercial), so it is
 *   excluded on licence grounds.
 */
export const LOCAL_MT_MODELS: Record<string, LocalMtModelSpec> = {
  "en-fr": {
    model: "Xenova/opus-mt-en-fr",
    upstream: "Helsinki-NLP/opus-mt-en-fr",
    licence: "Apache-2.0",
    runtime: "transformers.js + ONNX Runtime (in-process, q8)",
    approxSize: "~80 MB (quantised)",
    verifiedOn: "2026-09-21",
    notes: "Measured working end-to-end (see benchmarks/translation/results).",
  },
  "fr-en": {
    model: "Xenova/opus-mt-fr-en",
    upstream: "Helsinki-NLP/opus-mt-fr-en",
    licence: "Apache-2.0",
    runtime: "transformers.js + ONNX Runtime (in-process, q8)",
    approxSize: "~80 MB (quantised)",
    verifiedOn: "2026-09-21",
    notes: "Measured working end-to-end (see benchmarks/translation/results).",
  },
};

/**
 * Swahili candidates under evaluation (Phase 1.7). These are NOT production
 * entries: they only load when TRANSLATION_ALLOW_CANDIDATES=1, which the
 * benchmark sets, so an unmeasured model can never be advertised as demo-ready.
 *
 * M2M100 418M (Meta) is released under MIT and the ONNX port exposes Swahili
 * ("sw") among its 100 languages. The upstream model card states the licence as
 * MIT but does NOT document the licensing of its training corpus, which is
 * recorded here as an explicit caveat rather than glossed over.
 *
 * Rejected on licence grounds in the same pass:
 *  - lingvanex/* : the card frontmatter says `license: mit` while the card body
 *    states "project is licensed under the cc-by-nc-4.0 License" — contradictory,
 *    so commercial rights are unclear. (Its repos also ship no model weights and
 *    require CTranslate2.)
 *  - Bildad/Swahili-English_Translation : MIT and clean, but PyTorch/safetensors
 *    only — no ONNX — so it needs a Python runtime rather than transformers.js.
 *  - NLLB-200 : CC-BY-NC-4.0.
 */
export const CANDIDATE_MT_MODELS: Record<string, LocalMtModelSpec> = {
  "en-sw": {
    model: "Xenova/m2m100_418M",
    upstream: "facebook/m2m100_418M",
    licence: "MIT (model release; training-corpus licensing not documented in the model card)",
    runtime: "transformers.js + ONNX Runtime (in-process, q8)",
    approxSize: "~615 MB (quantised encoder + decoder)",
    srcLang: "en",
    tgtLang: "sw",
    status: "candidate",
    verifiedOn: "2026-09-22",
    notes: "Swahili is language code 'sw' in M2M100's 100-language set.",
  },
  "sw-en": {
    model: "Xenova/m2m100_418M",
    upstream: "facebook/m2m100_418M",
    licence: "MIT (model release; training-corpus licensing not documented in the model card)",
    runtime: "transformers.js + ONNX Runtime (in-process, q8)",
    approxSize: "~615 MB (quantised encoder + decoder)",
    srcLang: "sw",
    tgtLang: "en",
    status: "candidate",
    verifiedOn: "2026-09-22",
    notes: "Same weights as en-sw, opposite direction; loaded once and reused.",
  },
};

/** Candidates are opt-in so production behaviour never changes by accident. */
export function candidatesEnabled(): boolean {
  return (process.env.TRANSLATION_ALLOW_CANDIDATES ?? "").trim() === "1";
}

/** Every usable spec: verified entries plus candidates when explicitly enabled. */
export function allModelSpecs(): Record<string, LocalMtModelSpec> {
  return candidatesEnabled() ? { ...LOCAL_MT_MODELS, ...CANDIDATE_MT_MODELS } : { ...LOCAL_MT_MODELS };
}

/** Language name -> ISO-639 code used to build direction keys. */
export const LANGUAGE_CODES: Record<string, string> = {
  english: "en",
  swahili: "sw",
  french: "fr",
  luganda: "lg",
  kinyarwanda: "rw",
  somali: "so",
  luo: "luo",
  kikuyu: "ki",
  kalenjin: "kln",
};

/** The pivot language used when a direct direction is not available. */
export const PIVOT_LANGUAGE = "English";

/**
 * Languages the demo may display but which have no verified dedicated model.
 * NLLB-200 covers these but is CC-BY-NC-4.0, so it is not integrated.
 */
export const EXPERIMENTAL_LANGUAGES: Record<string, string> = {
  Luganda: "No permissive dedicated EN↔LG translation model (NLLB-200 is CC-BY-NC-4.0).",
  Kinyarwanda: "No permissive dedicated EN↔RW translation model (NLLB-200 is CC-BY-NC-4.0).",
  Somali: "No permissive dedicated EN↔SO translation model (NLLB-200 is CC-BY-NC-4.0).",
  Luo: "No permissive dedicated EN↔LUO translation model (NLLB-200 is CC-BY-NC-4.0).",
  Kikuyu: "No permissive dedicated EN↔KI translation model (NLLB-200 is CC-BY-NC-4.0).",
  Kalenjin: "No permissive dedicated EN↔KLN translation model (NLLB-200 is CC-BY-NC-4.0).",
};

/** Direction key for two language names, or null when either is unknown. */
export function directionKey(source: string, target: string): string | null {
  const from = LANGUAGE_CODES[source.trim().toLowerCase()];
  const to = LANGUAGE_CODES[target.trim().toLowerCase()];
  if (!from || !to || from === to) return null;
  return `${from}-${to}`;
}

export interface TranslationLeg {
  source: string;
  target: string;
  direction: string;
  spec: LocalMtModelSpec;
}

/**
 * Resolves the dedicated-MT legs for a request. A direct direction wins; when it
 * does not exist but both halves do, an English-pivoted two-leg path is returned
 * (for example French→English→Swahili). Pivoting compounds errors, so callers
 * must flag it and the benchmark measures it separately.
 */
export function resolveDedicatedLegs(
  sourceLanguage: string,
  targetLanguage: string
): { legs: TranslationLeg[]; pivoted: boolean } | null {
  const direct = directionKey(sourceLanguage, targetLanguage);
  if (direct && LOCAL_MT_MODELS[direct]) {
    return {
      legs: [
        { source: sourceLanguage, target: targetLanguage, direction: direct, spec: LOCAL_MT_MODELS[direct] },
      ],
      pivoted: false,
    };
  }

  const toPivot = directionKey(sourceLanguage, PIVOT_LANGUAGE);
  const fromPivot = directionKey(PIVOT_LANGUAGE, targetLanguage);
  if (toPivot && fromPivot && LOCAL_MT_MODELS[toPivot] && LOCAL_MT_MODELS[fromPivot]) {
    return {
      legs: [
        { source: sourceLanguage, target: PIVOT_LANGUAGE, direction: toPivot, spec: LOCAL_MT_MODELS[toPivot] },
        { source: PIVOT_LANGUAGE, target: targetLanguage, direction: fromPivot, spec: LOCAL_MT_MODELS[fromPivot] },
      ],
      pivoted: true,
    };
  }

  return null;
}

/** Every dedicated direction this build can attempt, with its model spec. */
export function listDedicatedDirections(): Array<{ direction: string; spec: LocalMtModelSpec }> {
  return Object.entries(LOCAL_MT_MODELS).map(([direction, spec]) => ({ direction, spec }));
}

/** How a language is presented in the investor demo. */
export type LanguageRole = "pivot" | "demo" | "experimental";

export interface LanguageCapability {
  language: string;
  role: LanguageRole;
  state: CapabilityState;
  provider: string | null;
  detail: string;
  /** Direction keys backing this language (both directions must hold). */
  directions: string[];
}

/**
 * Language-level view for the demo UI, mirroring the requested presentation:
 *
 *   English   CORE            (pivot language, always available)
 *   Swahili   DEMO READY      (only when both dedicated directions are cached)
 *   French    DEMO READY      (only when both dedicated directions are cached)
 *   Luganda…  EXPERIMENTAL    (no permissive dedicated model)
 *
 * A language is never labelled DEMO READY merely because the enum lists it.
 */
export function buildLanguageCapabilities(options: {
  cachedDirections: string[];
  chatFallbackAvailable: boolean;
}): LanguageCapability[] {
  const cached = new Set(options.cachedDirections);
  const fallbackState: CapabilityState = options.chatFallbackAvailable ? "experimental" : "unavailable";
  const fallbackProvider = options.chatFallbackAvailable ? "ollama" : null;
  const result: LanguageCapability[] = [];

  result.push({
    language: PIVOT_LANGUAGE,
    role: "pivot",
    state: "supported",
    provider: "local-mt-hf",
    detail: "English is the pivot language: every published pair is verified with English on one side.",
    directions: [],
  });

  for (const language of ["Swahili", "French"]) {
    const code = LANGUAGE_CODES[language.toLowerCase()];
    const directions = [`en-${code}`, `${code}-en`];
    const missing = directions.filter((direction) => !cached.has(direction));

    result.push({
      language,
      role: "demo",
      state: missing.length === 0 ? "supported" : fallbackState,
      provider: missing.length === 0 ? "local-mt-hf" : fallbackProvider,
      detail:
        missing.length === 0
          ? `Dedicated local MT cached for ${directions.join(" and ")}.`
          : `Dedicated MT not ready (${missing.join(", ")} not cached). Chat-model fallback is NOT a validated translation for this language.`,
      directions,
    });
  }

  for (const [language, reason] of Object.entries(EXPERIMENTAL_LANGUAGES)) {
    result.push({
      language,
      role: "experimental",
      state: fallbackState,
      provider: fallbackProvider,
      detail: reason,
      directions: [],
    });
  }

  return result;
}
export function buildCapabilityRegistry(options: {
  cachedDirections: string[];
  chatFallbackAvailable: boolean;
}): Array<{
  direction: string;
  source: string;
  target: string;
  state: CapabilityState;
  provider: string | null;
  model: string | null;
  licence: string | null;
  runtime: string | null;
  detail: string;
}> {
  const nameByCode = new Map(Object.entries(LANGUAGE_CODES).map(([name, code]) => [code, name]));
  const cached = new Set(options.cachedDirections);

  return listDedicatedDirections().map(({ direction, spec }) => {
    const [from, to] = direction.split("-");
    const source = nameByCode.get(from) ?? from;
    const target = nameByCode.get(to) ?? to;
    const isCached = cached.has(direction);

    if (isCached) {
      return {
        direction,
        source,
        target,
        state: "supported" as CapabilityState,
        provider: "local-mt-hf",
        model: spec.upstream,
        licence: spec.licence,
        runtime: spec.runtime,
        detail: `Dedicated local MT model cached locally (${spec.model}).`,
      };
    }

    return {
      direction,
      source,
      target,
      state: options.chatFallbackAvailable ? ("experimental" as CapabilityState) : ("unavailable" as CapabilityState),
      provider: options.chatFallbackAvailable ? "ollama" : null,
      model: spec.upstream,
      licence: spec.licence,
      runtime: spec.runtime,
      detail: options.chatFallbackAvailable
        ? `Dedicated model not downloaded yet (${spec.model}); chat-model fallback is NOT validated for this direction.`
        : `Dedicated model not downloaded and no fallback available.`,
    };
  });
}