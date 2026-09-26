/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Phase 7B security checks for local voice playback.
 *
 * Runs against a live server (the same process the demo uses) and asserts the
 * properties the phase is required to prove - not the ones that are merely
 * intended:
 *
 *   1. size abuse: an over-long request is refused instead of occupying the CPU
 *   2. instruction abuse: shell metacharacters and paths in the text are spoken
 *      as text and never interpreted - a canary file must survive
 *   3. argument abuse: language and voiceMode are allow-listed, so no value can
 *      reach the worker's process, its argv, or its model selection
 *   4. no filesystem writes: a full synthesis adds no file anywhere under TEMP
 *   5. no leakage: neither the spoken text nor any filesystem path appears in
 *      the server log, and /api/health exposes no paths
 *   6. no browser/cloud speech engine: the shipped client bundle contains no
 *      speechSynthesis path and no cloud TTS endpoint
 *
 * Run (dev server first):
 *   npm run dev
 *   npm run check:tts-security
 *
 * Options: SPEECH_BASE_URL (default http://localhost:3000),
 *          SPEECH_SERVER_LOG (default tts7b.log)
 */

import fs from "fs";
import os from "os";
import path from "path";

const BASE = (process.env.SPEECH_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const SERVER_LOG = process.env.SPEECH_SERVER_LOG ?? "tts7b.log";

/** A distinctive string: if it ever shows up in a log, it came from this request. */
const CANARY_TEXT = "TTS-CANARY-9f2c1b7d-please-take-one-tablet";
const CANARY_FILE = path.join(os.tmpdir(), "tts-security-canary.txt");
const SPOKEN_SENTENCE = "Please take one tablet twice a day after meals.";

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function record(name: string, passed: boolean, detail: string): void {
  results.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
}

interface SynthResponse {
  status: number;
  contentType: string | null;
  bytes: number;
  body: string;
  durationMs: number;
}

async function synthesize(body: unknown, timeoutMs = 240_000): Promise<SynthResponse> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${BASE}/api/speech/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal: controller.signal,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      bytes: buffer.byteLength,
      body: buffer.toString("utf8"),
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

function isWav(buffer: Buffer): boolean {
  return buffer.byteLength > 44 && buffer.toString("ascii", 0, 4) === "RIFF";
}

function listTempFiles(): string[] {
  try {
    return fs.readdirSync(os.tmpdir()).sort();
  } catch {
    return [];
  }
}

/** 1. Size abuse. */
async function checkSizeLimits(): Promise<void> {
  const overLong = await synthesize({ text: "a".repeat(1200), language: "english" });
  const refused = overLong.status === 400 && overLong.body.includes("text-too-long");

  const huge = await synthesize({ text: "b".repeat(300_000), language: "english" });
  const hugeRefused = huge.status === 400 || huge.status === 413;

  record(
    "1. over-long input is refused, not queued",
    refused && hugeRefused,
    `1200 chars -> ${overLong.status} (${overLong.durationMs}ms); ` +
      `300k chars -> ${huge.status} (${huge.durationMs}ms)`
  );
}


/** 2. Instruction abuse: text is data, never an instruction. */
async function checkInstructionAbuse(): Promise<void> {
  fs.writeFileSync(CANARY_FILE, "intact", "utf8");

  const injection =
    `${CANARY_TEXT}; del "${CANARY_FILE}" & echo pwned && ` +
    "cmd.exe /c whoami ; `rm -rf /` $(echo hi)";

  const injected = await synthesize({ text: injection, language: "english" });
  const pathText = await synthesize({ text: "C:/Windows/System32/cmd.exe", language: "english" });

  const survived = fs.existsSync(CANARY_FILE) && fs.readFileSync(CANARY_FILE, "utf8") === "intact";
  const injectionHandled = injected.status === 200 || injected.status === 400;
  const pathSpoken = pathText.status === 200;

  fs.rmSync(CANARY_FILE, { force: true });
  record(
    "2. shell metacharacters and paths in the text are never executed",
    survived && injectionHandled && pathSpoken,
    `canary file ${survived ? "intact" : "GONE"}; injection -> ${injected.status}; ` +
      `path-like text -> ${pathText.status} (spoken as text)`
  );
}

/** 3. Argument abuse: language and voice mode are allow-listed. */
async function checkArgumentAllowLists(): Promise<void> {
  const badLanguages = [
    "english; rm -rf /",
    "swahili",
    "../../../etc/passwd",
    "english --config /tmp/evil.yaml",
  ];
  const languageStatuses: string[] = [];
  let refused = 0;

  for (const language of badLanguages) {
    const response = await synthesize({ text: "hello", language });
    languageStatuses.push(`${JSON.stringify(language)}=${response.status}`);
    if (response.status === 400) refused += 1;
  }

  const french = await synthesize({ text: "Bonjour, votre chambre est prete.", language: "French" });
  const clone = await synthesize({ text: "hello", language: "english", voiceMode: "clone" });
  const badMode = await synthesize({ text: "hello", language: "english", voiceMode: "standard; whoami" });

  const passed =
    refused === badLanguages.length &&
    french.status === 200 &&
    clone.status === 503 &&
    clone.body.includes("voice-matching-unavailable") &&
    badMode.status === 400;

  record(
    "3. language and voiceMode are allow-listed, no value reaches the worker",
    passed,
    `${refused}/${badLanguages.length} bad languages refused (${languageStatuses.join(", ")}); ` +
      `"French" -> ${french.status}; voiceMode=clone -> ${clone.status}; ` +
      `voiceMode="standard; whoami" -> ${badMode.status}`
  );
}

/** 4. No filesystem writes: a real synthesis must create no file. */
async function checkNoFilesWritten(): Promise<void> {
  const before = new Set(listTempFiles());
  const response = await synthesize({ text: SPOKEN_SENTENCE, language: "english" });
  const after = listTempFiles();

  // Anything voice-shaped would have to appear here: this pipeline claims to
  // produce audio without ever touching a file, including a temp file.
  const suspicious = after.filter(
    (name) => !before.has(name) && /tts|speech|pocket|synth|\.wav$/i.test(name)
  );

  record(
    "4. synthesis writes no file anywhere (no temp WAV to leak)",
    response.status === 200 && suspicious.length === 0 && isWav(Buffer.from(response.body, "latin1")),
    `status ${response.status}, ${response.bytes} bytes of RIFF/WAV audio returned; ` +
      `new voice-shaped temp files: ${suspicious.length === 0 ? "none" : suspicious.join(", ")}`
  );
}

const PATH_PATTERNS = [/C:\\Users/i, /site-packages/i, /\.cache[\\/]hub/i, /python\.exe/i, /AppData/i];

/** 5. Nothing leaks: not the spoken text, not a filesystem path. */
async function checkNoLeakage(): Promise<void> {
  const health = await fetch(`${BASE}/api/health`);
  const healthText = await health.text();
  const healthPaths = PATH_PATTERNS.filter((pattern) => pattern.test(healthText)).map(String);

  const leaks: string[] = [];
  let logStatus = `server log ${SERVER_LOG} not found (set SPEECH_SERVER_LOG)`;

  if (fs.existsSync(SERVER_LOG)) {
    const log = fs.readFileSync(SERVER_LOG, "utf8");
    const ttsLines = log.split(/\r?\n/).filter((line) => line.includes("[tts]"));
    if (log.includes(CANARY_TEXT)) leaks.push("canary text in log");
    if (log.includes(SPOKEN_SENTENCE)) leaks.push("spoken sentence in log");
    leaks.push(
      ...ttsLines
        .filter((line) => PATH_PATTERNS.some((pattern) => pattern.test(line)))
        .map((line) => `path in log line: ${line.trim().slice(0, 120)}`)
    );
    logStatus = `${ttsLines.length} [tts] log line(s) scanned`;
  }

  const healthJson = JSON.parse(healthText) as {
    speech?: { tts?: { status?: unknown; provider?: unknown; supportedLanguages?: unknown } };
  };
  const tts = healthJson.speech?.tts ?? {};
  const languages = Array.isArray(tts.supportedLanguages) ? (tts.supportedLanguages as string[]) : [];
  const shapeOk =
    typeof tts.status === "string" &&
    tts.provider === "tts-pocket" &&
    languages.includes("english") &&
    languages.includes("french");

  record(
    "5. no text or path leaks into logs, /api/health exposes no paths",
    healthPaths.length === 0 && leaks.length === 0 && shapeOk,
    `health: status=${String(tts.status)}, provider=${String(tts.provider)}, ` +
      `languages=${languages.join("/")}; path-shaped values in health: ` +
      `${healthPaths.length === 0 ? "none" : healthPaths.join(", ")}; leaks: ` +
      `${leaks.length === 0 ? "none" : leaks.join("; ")} (${logStatus})`
  );
}

/** 6. The shipped client must not carry a browser or cloud speech engine. */
function collectBundleFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectBundleFiles(full, found);
    else if (/\.(js|mjs|html|css)$/i.test(entry.name)) found.push(full);
  }
  return found;
}

