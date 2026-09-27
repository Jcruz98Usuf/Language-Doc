/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared helpers for Phase 8. Everything here talks to a real server over real
 * HTTP - there is no in-process stand-in for a route.
 *
 * Two tiers, and the difference is visible from the folder name:
 *
 *   tests/contract  - asserts the HTTP contract and every input-validation rule.
 *                     Runs anywhere: no Ollama, no Whisper, no Pocket TTS needed.
 *   tests/models    - asserts behaviour that only exists when an engine is
 *                     installed. Each file probes /api/health first and skips
 *                     with a printed reason when its engine is missing, so a skip
 *                     is always explained, never silent.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "vitest";
import { ROOT, SERVER_INFO, type ServerInfo } from "./bootServer";
import { recordSkip } from "./skipFile";

export { ROOT };

/** The built client bundle, when `npm run build` has been run. */
export const DIST_DIR = path.join(ROOT, "dist");

/* ------------------------------------------------------------------ */
/* Server handle                                                      */
/* ------------------------------------------------------------------ */

let cachedInfo: ServerInfo | null = null;

/** The instance this run is talking to, as published by `globalSetup`. */
export function serverInfo(): ServerInfo {
  if (cachedInfo) return cachedInfo;
  if (!existsSync(SERVER_INFO)) {
    throw new Error(
      `${SERVER_INFO} is missing - the vitest global setup did not run. ` +
        "Run the suite with `npm test` (vitest.config.ts wires tests/helpers/globalSetup.ts)."
    );
  }
  cachedInfo = JSON.parse(readFileSync(SERVER_INFO, "utf8")) as ServerInfo;
  return cachedInfo;
}

export function baseUrl(): string {
  return serverInfo().baseUrl;
}

/** The captured stdout/stderr of the server process this run started. */
export function serverLog(): string {
  const file = serverInfo().logFile;
  if (!existsSync(file)) return "";
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* Requests                                                           */
/* ------------------------------------------------------------------ */

export interface ApiResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON body, or null when the body was not JSON. */
  json: unknown;
  /** Raw body decoded as utf8 - for audio responses this is lossy, use `bytes`. */
  text: string;
  bytes: Buffer;
  durationMs: number;
}

export interface ApiRequest {
  method?: "GET" | "POST" | "DELETE" | "PUT";
  headers?: Record<string, string>;
  /** Plain objects are JSON-encoded; strings and Buffers are sent as-is. */
  body?: unknown;
  timeoutMs?: number;
}

/** Sends one real request to the server under test. */
export async function api(pathname: string, init: ApiRequest = {}): Promise<ApiResponse> {
  const started = Date.now();
  const isPlain = init.body !== undefined && !(init.body instanceof Buffer) && typeof init.body !== "string";
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (isPlain && !headers["content-type"]) headers["content-type"] = "application/json";

  const response = await fetch(`${baseUrl()}${pathname}`, {
    method: init.method ?? "GET",
    headers,
    body:
      init.body === undefined
        ? undefined
        : init.body instanceof Buffer || typeof init.body === "string"
          ? init.body
          : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs ?? 170_000),
  });

  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("utf8");
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return { status: response.status, headers: response.headers, json, text, bytes, durationMs: Date.now() - started };
}

/** `x-session-token` is the documented transport; see server.ts readSessionToken. */
export function withToken(token: string): Record<string, string> {
  return { "x-session-token": token };
}

/** The `{ token }` body fallback for clients that cannot set headers on DELETE. */
/** The `{ token }` body fallback for clients that cannot set headers on DELETE. */
export const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/** A complete 16-bit PCM WAV rather than an error page. */
export function isWav(buffer: Buffer): boolean {
  return buffer.byteLength > 44 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE";
}

/* ------------------------------------------------------------------ */
/* Local-first invariants shared by several files                     */
/* ------------------------------------------------------------------ */

/**
 * Filesystem shapes that must never appear in an API response or a log line.
 * Carried over from the Phase 7B security checks, unchanged.
 */
export const PATH_PATTERNS: RegExp[] = [
  /[A-Za-z]:[\\/](?:Users|Program Files|ProgramData)/i,
  /\/home\/[a-z]/i,
  /\/etc\/passwd/i,
  /site-packages/i,
  /\.cache[\\/](?:hub|huggingface)/i,
  /python\.exe/i,
  /AppData/i,
  /Traceback \(most recent call last\)/i,
];

export function findPathLeaks(text: string): string[] {
  return PATH_PATTERNS.filter((pattern) => pattern.test(text)).map(String);
}

/**
 * Cloud and browser speech engines the local-first promise rules out. The same
 * list the Phase 7B checks used, now enforced on every commit.
 */
export const BANNED_ENGINE_REFERENCES: Array<[string, RegExp]> = [
  ["browser speechSynthesis API", /speechSynthesis/i],
  ["SpeechSynthesisUtterance", /SpeechSynthesisUtterance/i],
  ["Google Cloud TTS", /texttospeech\.googleapis/i],
  ["Azure/Bing speech", /speech\.platform\.bing|cognitive-services/i],
  ["OpenAI audio endpoint", /\/v1\/audio\/speech/i],
  ["ElevenLabs", /elevenlabs/i],
  ["DeepL API", /api\.deepl\.com/i],
  ["Google Cloud Translate", /translation\.googleapis\.com/i],
  ["Azure Translator", /api\.cognitive\.microsoft\.com\/translator/i],
];

