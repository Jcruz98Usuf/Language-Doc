/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Phase 1.5 translation quality gate — benchmark runner.
 *
 *   npx tsx benchmarks/translation/run-benchmark.ts --provider ollama --models "qwen3:1.7b"
 *   npx tsx benchmarks/translation/run-benchmark.ts --provider hf
 *   npx tsx benchmarks/translation/run-benchmark.ts --provider local-mt
 *
 * Writes machine-readable JSON and a human-readable markdown report under
 * benchmarks/translation/results/. Nothing is mocked: every line comes from a
 * real model call made while the script ran.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { EN_FR } from "./fixtures.en-fr";
import { EN_SW } from "./fixtures.en-sw";
import { FR_EN } from "./fixtures.fr-en";
import { FR_SW } from "./fixtures.fr-sw";
import { SW_EN } from "./fixtures.sw-en";
import { runHfCandidate, runLocalMtCandidate, runOllamaCandidate, type CandidateResult } from "./providers";
import type { FixtureFile } from "./types";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES: Record<string, FixtureFile> = {
  "en-sw": EN_SW,
  "sw-en": SW_EN,
  "en-fr": EN_FR,
  "fr-en": FR_EN,
  "fr-sw": FR_SW,
};

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1] ?? "";
  return {
    provider: (args.provider ?? "ollama").trim(),
    models: (args.models ?? process.env.OLLAMA_MODEL ?? "qwen3:1.7b").split(",").map((m) => m.trim()).filter(Boolean),
    directions: (args.directions ?? "en-sw,sw-en").split(",").map((d) => d.trim()).filter(Boolean),
  };
}

function summarize(result: CandidateResult) {
  const total = result.cases.length;
  const failed = result.cases.filter((c) => c.error !== null).length;
  const empty = result.cases.filter((c) => c.flags.empty).length;
  const repetition = result.cases.filter((c) => c.flags.repetition).length;
  const sourceCopy = result.cases.filter((c) => c.flags.sourceCopy).length;
  const preserveMisses = result.cases.filter((c) => c.missingPreserve.length > 0).length;
  const clean = result.cases.filter(
    (c) => !c.error && !c.flags.empty && !c.flags.repetition && !c.flags.sourceCopy && c.missingPreserve.length === 0
  ).length;
  const latencies = result.cases.map((c) => c.latencyMs);
  const mean = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  return { total, clean, empty, repetition, sourceCopy, preserveMisses, failed, meanLatencyMs: mean };
}

function printSummary(results: CandidateResult[]) {
  for (const result of results) {
    const s = summarize(result);
    console.log(
      `[${result.direction}] ${result.candidate.padEnd(34)} ` +
        `clean ${s.clean}/${s.total}  empty ${s.empty}  repeat ${s.repetition}  ` +
        `copy ${s.sourceCopy}  preserve ${s.preserveMisses}  errors ${s.failed}  ` +
        `mean ${s.meanLatencyMs}ms  warmup ${result.warmupMs}ms`
    );
  }
}

function writeReport(results: CandidateResult[], outDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(outDir, stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "raw.json"), JSON.stringify(results, null, 2));

  const lines: string[] = [
    "# Phase 1.5 translation benchmark",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "> Automated flags (empty / repetition / source-copy / missing preserved tokens) are",
    "> regression signals only. They are NOT a measure of medical translation accuracy;",
    "> human review of the full outputs below is required before any clinical claim.",
    "",
  ];
  for (const result of results) {
    const s = summarize(result);
    lines.push(`## ${result.direction} — ${result.candidate}`, "");
    lines.push(`Runtime: ${result.runtime}  |  License: ${result.license}  |  Warmup: ${result.warmupMs}ms`);
    lines.push(
      `Clean: **${s.clean}/${s.total}**  |  empty ${s.empty}  repetition ${s.repetition}  ` +
        `source-copy ${s.sourceCopy}  preserve-misses ${s.preserveMisses}  errors ${s.failed}  |  ` +
        `mean latency **${s.meanLatencyMs}ms**`,
      ""
    );
    lines.push("| id | category | output | flags | ms |");
    lines.push("|---|---|---|---|---|");
    for (const c of result.cases) {
      const flags = c.error
        ? `ERROR: ${c.error}`
        : [
            c.flags.empty && "empty",
            c.flags.repetition && "repeat",
            c.flags.sourceCopy && "copy",
            c.missingPreserve.length > 0 && `missing: ${c.missingPreserve.join(", ")}`,
          ]
            .filter(Boolean)
            .join(", ") || "ok";
      const output = (c.output || "—").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 180);
      lines.push(`| ${c.id} | ${c.category} | ${output} | ${flags} | ${c.latencyMs} |`);
    }
    lines.push("");
  }
  const reportPath = path.join(dir, "report.md");
  fs.writeFileSync(reportPath, lines.join("\n"));
  return dir;
}

async function main() {
  const { provider, models, directions } = parseArgs(process.argv.slice(2));
  const results: CandidateResult[] = [];

  for (const direction of directions) {
    const fixture = FIXTURES[direction];
    if (!fixture) throw new Error(`Unknown direction "${direction}" (use en-sw and/or sw-en)`);

    if (provider === "ollama") {
      for (const model of models) {
        console.log(`Running ollama candidate "${model}" on ${fixture.direction}...`);
        results.push(await runOllamaCandidate(model, fixture));
      }
    } else if (provider === "hf") {
      console.log(`Running dedicated local MT candidate on ${fixture.direction}...`);
      results.push(await runHfCandidate(fixture));
    } else if (provider === "local-mt") {
      console.log(`Running sidecar candidate on ${fixture.direction}...`);
      results.push(await runLocalMtCandidate(fixture));
    } else {
      throw new Error(`Unknown provider "${provider}" (expected ollama | hf | local-mt)`);
    }
  }

  console.log("");
  printSummary(results);
  const outDir = writeReport(results, path.join(HERE, "results"));
  console.log(`\nReport written to ${outDir}`);
}

main().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exit(1);
});