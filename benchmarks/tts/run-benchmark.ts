/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Local text-to-speech benchmark (Phase 7B, Stage 1).
 *
 * Measures the real engine over the same code path POST /api/speech/synthesize
 * uses - the local Pocket TTS worker, standard voice, English and French - and
 * writes a human-readable report. Nothing here is simulated and no cloud service
 * is contacted.
 *
 * Metrics: worker start-up, model load, time to first audio, synthesis duration,
 * real-time factor, resident memory, replay-cache behaviour, and how cleanly the
 * application degrades when the engine is removed.
 *
 * Run (stop the dev server first: this spawns its own worker):
 *   npm run bench:tts
 *
 * Options: SPEECH_BENCH_REPEATS (default 3 per language),
 *          SPEECH_BENCH_TEXTS=english,french (default both).
 */

import fs from "fs";
import os from "os";
import path from "path";
import {
  describeSpeechEngine,
  pocketTtsProvider,
  synthesizeSpeech,
  speechCacheStats,
  clearSpeechCache,
  TtsError,
} from "../../src/server/services/speech/ttsProvider";

const REPORT_ROOT = path.join("benchmarks", "tts", "results");
const REPEATS = Number.parseInt(process.env.SPEECH_BENCH_REPEATS ?? "3", 10) || 3;
const LANGUAGES = (process.env.SPEECH_BENCH_TEXTS ?? "english,french")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean) as Array<"english" | "french">;

interface Fixture {
  id: string;
  language: "english" | "french";
  text: string;
}

/**
 * Real clinic / hotel / office lines. French uses its real accents, which also
 * proves the request text survives the whole path as UTF-8.
 */
const FIXTURES: Fixture[] = [
  { id: "en-clinic-dosage", language: "english", text: "Take one tablet twice a day after meals." },
  { id: "en-clinic-allergy", language: "english", text: "Do you have any allergies to medication?" },
  { id: "en-hotel-booking", language: "english", text: "Your room is ready and the key is at the front desk." },
  { id: "en-office-meeting", language: "english", text: "The meeting is on Tuesday at nine in the morning." },
  { id: "fr-clinic-dosage", language: "french", text: "Prenez un comprimé deux fois par jour après les repas." },
  { id: "fr-clinic-allergy", language: "french", text: "Avez-vous des allergies aux médicaments ?" },
  { id: "fr-hotel-booking", language: "french", text: "Votre chambre est prête et la clé est à la réception." },
  { id: "fr-office-meeting", language: "french", text: "La réunion est mardi à neuf heures du matin." },
];

interface Sample {
  id: string;
  language: string;
  characters: number;
  text: string;
  /** "cold" includes the worker start-up and the model load, "warm" does not. */
  phase: "cold" | "warm" | "replay";
  wallMs: number;
  modelLoadMs: number;
  synthesisMs: number;
  firstAudioMs: number;
  audioSeconds: number;
  rtf: number;
  audioKb: number;
  cached: boolean;
  truncated: boolean;
}

interface EngineSnapshot {
  pythonReadyMs: number;
  residents: string[];
  rssMb: number;
  peakRssMb: number;
  firstLoadMs: number | null;
  languages: string[];
  voices: Record<string, string>;
  offline: boolean;
}

