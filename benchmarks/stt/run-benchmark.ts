/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Local speech-to-text benchmark (Phase 7A).
 *
 * Runs the real sandboxed engine (in-process Whisper ONNX, the same code path
 * POST /api/transcribe uses) against locally generated speech, for two model
 * sizes, and writes a human-readable report. Nothing here is simulated and no
 * cloud service is contacted: audio comes from the Windows SAPI voices and the
 * models run on this machine.
 *
 * Run:
 *   npm run bench:stt:audio      (generate the speech clips, once)
 *   npm run bench:stt            (benchmark tiny.en and base.en)
 *   STT_BENCH_MODELS=tiny.en npm run bench:stt
 *
 * Metrics: word error rate, exact matches, cold vs warm latency, real-time
 * factor, empty output, repetition, and error count. Model/RTF numbers do not
 * certify medical accuracy - see the "do not over-claim" note in the report.
 */

import fs from "fs";
import path from "path";
import { decodeAudioPayload } from "../../src/server/services/stt/audio";
import { getWhisperOnnxConfig, transcribeAudio } from "../../src/server/services/stt";
import { STT_FIXTURES } from "./fixtures";

const AUDIO_DIR = path.join("benchmarks", "stt", "audio");
const REPORT_ROOT = path.join("benchmarks", "stt", "results");

/** The two smallest English checkpoints - the size/accuracy tradeoff study. */
const CANDIDATES = (process.env.STT_BENCH_MODELS ?? "tiny.en,base.en")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

interface Row {
  id: string;
  domain: string;
  reference: string;
  hypothesis: string;
  wer: number;
  ms: number;
  audioSeconds: number;
  error: string | null;
  repetition: boolean;
}

interface ModelResult {
  model: string;
  rows: Row[];
  coldMs: number;
  warmMs: number;
  meanWer: number;
  exact: number;
  errors: number;
  empties: number;
  repetitions: number;
  diskMb: number;
}

/* ---------------------------------------------------------------- */
/* Scoring                                                          */
/* ---------------------------------------------------------------- */

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string[], b: string[]): number {
  const previous = new Array<number>(b.length + 1);
  const current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
  }
  return previous[b.length];
}

function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = normalize(reference).split(" ").filter(Boolean);
  const hyp = normalize(hypothesis).split(" ").filter(Boolean);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return levenshtein(ref, hyp) / ref.length;
}

/** Crude but effective: 3+ repeats of the same word means decoding broke down. */
function hasRepetition(text: string): boolean {
  const words = normalize(text).split(" ").filter(Boolean);
  let run = 1;
  for (let i = 1; i < words.length; i += 1) {
    run = words[i] === words[i - 1] ? run + 1 : 1;
    if (run >= 3) return true;
  }
  return false;
}

/* ---------------------------------------------------------------- */
/* Model disk size (helps explain the tradeoff)                     */
/* ---------------------------------------------------------------- */

function directorySizeMb(target: string): number {
  if (!fs.existsSync(target)) return 0;
  let bytes = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else bytes += fs.statSync(full).size;
    }
  };
  walk(target);
  return Math.round((bytes / 1_048_576) * 10) / 10;
}

/* ---------------------------------------------------------------- */
/* Run each candidate                                               */
/* ---------------------------------------------------------------- */

function modelRepo(model: string): string {
  return model.startsWith("Xenova/") ? model : `Xenova/whisper-${model}`;
}

async function runModel(model: string): Promise<ModelResult> {
  process.env.STT_WHISPER_MODEL_EN = model;
  const cacheDir = getWhisperOnnxConfig().cacheDir;
  const rows: Row[] = [];
  let coldMs = 0;

  for (const fixture of STT_FIXTURES) {
    const file = path.join(AUDIO_DIR, `${fixture.id}.wav`);
    const startedAt = Date.now();
    let hypothesis = "";
    let error: string | null = null;
    let audioSeconds = 0;

    try {
      const audio = decodeAudioPayload(fs.readFileSync(file));
      const result = await transcribeAudio({ audio, language: "english", domain: fixture.domain });
      hypothesis = result.text;
      audioSeconds = result.audioSeconds;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }

    const ms = Date.now() - startedAt;
    if (rows.length === 0) coldMs = ms;
    rows.push({
      id: fixture.id,
      domain: fixture.domain,
      reference: fixture.text,
      hypothesis,
      wer: error ? 1 : wordErrorRate(fixture.text, hypothesis),
      ms,
      audioSeconds,
      error,
      repetition: hasRepetition(hypothesis),
    });
  }

  const warm = rows.slice(1);
  return {
    model,
    rows,
    coldMs,
    warmMs: warm.length > 0 ? Math.round(warm.reduce((sum, row) => sum + row.ms, 0) / warm.length) : 0,
    meanWer: rows.reduce((sum, row) => sum + row.wer, 0) / rows.length,
    exact: rows.filter((row) => row.wer === 0).length,
    errors: rows.filter((row) => row.error !== null).length,
    empties: rows.filter((row) => row.error === null && row.hypothesis.trim().length === 0).length,
    repetitions: rows.filter((row) => row.repetition).length,
    diskMb: directorySizeMb(path.join(cacheDir, modelRepo(model))),
  };
}

