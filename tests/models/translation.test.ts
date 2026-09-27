/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Model tier: translation quality, measured through the endpoint the client uses.
 *
 * The Phase 1.5 benchmark (`benchmarks/translation`) compares candidate engines
 * against each other in isolation. That question is answered. What has to stay
 * answered is the duller one: does the server, as configured today, still translate
 * these sentences correctly? A provider swap, a model tag change or a validator
 * tweak can quietly move the app from a validated dedicated model onto a chat-model
 * guess, and only the output shows it.
 *
 * So this file calls `POST /api/translate` - the real route, with the real provider
 * selection, validation, pivoting and fallback in front of it - and judges the
 * answers with the benchmark's own mechanical rules, taken from
 * `benchmarks/translation/lib.ts`:
 *
 *   - `computeFlags`  - the output is not empty, not a repetition loop, and not the
 *                       source text echoed back;
 *   - `missingPreserveTokens` - every name, number and dosage the fixture says must
 *                       survive translation appears in the output.
 *
 * The fixtures state plainly that their `reference` strings are not a gold standard
 * and are not scored automatically, so this suite does not score them either: it
 * prints the similarity to the reference for a human to read, and asserts only on
 * rules that are mechanically true. Inventing a threshold here would measure the
 * test, not the translator.
 *
 * Requires Ollama; skipped with a reason when it is not there. GitHub runners have
 * no local models, so this is a host-machine gate.
 */

import { describe, expect, it } from "vitest";
import { EN_FR } from "../../benchmarks/translation/fixtures.en-fr";
import { computeFlags, missingPreserveTokens, similarity, stripThink } from "../../benchmarks/translation/lib";
import { api, findPathLeaks, probeEngines, suiteRequiring } from "../helpers/harness";

const engines = await probeEngines();
const suite = suiteRequiring("EN -> FR translation through the API", engines.translation, engines.note);

interface Outcome {
  id: string;
  category: string;
  source: string;
  reference: string;
  actual: string;
  provider: string;
  model: string;
  validated: boolean;
  missingTokens: string[];
  ms: number;
}

const outcomes: Outcome[] = [];

async function translate(text: string) {
  return api("/api/translate", {
    method: "POST",
    body: { text, from: EN_FR.sourceLanguage, to: EN_FR.targetLanguage, domain: "general" },
    timeoutMs: 180_000,
  });
}

suite("English -> French through /api/translate", () => {
  it.each(EN_FR.cases)("$id gets an answer", async (fixture) => {
    const started = Date.now();
    const response = await translate(fixture.source);
    const ms = Date.now() - started;

    expect(response.status, `${fixture.id} -> ${response.status}: ${response.text.slice(0, 200)}`).toBe(200);

    const actual = stripThink(String((response.json as { translatedText?: string }).translatedText ?? ""));
    expect(actual.trim().length, `${fixture.id} came back empty`).toBeGreaterThan(0);
    expect(findPathLeaks(response.text)).toEqual([]);

    outcomes.push({
      id: fixture.id,
      category: fixture.category,
      source: fixture.source,
      reference: fixture.reference,
      actual,
      provider: String(response.headers.get("x-translation-provider")),
      model: String(response.headers.get("x-translation-model")),
      validated: response.headers.get("x-translation-validated") === "true",
      missingTokens: missingPreserveTokens(actual, fixture.preserve),
      ms,
    });
  });

  it("answers every fixture, and says which engine answered", () => {
    // If a case never produced an outcome, the rules below would be measured on a
    // smaller sample than the fixture file promises. Fail here instead.
    expect(outcomes.length).toBe(EN_FR.cases.length);

    const engines_ = new Set(outcomes.map((o) => `${o.provider}/${o.model}`));
    console.log(`[translation] ${EN_FR.direction}: ${[...engines_].join(", ")} over ${outcomes.length} cases`);
    for (const outcome of outcomes) {
      expect(outcome.provider.length).toBeGreaterThan(0);
      expect(outcome.model.length).toBeGreaterThan(0);
    }
  });

  it("never comes back empty, looping, or as the source echoed back", () => {
    // The three failure modes the benchmark treats as disqualifying for any engine,
    // whatever its similarity score looked like.
    const offenders: string[] = [];
    for (const outcome of outcomes) {
      const flags = computeFlags(outcome.actual, outcome.source);
      const raised = Object.entries(flags)
        .filter(([, on]) => on)
        .map(([name]) => name);
      if (raised.length > 0) offenders.push(`${outcome.id} (${raised.join("+")}): ${outcome.actual.slice(0, 120)}`);
    }

    expect(offenders).toEqual([]);
  });

  it("keeps every name, number and dosage the fixtures say must survive", () => {
    // The rules that carry real consequence: a dropped dosage or a renamed patient
    // is a wrong answer even when the sentence reads beautifully.
    const lost = outcomes
      .filter((outcome) => outcome.missingTokens.length > 0)
      .map((outcome) => `${outcome.id}: missing ${outcome.missingTokens.join(", ")} -> ${outcome.actual.slice(0, 120)}`);

    expect(lost).toEqual([]);
  });

  it("prints how close each answer landed to the human reference", () => {
    // Informational by design - the fixtures say their references are not a gold
    // standard. Printed here rather than in a report file nobody regenerates, so a
    // reader of `npm run test:models` sees drift with their own eyes.
    const rows = outcomes.map((outcome) => {
      const score = similarity(outcome.reference.toLowerCase(), outcome.actual.toLowerCase());
      return `${score.toFixed(2)}  ${outcome.id.padEnd(16)} ${outcome.validated ? "validated" : "UNVALIDATED"}  ${String(outcome.ms).padStart(5)}ms  ${outcome.actual}`;
    });
    console.log(`[translation] similarity to reference (not a gate)\n${rows.join("\n")}`);

    const unvalidated = outcomes.filter((outcome) => !outcome.validated).map((outcome) => outcome.id);
    if (unvalidated.length > 0) {
      console.warn(`[translation] chat-model fallback (unvalidated) used for: ${unvalidated.join(", ")}`);
    }

    // The one numeric claim that is honest without a gold standard: a sentence that
    // translates to something of wildly the wrong length is wrong, whatever it says.
    for (const outcome of outcomes) {
      const ratio = outcome.actual.length / Math.max(1, outcome.source.length);
      expect(ratio, `${outcome.id}: output length ratio ${ratio.toFixed(2)} looks like a truncation or a runaway`)
        .toBeGreaterThan(0.25);
      expect(ratio).toBeLessThan(4);
    }
  });
});