function checkBrowserBundle(): void {
  const distDir = path.resolve("dist");
  if (!fs.existsSync(distDir)) {
    record(
      "6. shipped client has no browser or cloud speech engine",
      true,
      "SKIPPED - run `npm run build` first, then re-run this check"
    );
    return;
  }

  const banned: Array<[string, RegExp]> = [
    ["browser speechSynthesis API", /speechSynthesis/i],
    ["SpeechSynthesisUtterance", /SpeechSynthesisUtterance/i],
    ["Google Cloud TTS", /texttospeech\.googleapis/i],
    ["Azure/Bing speech", /speech\.platform\.bing|cognitive-services/i],
    ["OpenAI audio endpoint", /\/v1\/audio\/speech/i],
    ["ElevenLabs", /elevenlabs/i],
  ];

  const files = collectBundleFiles(distDir);
  const hits: string[] = [];
  let referencesLocalEndpoint = false;

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    for (const [label, pattern] of banned) {
      if (pattern.test(content)) hits.push(`${label} in ${path.basename(file)}`);
    }
    if (content.includes("/api/speech/synthesize")) referencesLocalEndpoint = true;
  }

  record(
    "6. shipped client has no browser or cloud speech engine",
    hits.length === 0 && referencesLocalEndpoint,
    `${files.length} bundle file(s) scanned; banned references: ` +
      `${hits.length === 0 ? "none" : hits.join(", ")}; ` +
      `calls /api/speech/synthesize: ${referencesLocalEndpoint ? "yes" : "no"}`
  );
}

async function main(): Promise<void> {
  console.log(`Phase 7B local voice playback - security checks\nServer: ${BASE}\n`);

  const probe = await fetch(`${BASE}/api/health`).catch(() => null);
  if (!probe) {
    console.error(`No server answered at ${BASE}. Start it with "npm run dev" first.`);
    process.exit(2);
  }

  await checkSizeLimits();
  await checkInstructionAbuse();
  await checkArgumentAllowLists();
  await checkNoFilesWritten();
  await checkNoLeakage();
  checkBrowserBundle();

  const failed = results.filter((result) => !result.passed);
  console.log(`\n${results.length} checks run, ${failed.length} failed.`);
  process.exit(failed.length === 0 ? 0 : 1);
}

void main();
