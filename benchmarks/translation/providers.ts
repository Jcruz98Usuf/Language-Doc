/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Candidate runners for the Phase 1.5 translation benchmark.
 *
 * - runOllamaCandidate: local chat models via POST /api/chat (same prompt and
 *   generation options as the production OllamaTranslationProvider, so the
 *   benchmark reflects production behaviour).
 * - runLocalMtCandidate: the optional dedicated-MT HTTP sidecar
 *   (TRANSLATION_MT_URL contract, see src/server/services/translation/localMtProvider.ts).
 * - runHfCandidate: dedicated opus-mt models in-process via transformers.js
 *   (ONNX Runtime, fully local after the first download, like `ollama pull`).
 */

import fs from "fs";
import path from "path";
import {
  HfLocalMtProvider,
  HF_LOCAL_MT_PROVIDER_ID,
  isHfLocalMtCached,
  resolveDedicatedLegs,
} from "../../src/server/services/translation";
import { SYSTEM_PROMPTS } from "../../src/server/services/translation/ollamaProvider";
import { missingPreserveTokens } from "./lib";
import { computeFlags, stripThink, type CaseFlags } from "./lib";
import type { FixtureFile, TranslationCase } from "./types";

const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, "");
const CASE_TIMEOUT_MS = 180_000;

async function fetchJson(url: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(CASE_TIMEOUT_MS) });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${body.slice(0, 300)}`);
  }
  return JSON.parse(body);
}

/** Raw /api/chat call with the same options as the production provider. */
async function ollamaChat(model: string, messages: Array<{ role: string; content: string }>): Promise<string> {
  const base = {
    model,
    messages,
    stream: false,
    options: { temperature: 0.2, num_predict: 160, repeat_penalty: 1.15 },
  };

  const send = async (payload: object) =>
    fetchJson(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

  try {
    const data = await send({ ...base, think: false });
    return stripThink(String(data?.message?.content ?? ""));
  } catch (error) {
    // Non-thinking models reject the "think" flag on some Ollama versions.
    if (!String(error).includes("HTTP 4")) throw error;
    const data = await send(base);
    return stripThink(String(data?.message?.content ?? ""));
  }
}

export interface CandidateResult {
  candidate: string;
  model: string;
  runtime: string;
  license: string;
  direction: string;
  warmupMs: number;
  cases: Array<{
    id: string;
    category: string;
    source: string;
    reference: string;
    output: string;
    latencyMs: number;
    flags: CaseFlags;
    missingPreserve: string[];
    error: string | null;
  }>;
}

function buildMessages(sourceLanguage: string, targetLanguage: string, domain: string, source: string) {
  return [
    { role: "system", content: SYSTEM_PROMPTS[domain] ?? SYSTEM_PROMPTS.clinic },
    {
      role: "user",
      content: `Translate from ${sourceLanguage} to ${targetLanguage}. Reply with the translation only.\n\n---\n${source}\n---`,
    },
  ];
}

function finishCase(
  item: TranslationCase,
  output: string,
  latencyMs: number,
  error: string | null,
  direction: string
): CandidateResult["cases"][number] {
  void direction;
  return {
    id: item.id,
    category: item.category,
    source: item.source,
    reference: item.reference,
    output: error ? "" : output,
    latencyMs,
    flags: error ? { empty: true, repetition: false, sourceCopy: false } : computeFlags(output, item.source),
    missingPreserve: error ? (item.preserve ?? []).map((g) => g.join("|")) : missingPreserveTokens(output, item.preserve),
    error,
  };
}

export async function runOllamaCandidate(model: string, fixture: FixtureFile): Promise<CandidateResult> {
  const domain = (process.env.BENCH_DOMAIN ?? "clinic").trim().toLowerCase() || "clinic";
  const warmupStart = Date.now();
  await ollamaChat(model, buildMessages(fixture.sourceLanguage, fixture.targetLanguage, domain, "Good morning."));
  const warmupMs = Date.now() - warmupStart;

  const cases: CandidateResult["cases"] = [];
  for (const item of fixture.cases) {
    const startedAt = Date.now();
    try {
      const output = await ollamaChat(
        model,
        buildMessages(fixture.sourceLanguage, fixture.targetLanguage, domain, item.source)
      );
      cases.push(finishCase(item, output, Date.now() - startedAt, null, fixture.direction));
    } catch (error) {
      cases.push(finishCase(item, "", Date.now() - startedAt, String(error).slice(0, 300), fixture.direction));
    }
  }
  return {
    candidate: `ollama:${model}`,
    model,
    runtime: "Ollama (chat)",
    license: model.startsWith("qwen") ? "Apache-2.0" : model.startsWith("gemma") ? "Gemma Terms of Use" : "see model card",
    direction: fixture.direction,
    warmupMs,
    cases,
  };
}

/** Dedicated-MT HTTP sidecar (same contract as LocalMtTranslationProvider). */
export async function runLocalMtCandidate(fixture: FixtureFile): Promise<CandidateResult> {
  const url = (process.env.TRANSLATION_MT_URL ?? "http://127.0.0.1:5000").replace(/\/+$/, "");
  const translate = async (text: string): Promise<string> => {
    const data = await fetchJson(`${url}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        source_language: fixture.sourceLanguage,
        target_language: fixture.targetLanguage,
        domain: "clinic",
      }),
    });
    return String(data?.translation ?? "").trim();
  };

  const warmupStart = Date.now();
  await translate("Good morning.");
  const warmupMs = Date.now() - warmupStart;

  const cases: CandidateResult["cases"] = [];
  for (const item of fixture.cases) {
    const startedAt = Date.now();
    try {
      const output = await translate(item.source);
      cases.push(finishCase(item, output, Date.now() - startedAt, null, fixture.direction));
    } catch (error) {
      cases.push(finishCase(item, "", Date.now() - startedAt, String(error).slice(0, 300), fixture.direction));
    }
  }
  return {
    candidate: "local-mt sidecar",
    model: `runtime at ${url}`,
    runtime: "HTTP sidecar",
    license: "depends on the deployed runtime",
    direction: fixture.direction,
    warmupMs,
    cases,
  };
}