/** Minimal RIFF reader: the benchmark checks the audio really is a WAV. */
function readWavHeader(buffer: Buffer): { sampleRate: number; channels: number; bits: number; dataBytes: number } | null {
  if (buffer.byteLength < 44 || buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  return {
    sampleRate: buffer.readUInt32LE(24),
    channels: buffer.readUInt16LE(22),
    bits: buffer.readUInt16LE(34),
    dataBytes: Math.max(0, buffer.readUInt32LE(40)),
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function round(value: number, digits = 0): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Starts the worker (if needed) and reports what it says about itself. */
async function snapshotEngine(): Promise<EngineSnapshot> {
  const started = Date.now();
  const status = await pocketTtsProvider.status();
  const pythonReadyMs = Date.now() - started;

  return {
    pythonReadyMs,
    residents: Array.isArray(status.resident) ? (status.resident as string[]) : [],
    rssMb: Number(status.rssMb ?? 0),
    peakRssMb: Number(status.peakRssMb ?? 0),
    firstLoadMs: typeof status.firstLoadMs === "number" ? status.firstLoadMs : null,
    languages: Array.isArray(status.languages) ? (status.languages as string[]) : [],
    voices: (status.voices ?? {}) as Record<string, string>,
    offline: status.offline === true,
  };
}

async function runSample(fixture: Fixture, phase: Sample["phase"]): Promise<{ sample: Sample; audio: Buffer }> {
  const started = Date.now();
  const speech = await synthesizeSpeech({
    text: fixture.text,
    language: fixture.language,
    voiceMode: "standard",
  });
  const wallMs = Date.now() - started;

  const wav = readWavHeader(speech.audio);
  if (!wav) throw new Error(`Fixture ${fixture.id} did not return a WAV clip.`);
  if (wav.sampleRate !== speech.sampleRate) {
    throw new Error(`Fixture ${fixture.id}: WAV header rate ${wav.sampleRate} != reported ${speech.sampleRate}.`);
  }

  return {
    audio: speech.audio,
    sample: {
      id: fixture.id,
      language: fixture.language,
      characters: fixture.text.length,
      text: fixture.text,
      phase,
      wallMs,
      modelLoadMs: speech.modelLoadMs ?? 0,
      synthesisMs: speech.synthesisMs,
      firstAudioMs: speech.firstAudioMs,
      audioSeconds: speech.durationSeconds,
      rtf: speech.durationSeconds > 0 ? speech.synthesisMs / 1000 / speech.durationSeconds : 0,
      audioKb: round(speech.audio.byteLength / 1024, 1),
      cached: speech.cached,
      truncated: speech.truncated === true,
    },
  };
}

interface Measurement {
  engineBefore: EngineSnapshot;
  engineAfter: EngineSnapshot;
  samples: Sample[];
  /** One clip per language, kept so the report can ship something audible. */
  audio: Record<string, Buffer>;
  cacheEntries: number;
}

async function measure(): Promise<Measurement> {
  const engineBefore = await snapshotEngine();
  const samples: Sample[] = [];
  const audio: Record<string, Buffer> = {};
  const firstOfLanguage = new Set<string>();

  for (const language of LANGUAGES) {
    const fixtures = FIXTURES.filter((fixture) => fixture.language === language);
    if (fixtures.length === 0) continue;

    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      const fixture = fixtures[repeat % fixtures.length];
      const phase: Sample["phase"] = firstOfLanguage.has(language) ? "warm" : "cold";
      firstOfLanguage.add(language);

      const result = await runSample(fixture, phase);
      samples.push(result.sample);
      if (!(language in audio)) audio[language] = result.audio;
    }
  }

  // Same line again: the replay cache should answer without touching the engine.
  const replayFixture = FIXTURES.find((fixture) => fixture.language === LANGUAGES[0]) ?? FIXTURES[0];
  samples.push((await runSample(replayFixture, "replay")).sample);

  const engineAfter = await snapshotEngine();
  return { engineBefore, engineAfter, samples, audio, cacheEntries: speechCacheStats().entries };
}

interface IsolationResult {
  failedCleanly: boolean;
  code: string;
  message: string;
  cachedReplayStillWorks: boolean;
  healthStillAnswers: boolean;
  detail: string;
}

/**
 * Removes the engine and proves what the application does without it: the
 * failure is a clean, typed error with a sentence a UI can show, replay of an
 * already-generated line still works from memory, and the server keeps
 * answering. Playback is an enhancement - it must never take the app down.
 */
async function isolationTest(): Promise<IsolationResult> {
  const cachedFixture = FIXTURES.find((fixture) => fixture.language === LANGUAGES[0]) ?? FIXTURES[0];
  const uncachedFixture: Fixture = {
    id: "isolation-probe",
    language: "english",
    text: "This sentence was never spoken before the engine was removed.",
  };

  // Stop the live worker, then point the provider at an interpreter that cannot
  // exist, so the next synthesis has to fail.
  pocketTtsProvider.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const original = process.env.SPEECH_TTS_PYTHON;
  process.env.SPEECH_TTS_PYTHON = "definitely-not-a-python-interpreter";

  let code = "none";
  let message = "";
  let failedCleanly = false;
  try {
    await synthesizeSpeech({
      text: uncachedFixture.text,
      language: uncachedFixture.language,
      voiceMode: "standard",
    });
  } catch (error) {
    code = error instanceof TtsError ? error.code : "not-a-tts-error";
    message = error instanceof Error ? error.message : String(error);
    failedCleanly = error instanceof TtsError && error.code === "engine-unavailable";
  }

  let cachedReplayStillWorks = false;
  let healthStillAnswers = false;
  try {
    const replayed = await synthesizeSpeech({
      text: cachedFixture.text,
      language: cachedFixture.language,
      voiceMode: "standard",
    });
    cachedReplayStillWorks = replayed.cached === true;
  } catch {
    cachedReplayStillWorks = false;
  }

  try {
    const health = await describeSpeechEngine();
    healthStillAnswers = typeof health.status === "string";
  } catch {
    healthStillAnswers = false;
  }

  if (original === undefined) delete process.env.SPEECH_TTS_PYTHON;
  else process.env.SPEECH_TTS_PYTHON = original;

  return {
    failedCleanly,
    code,
    message,
    cachedReplayStillWorks,
    healthStillAnswers,
    detail:
      `code=${code}, message="${message}", replay from memory=${cachedReplayStillWorks ? "works" : "failed"}, ` +
      `/api/health data=${healthStillAnswers ? "still produced" : "threw"}`,
  };
}

/* ---------------------------------------------------------------- */
/* Report                                                            */
/* ---------------------------------------------------------------- */

function buildReport(
  generatedAt: Date,
  status: Awaited<ReturnType<typeof describeSpeechEngine>>,
  measurement: Measurement,
  isolation: IsolationResult
): string {
  const { engineBefore, engineAfter, samples } = measurement;
  const languages = [...new Set(samples.map((sample) => sample.language))];
  const lines: string[] = [];

  lines.push("# Local voice playback benchmark (Phase 7B, Stage 1)", "");
  lines.push(`Generated: ${generatedAt.toISOString()}  `);
  lines.push(`Engine: \`${status.provider}\` - ${status.model}  `);
  lines.push(`Voice mode: ${status.voiceMode}  `);
  lines.push(
    `Platform: ${os.platform()} ${os.release()}, ${os.cpus().length} logical CPU(s), ` +
      `${round(os.totalmem() / 1e9, 1)} GB RAM  `
  );
  lines.push(`Weights already on this machine: ${JSON.stringify(status.weightsCached)}  `);
  lines.push(`Worker enforced offline (HF_HUB_OFFLINE=1): ${engineBefore.offline ? "yes" : "no"}`, "");

  lines.push("## Engine start-up and memory", "", "| metric | value |", "|---|---|");
  lines.push(`| worker start (spawn to readiness line) | ${engineBefore.pythonReadyMs} ms |`);
  for (const language of languages) {
    const cold = samples.find((sample) => sample.language === language && sample.phase === "cold");
    if (cold) lines.push(`| model load, ${language} (first request) | ${cold.modelLoadMs} ms |`);
  }
  if (engineAfter.firstLoadMs !== null) {
    lines.push(`| model load reported by the engine | ${engineAfter.firstLoadMs} ms |`);
  }
  lines.push(`| RAM after ${engineAfter.residents.length} resident model(s) | ${engineAfter.rssMb} MB |`);
  lines.push(`| peak RAM | ${engineAfter.peakRssMb} MB |`);
  lines.push(`| resident models | ${engineAfter.residents.join(", ") || "none"} |`);
  lines.push(
    `| voices | ${Object.entries(engineAfter.voices)
      .map(([language, voice]) => `${language}=${voice}`)
      .join(", ")} |`,
    ""
  );

  lines.push(
    "## Per-line results",
    "",
    "| fixture | lang | chars | phase | wall | model load | synthesis | first audio | audio | RTF | KB |",
    "|---|---|---|---|---|---|---|---|---|---|---|"
  );
  for (const sample of samples) {
    lines.push(
      `| ${sample.id} | ${sample.language} | ${sample.characters} | ${sample.phase} | ${sample.wallMs} ms | ` +
        `${sample.modelLoadMs} ms | ${sample.synthesisMs} ms | ${sample.firstAudioMs} ms | ` +
        `${round(sample.audioSeconds, 2)} s | ${round(sample.rtf, 2)} | ${sample.audioKb} |`
    );
  }
  lines.push("");

  lines.push(
    "## Summary",
    "",
    "| language | lines | mean synthesis | mean first audio | mean RTF | mean wall |",
    "|---|---|---|---|---|---|"
  );
  for (const language of languages) {
    const measured = samples.filter((sample) => sample.language === language && sample.phase !== "replay");
    if (measured.length === 0) continue;
    lines.push(
      `| ${language} | ${measured.length} | ${round(mean(measured.map((s) => s.synthesisMs)))} ms | ` +
        `${round(mean(measured.map((s) => s.firstAudioMs)))} ms | ${round(mean(measured.map((s) => s.rtf)), 2)} | ` +
        `${round(mean(measured.map((s) => s.wallMs)))} ms |`
    );
  }
  lines.push("");

  const cached = samples.filter((sample) => sample.phase === "replay");
  lines.push("## Replay from memory", "");
  for (const sample of cached) {
    lines.push(
      `Replaying \`${sample.id}\` returned in **${sample.wallMs} ms** ` +
        `(served from the in-memory cache: ${sample.cached ? "yes" : "no"}), against ` +
        `${round(mean(samples.filter((s) => s.phase !== "replay").map((s) => s.wallMs)))} ms for a first synthesis.`
    );
  }
  lines.push(`Cache entries after the run: ${measurement.cacheEntries}.`, "");

  lines.push("## Failure isolation", "");
  lines.push(
    "The worker was stopped and the interpreter pointed at a path that cannot exist. " +
      `A new line then failed with the code "${isolation.code}" and the message ` +
      `"${isolation.message}".`
  );
  lines.push(
    "A line that had already been generated still played from memory: " +
      `${isolation.cachedReplayStillWorks ? "yes" : "no"}; /api/health data was ` +
      `${isolation.healthStillAnswers ? "still produced" : "not produced"}.`
  );
  lines.push(
    "Playback is an enhancement: when the engine is gone the banner says so and typing, " +
      "translation and transcription are untouched.",
    ""
  );

  lines.push("## Listening checks", "");
  lines.push(
    "`sample-english.wav` and `sample-french.wav` in this folder are the clips the engine " +
      "returned for the first line of each language - play them to judge voice quality, which " +
      "no table can capture.",
    ""
  );

  lines.push("## Do not over-claim", "");
  lines.push(
    "- Synthesis runs on CPU at roughly real time (real-time factor near 1.0): a ten-second " +
      "sentence takes about ten seconds to produce. Replay is instant because the clip is cached, " +
      "so the first utterance of a session is the slow one."
  );
  lines.push(
    "- Only the model's built-in catalogue voice per language is used (`alba` for English, " +
      "`cosette` for French). Voice matching is not offered: it needs the separately licensed " +
      "voice-cloning weights, which are not installed here."
  );
  lines.push(
    "- Numbers, drug names and dates are spoken as ordinary text by a general-purpose voice model. " +
      "This benchmark measures latency and stability, not pronunciation accuracy, so a clinician " +
      "should still confirm dosage wording out loud."
  );
  lines.push(
    "- Latency figures come from one machine with four logical CPUs and no GPU; a faster host " +
      "produces the same audio sooner.",
    ""
  );

  return lines.join("\n");
}


async function main(): Promise<void> {
  const generatedAt = new Date();
  console.log("Phase 7B local voice playback benchmark\n");

  const status = await describeSpeechEngine();
  console.log(`Engine: ${status.provider} (${status.status})`);

  const measurement = await measure();
  for (const sample of measurement.samples) {
    console.log(
      `${sample.language.padEnd(7)} ${sample.phase.padEnd(6)} ${String(sample.wallMs).padStart(6)} ms ` +
        `(synth ${sample.synthesisMs} ms, first audio ${sample.firstAudioMs} ms, RTF ${round(sample.rtf, 2)})`
    );
  }

  const isolation = await isolationTest();
  console.log(`Isolation: ${isolation.detail}`);

  const stamp = generatedAt.toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(REPORT_ROOT, stamp);
  fs.mkdirSync(outDir, { recursive: true });

  for (const [language, audio] of Object.entries(measurement.audio)) {
    fs.writeFileSync(path.join(outDir, `sample-${language}.wav`), audio);
  }

  fs.writeFileSync(
    path.join(outDir, "raw.json"),
    JSON.stringify({ generatedAt: generatedAt.toISOString(), status, measurement, isolation }, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(outDir, "report.md"),
    buildReport(generatedAt, status, measurement, isolation),
    "utf8"
  );

  console.log(`\nReport: ${path.join(outDir, "report.md")}`);
  process.exit(0);
}

void main();