/** Every file under `dir` whose name matches, recursively. */
export function collectFiles(dir: string, pattern: RegExp, found: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat: ReturnType<typeof statSync> | null = null;
    try {
      stat = statSync(full);
    } catch {
      stat = null;
    }
    if (stat?.isDirectory()) collectFiles(full, pattern, found);
    else if (stat?.isFile() && pattern.test(entry)) found.push(full);
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* /api/health                                                        */
/* ------------------------------------------------------------------ */

/** Mirrors the response built in server.ts; typed loosely on purpose. */
export interface HealthJson {
  status: string;
  engine: string;
  cloudProviders: string;
  timestamp: string;
  uptimeSeconds: number;
  ollama: Record<string, unknown> & { reachable?: boolean; modelInstalled?: boolean; model?: string };
  intelligence: Record<string, unknown> & { available?: boolean; provider?: string; model?: string };
  translation: Record<string, unknown> & { ready?: boolean; activeProvider?: string; detail?: string };
  stt: Record<string, unknown> & { available?: boolean; provider?: string; model?: string };
  speech: { tts: Record<string, unknown> & { status?: string; provider?: string; supportedLanguages?: unknown } };
  sessions: Record<string, unknown>;
}

export async function getHealth(timeoutMs = 30_000): Promise<HealthJson> {
  const response = await api("/api/health", { timeoutMs });
  if (response.json === null) {
    throw new Error(`GET /api/health returned a non-JSON body (status ${response.status}).`);
  }
  return response.json as HealthJson;
}

/* ------------------------------------------------------------------ */
/* Engine availability - what a model-backed test may actually run    */
/* ------------------------------------------------------------------ */

export interface EngineAvailability {
  /** Local chat model reachable in Ollama: needed by /api/parse-dialogue. */
  intelligence: boolean;
  /** A translation engine can answer: needed by the EN->FR behaviour test. */
  translation: boolean;
  /** A Whisper engine can transcribe. */
  stt: boolean;
  /** The Pocket TTS worker can be started. */
  tts: boolean;
  health: HealthJson | null;
  /** Why anything is unavailable; printed once per file when a suite skips. */
  note: string;
}

let probed: Promise<EngineAvailability> | null = null;

/**
 * Asks the running server which engines it actually has. This is the single
 * source of truth for a skip: the suite never guesses from the environment and
 * never pretends a model-backed path was covered.
 */
export function probeEngines(): Promise<EngineAvailability> {
  probed ??= (async () => {
    const missing: string[] = [];
    try {
      const health = await getHealth();
      const availability: EngineAvailability = {
        intelligence: health.intelligence?.available === true,
        translation: health.translation?.ready === true && health.ollama?.reachable === true,
        stt: health.stt?.available === true,
        tts: health.speech?.tts?.status === "ready",
        health,
        note: "",
      };
      if (!availability.intelligence) missing.push(`chat model ${String(health.ollama?.model ?? "?")}`);
      if (!availability.translation) missing.push(`translation: ${String(health.translation?.detail ?? "not ready")}`);
      if (!availability.stt) missing.push(`speech-to-text: ${String(health.stt?.provider ?? "?")}`);
      if (!availability.tts) missing.push(`voice playback: ${String(health.speech?.tts?.status ?? "?")}`);
      availability.note = missing.length ? `unavailable -> ${missing.join(" | ")}` : "all engines ready";
      return availability;
    } catch (error) {
      return {
        intelligence: false,
        translation: false,
        stt: false,
        tts: false,
        health: null,
        note: `could not read /api/health (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  })();
  return probed;
}

/**
 * Picks the suite function a model-tier file should use.
 *
 * A skipped suite stays in the report instead of disappearing, and the reason is
 * printed at collection so someone reading the raw log learns what is missing
 * without opening this file. `tests/report-skips.ts` restates the same reasons at
 * the end of the run.
 */
export function suiteRequiring(label: string, available: boolean, note: string): typeof describe {
  if (available) return describe;
  recordSkip(label, note);
  console.log(`[skip] ${label} - ${note}`);
  return describe.skip as typeof describe;
}

/**
 * The `it` for a single case inside an otherwise engine-free file.
 *
 * `health.*.available` means "ready to serve this request now", which is the
 * condition that matters here: a Whisper engine can be installed and still have no
 * weights on disk, in which case the first real audio starts a download the route
 * deliberately does not time out (`whisperOnnxProvider.ts`: loading is unbounded, only
 * inference is). A test that waits on that is watching a progress bar, not asserting a
 * contract - so it reports itself as skipped instead.
 */
export function itRequiring(label: string, available: boolean, note: string): typeof it {
  if (available) return it;
  recordSkip(label, note);
  console.log(`[skip] ${label} - ${note}`);
  return it.skip as typeof it;
}

/**
 * True when the server log is free of the engine's internal chatter.
 *
 * Phase 7B review item: Pocket TTS writes its `Input #0 ...` probe output to
 * stderr. It is filtered where it is generated, and this asserts the filter held
 * across a real synthesis run.
 */
export function logIsQuiet(...forbidden: string[]): { quiet: boolean; offenders: string[] } {
  const text = serverLog();
  const offenders = forbidden.filter((needle) => text.includes(needle));
  return { quiet: offenders.length === 0, offenders };
}