/**
 * In-process dedicated MT, measured through the REAL production provider
 * (HfLocalMtProvider): same model map, same OPUS target tokens, same
 * English-pivot behaviour. This keeps one implementation instead of a parallel
 * benchmark-only copy.
 */
export async function runHfCandidate(fixture: FixtureFile): Promise<CandidateResult> {
  const status = isHfLocalMtCached();
  if (!status.packagePresent) {
    throw new Error(
      "Dedicated local MT runtime @huggingface/transformers is not installed, so this candidate " +
        "cannot be benchmarked. Install it (see benchmarks/translation/README.md), or benchmark " +
        "--provider ollama / --provider local-mt instead."
    );
  }

  const provider = new HfLocalMtProvider();
  if (!provider.supports(fixture.sourceLanguage, fixture.targetLanguage)) {
    throw new Error(
      `No dedicated local MT model for ${fixture.sourceLanguage} -> ${fixture.targetLanguage}.`
    );
  }

  const resolved = resolveDedicatedLegs(fixture.sourceLanguage, fixture.targetLanguage);
  const modelLabel = resolved ? resolved.legs.map((leg) => leg.spec.model).join(" -> ") : "unknown";
  const cachedForFixture = resolved
    ? resolved.legs.every((leg) => status.cached.includes(leg.direction))
    : false;

  const translate = async (text: string): Promise<string> => {
    const result = await provider.translate({
      text,
      sourceLanguage: fixture.sourceLanguage,
      targetLanguage: fixture.targetLanguage,
      domain: "clinic",
    });
    return result.text;
  };

  const warmupStart = Date.now();
  await translate("Good morning.");
  const warmupMs = Date.now() - warmupStart;

  const cases: CandidateResult["cases"] = [];
  for (const item of fixture.cases) {
    const startedAt = Date.now();
    try {
      const output = await translate(item.source);
      cases.push(finishCase(item, output, Date.now() - startedAt, null, fixture.direction));
    } catch (error) {
      cases.push(finishCase(item, "", Date.now() - startedAt, String(error).slice(0, 300), fixture.direction));
    }
  }

  return {
    candidate: `${HF_LOCAL_MT_PROVIDER_ID}${resolved?.pivoted ? " (pivoted via English)" : ""}`,
    model: modelLabel,
    runtime:
      `transformers.js + ONNX Runtime, q8 (${cachedForFixture ? "cached locally" : "downloaded during this run"})`,
    license: resolved
      ? [...new Set(resolved.legs.map((leg) => `${leg.spec.upstream} = ${leg.spec.licence}`))].join("; ")
      : "Apache-2.0",
    direction: fixture.direction,
    warmupMs,
    cases,
  };
}