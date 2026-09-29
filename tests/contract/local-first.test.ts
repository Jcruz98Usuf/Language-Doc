/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contract tier: the local-first promise, enforced mechanically.
 *
 * "Nothing leaves this machine" is the claim every other phase is built on, and a
 * claim of that shape is exactly the one that decays quietly - one import in the
 * wrong place and it is gone, with the UI unchanged. Phase 7B checked this by hand
 * against the built bundle; here it is checked on every commit.
 *
 * Two angles, because the risk has two shapes:
 *   - the shipped client bundle (what a browser could actually call), and
 *   - the server and client sources (so a cloud call is caught before it is ever
 *     built into something shippable).
 *
 * One more promise lives in the same file's remit: the server log is operational
 * only. Ids, counts and states - never conversation text, never profile fields. It is
 * the easiest promise of all to break by accident, because a "helpful" log of a
 * model's own answer looks like debugging and is patient data.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BANNED_ENGINE_REFERENCES,
  DIST_DIR,
  ROOT,
  collectFiles,
  findPathLeaks,
  getHealth,
} from "../helpers/harness";

/** Only the shipped code counts: benchmarks and tests may name engines to rule them out. */
const SOURCES = [
  { label: "server entry", dir: ROOT, pattern: /^server\.ts$/ },
  { label: "client + server source", dir: `${ROOT}/src`, pattern: /\.(ts|tsx)$/ },
];

/**
 * Prose is not code. The three files that explain *why* browser `speechSynthesis`
 * was removed in Phase 7B mention it in order to rule it out, and a check that
 * flags them is a check people switch off. Only comments are removed here - block
 * comments, and line comments whose `//` is not preceded by `:` so a `https://`
 * inside a string stays visible to the scan.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

function scan(dir: string, pattern: RegExp, label: string): string[] {
  const hits: string[] = [];

  for (const file of collectFiles(dir, pattern)) {
    const text = stripComments(readFileSync(file, "utf8"));
    for (const [name, banned] of BANNED_ENGINE_REFERENCES) {
      if (banned.test(text)) hits.push(`${label}: ${name} in ${file.replace(`${ROOT}/`, "")}`);
    }
  }
  return hits;
}

describe("no cloud or browser speech provider", () => {
  it("keeps every cloud and browser engine out of the shipped source", () => {
    const hits: string[] = [];
    for (const source of SOURCES) hits.push(...scan(source.dir, source.pattern, source.label));

    expect(hits).toEqual([]);
  });

  it("still catches a real browser-speech call, not just the word", () => {
    // A negative control for the control: with comments set aside, code that
    // speaks through the browser has to be caught. Both shapes below are what a
    // regression would look like, and neither is a comment. Phase 7C moved phone
    // recognition to the laptop's Whisper engine, which also put the browser's own
    // recogniser on the banned list - the control has to see that one come back too.
    const reintroduced = `
      const voice = () => {
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
        const recognition = new webkitSpeechRecognition();
      };
    `;
    const caught = BANNED_ENGINE_REFERENCES.filter(([, banned]) => banned.test(stripComments(reintroduced)));

    expect(caught.map(([name]) => name)).toContain("browser speechSynthesis API");
    expect(caught.map(([name]) => name)).toContain("SpeechSynthesisUtterance");
    expect(caught.map(([name]) => name)).toContain("browser SpeechRecognition API");
  });

  it("declares no cloud provider in the health payload", async () => {
    const health = await getHealth();
    expect(health.cloudProviders).toBe("none");
    expect(health.engine).toBe("ollama");
    expect(health.intelligence?.provider).toBe("ollama");

    // Engine ids the app reports are local ones, whatever else is on the machine.
    const reported = JSON.stringify({
      translation: health.translation?.activeProvider,
      stt: health.stt?.provider,
      tts: health.speech?.tts?.provider,
    });
    expect(reported).not.toMatch(/google|azure|amazon|openai|deepl|elevenlabs|deepgram|browser/i);
  });

  it("ships a bundle that calls the server for voice and never a remote service", () => {
    const assets = collectFiles(DIST_DIR, /\.js$/);
    if (assets.length === 0) {
      // Skipping is loud, never silent: `npm run build` is a prerequisite of the
      // bundle half of this file, and CI runs it before the suite.
      console.warn("[local-first] dist/ contains no JavaScript - run `npm run build`; bundle scan skipped");
      return;
    }

    const hits: string[] = [];
    for (const asset of assets) {
      const text = readFileSync(asset, "utf8");
      for (const [name, banned] of BANNED_ENGINE_REFERENCES) {
        if (banned.test(text)) hits.push(`${name} found in ${asset.replace(`${DIST_DIR}/`, "")}`);
      }
    }

    expect(hits).toEqual([]);

    // The mirror assertion: the voice path the client is allowed to take.
    const clientCallsLocalVoice = assets.some((asset) =>
      readFileSync(asset, "utf8").includes("/api/speech/synthesize")
    );
    expect(clientCallsLocalVoice).toBe(true);
  });

  it("keeps the build output free of the local engine's absolute paths", () => {
    if (!existsSync(DIST_DIR)) {
      console.warn("[local-first] dist/ missing - run `npm run build`; path scan skipped");
      return;
    }

    const leaked: string[] = [];
    for (const asset of collectFiles(DIST_DIR, /\.(js|css|html)$/)) {
      const leaks = findPathLeaks(readFileSync(asset, "utf8"));
      if (leaks.length) leaked.push(`${asset.replace(`${DIST_DIR}/`, "")}: ${leaks.join(", ")}`);
    }

    expect(leaked).toEqual([]);
  });

  it("keeps conversation content and model answers out of the server log", () => {
    // Two things broke this promise by accident, both looking like debugging: a failed
    // profile extraction logged 200 characters of the model's own answer, which is
    // assembled from the conversation, and the local voice worker's stderr was logged
    // through a variable called `text`, so a content leak looked plausible there too.
    // The check is a bounded window around each log call, because the interesting
    // template literal is often on the next line.
    const leaks: string[] = [];

    for (const file of collectFiles(`${ROOT}/src/server`, /\.ts$/)) {
      const source = readFileSync(file, "utf8");
      for (const call of source.matchAll(/console\.(?:log|warn|error)\([\s\S]{0,240}?\)/g)) {
        const body = call[0];
        const carriesContent =
          /\$\{\s*(?:text|transcript|transcription|profile)\b/.test(body) ||
          /truncateForLog\(\s*text\b/.test(body);
        if (carriesContent) leaks.push(`${file.replace(`${ROOT}/`, "")}: ${body.slice(0, 120)}`);
      }
    }

    expect(leaks).toEqual([]);
  });
});