/* ---------------------------------------------------------------- */
/* Report                                                           */
/* ---------------------------------------------------------------- */

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

function buildReport(results: ModelResult[], generatedAt: Date): string {
  const out: string[] = [];
  out.push("# Local speech-to-text benchmark - Phase 7A");
  out.push("");
  out.push(`Generated: ${generatedAt.toISOString()}`);
  out.push("");
  out.push("## Method");
  out.push("");
  out.push(`- ${STT_FIXTURES.length} English sentences covering clinic, hotel, office and general conversation.`);
  out.push("- Audio generated locally with the installed Windows SAPI voices (no cloud TTS), 16 kHz mono PCM.");
  out.push("- Engine: the real in-process Whisper ONNX path used by POST /api/transcribe, not a simulation.");
  out.push("- Reference transcript = the spoken sentence; scoring is word error rate (substitutions + insertions + deletions).");
  out.push(
    "- Latency covers the whole engine call: `cold` is the first clip of the run (includes the ONNX session load), `warm` the mean of the rest."
  );
  out.push("- Real-time factor (RTF) = latency / audio length; below 1.0 is faster than real time.");
  out.push("");
  out.push(
    "**Limits of this benchmark:** synthesised speech is cleaner than human speech, and no French or Swahili voice is installed on this machine, so the multilingual path is plumbed but not measured here. Passing this benchmark is NOT a claim of medical or clinical accuracy - a human must still review real transcripts."
  );
  out.push("");
  out.push("## Model comparison");
  out.push("");
  out.push("| Model | Disk | Mean WER | Exact | Cold | Warm | RTF | Errors | Empty | Repetition |");
  out.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const result of results) {
    const meanAudio = result.rows.reduce((sum, row) => sum + row.audioSeconds, 0) / result.rows.length;
    const rtf = meanAudio > 0 ? result.warmMs / 1000 / meanAudio : 0;
    out.push(
      `| ${result.model} | ${result.diskMb} MB | ${pct(result.meanWer)} | ${result.exact}/${result.rows.length} | ` +
        `${result.coldMs} ms | ${result.warmMs} ms | ${rtf.toFixed(2)} | ${result.errors} | ${result.empties} | ${result.repetitions} |`
    );
  }
  out.push("");

  for (const result of results) {
    out.push(`## ${result.model} - outputs (human review)`);
    out.push("");
    out.push("| Clip | Domain | Reference | Transcript | WER | ms |");
    out.push("|---|---|---|---|---|---|");
    for (const row of result.rows) {
      const hypothesis = row.error ? `ERROR: ${row.error}` : row.hypothesis || "(empty)";
      out.push(`| ${row.id} | ${row.domain} | ${row.reference} | ${hypothesis} | ${pct(row.wer)} | ${row.ms} |`);
    }
    out.push("");
  }

  return out.join("\n");
}

async function main(): Promise<void> {
  const missing = STT_FIXTURES.filter((fixture) => !fs.existsSync(path.join(AUDIO_DIR, `${fixture.id}.wav`)));
  if (missing.length > 0) {
    console.log(`Missing benchmark audio: ${missing.map((fixture) => fixture.id).join(", ")}`);
    console.log("Generate it first: npm run bench:stt:audio");
    process.exit(1);
  }

  console.log(`Benchmarking ${CANDIDATES.join(", ")} over ${STT_FIXTURES.length} clips on the local engine.`);
  const results: ModelResult[] = [];

  for (const model of CANDIDATES) {
    process.stdout.write(`- ${model} ...`);
    const result = await runModel(model);
    results.push(result);
    process.stdout.write(` mean WER ${pct(result.meanWer)}, warm ${result.warmMs} ms\n`);
  }

  const generatedAt = new Date();
  const stamp = generatedAt.toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(REPORT_ROOT, stamp);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.md"), buildReport(results, generatedAt), "utf8");

  console.log("");
  console.log("Model                  Disk       MeanWER   Exact     Cold       Warm      RTF");
  for (const result of results) {
    const meanAudio = result.rows.reduce((sum, row) => sum + row.audioSeconds, 0) / result.rows.length;
    const rtf = meanAudio > 0 ? result.warmMs / 1000 / meanAudio : 0;
    console.log(
      `${result.model.padEnd(22)} ${String(`${result.diskMb} MB`).padEnd(10)} ${pct(result.meanWer).padEnd(9)} ` +
        `${`${result.exact}/${result.rows.length}`.padEnd(9)} ${String(`${result.coldMs} ms`).padEnd(10)} ` +
        `${String(`${result.warmMs} ms`).padEnd(9)} ${rtf.toFixed(2)}`
    );
  }
  console.log("");
  console.log(`Report: ${path.join(outDir, "report.md")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
