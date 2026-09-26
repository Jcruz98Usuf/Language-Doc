/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pocket TTS provider (Phase 7B) - the engine behind local voice playback.
 *
 * Engine : Kyutai Pocket TTS (weights: kyutai/pocket-tts-without-voice-cloning)
 * Runtime: the `pocket_tts` Python package on CPU, installed on this machine
 * Weights: downloaded once (same trust model as `ollama pull`), then inference
 *          is offline. The worker is started with HF_HUB_OFFLINE=1 so a missing
 *          weight fails loudly instead of quietly reaching out to the network.
 *
 * How it runs: Express owns a long-lived worker process and speaks to it over
 * stdin/stdout as JSON lines (`pocket_tts_sidecar.py`, next to this file).
 *
 *   Express -> spawn(python, [sidecarScript]) -> stdio JSON -> audio in memory
 *
 * Why a worker and not a process per request: importing torch takes ~20s and
 * loading a model several more, so a process per request could never keep up
 * with a live conversation. The worker is started lazily, kept warm, and shut
 * down again after an idle period so it is not holding a gigabyte of memory
 * while nobody is talking.
 *
 * Security posture (this is the code that has to hold it):
 *   - The child is spawned with an argv ARRAY. No shell is used, so no text,
 *     language, voice or path from a request can ever be interpreted as a
 *     command, a flag or an executable name. The browser cannot influence the
 *     executable, the script, the model, the voice or the working directory.
 *   - Audio is produced in memory in the worker; nothing is written to disk
 *     anywhere in this pipeline, so there is no temporary file to name, clean
 *     up or leak, and no file-name handling to get wrong.
 *   - One request is in flight at a time (Pocket TTS is not thread-safe) and
 *     the queue is bounded, so a caller cannot build an unbounded backlog.
 *   - Message text is passed through and never logged here or in the worker.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import {
  TtsError,
  type SpeechReadiness,
  type SpeechRequest,
  type SynthesizedSpeech,
  type TextToSpeechProvider,
  type TtsErrorCode,
  type TtsLanguage,
} from "./types";

export const POCKET_TTS_PROVIDER_ID = "tts-pocket";

/** Built-in catalogue voices of the released model: one per supported language. */
export const POCKET_TTS_VOICES: Record<TtsLanguage, string> = {
  english: "alba",
  french: "cosette",
};

const HF_REPO = "kyutai/pocket-tts-without-voice-cloning";
export const POCKET_TTS_MODEL_ID = `${HF_REPO} (english, french)`;

const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_IDLE_SHUTDOWN_MS = 10 * 60_000;
const DEFAULT_MAX_QUEUE = 6;
const PYTHON_PROBE_TTL_MS = 60_000;

export interface PocketTtsConfig {
  /** Interpreter used to start the worker (operator setting, never per request). */
  pythonExecutable: string;
  /** Absolute path of the worker script shipped with the server. */
  sidecarScript: string;
  requestTimeoutMs: number;
  idleShutdownMs: number;
  maxQueue: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getPocketTtsConfig(): PocketTtsConfig {
  return {
    pythonExecutable: (process.env.SPEECH_TTS_PYTHON ?? "").trim() || "python",
    sidecarScript: resolveSidecarScript(),
    requestTimeoutMs: positiveInt(process.env.SPEECH_TTS_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
    idleShutdownMs: positiveInt(process.env.SPEECH_TTS_IDLE_MS, DEFAULT_IDLE_SHUTDOWN_MS),
    maxQueue: positiveInt(process.env.SPEECH_TTS_MAX_QUEUE, DEFAULT_MAX_QUEUE),
  };
}

/**
 * The worker ships with the server, so its path is derived from this module's
 * own location. There is deliberately no environment override: the script path
 * is not something a request should be able to redirect.
 */
function resolveSidecarScript(): string {
  try {
    return fileURLToPath(new URL("./pocket_tts_sidecar.py", import.meta.url));
  } catch {
    return path.resolve("src", "server", "services", "speech", "pocket_tts_sidecar.py");
  }
}

/* ------------------------------------------------------------------ */
/* Local weight / runtime detection                                   */
/* (model ids only - filesystem locations never reach the client)      */
/* ------------------------------------------------------------------ */

function huggingFaceCacheDir(): string {
  const explicit = (process.env.HF_HUB_CACHE ?? "").trim();
  if (explicit) return explicit;

  const home = (process.env.HF_HOME ?? "").trim();
  if (home) return path.join(home, "hub");

  return path.join(os.homedir(), ".cache", "huggingface", "hub");
}

/**
 * True when one file of the worker's model bundle is already on this disk.
 *
 * Hugging Face stores each file under the revision it was downloaded at, so the
 * files of a single model can legitimately live in different snapshot folders.
 * Each file is therefore looked up across all snapshots, exactly as
 * `hf_hub_download` resolves them.
 */
function isRepoFileCached(relativePath: string): boolean {
  const snapshotsDir = path.join(huggingFaceCacheDir(), `models--${HF_REPO.replace("/", "--")}`, "snapshots");

  let revisions: string[];
  try {
    revisions = fs.readdirSync(snapshotsDir);
  } catch {
    return false;
  }

  return revisions.some((revision) => fs.existsSync(path.join(snapshotsDir, revision, relativePath)));
}

/**
 * True when the worker's weights for this language are already on this disk, so
 * a session will not have to download them first (and, with offline mode
 * enforced, will not fail because one is needed).
 */
export function isLanguageWeightsCached(language: TtsLanguage): boolean {
  const voice = POCKET_TTS_VOICES[language];
  return (
    isRepoFileCached(path.join("languages", language, "model.safetensors")) &&
    isRepoFileCached(path.join("languages", language, "tokenizer.json")) &&
    isRepoFileCached(path.join("languages", language, "embeddings", `${voice}.safetensors`))
  );
}

let pythonProbe: { at: number; available: boolean; version: string } | null = null;

/** Spawns `python --version` at most once a minute; the interpreter is a fixed argv entry. */
async function probePython(executable: string): Promise<{ available: boolean; version: string }> {
  if (pythonProbe && Date.now() - pythonProbe.at < PYTHON_PROBE_TTL_MS) return pythonProbe;

  const result = await new Promise<{ available: boolean; version: string }>((resolve) => {
    let settled = false;
    const finish = (available: boolean, version: string) => {
      if (settled) return;
      settled = true;
      resolve({ available, version });
    };

    try {
      const child = spawn(executable, ["--version"], { windowsHide: true, shell: false });
      let out = "";
      const timer = setTimeout(() => {
        child.kill();
        finish(false, "");
      }, 10_000);

      child.stdout?.on("data", (chunk) => (out += String(chunk)));
      child.stderr?.on("data", (chunk) => (out += String(chunk)));
      child.on("error", () => {
        clearTimeout(timer);
        finish(false, "");
      });
      child.on("close", () => {
        clearTimeout(timer);
        const version = out.replace(/^Python\s*/i, "").trim();
        finish(version.length > 0, version);
      });
    } catch {
      finish(false, "");
    }
  });

  pythonProbe = { at: Date.now(), ...result };
  return result;
}

/**
 * Cheap readiness probe used by /api/health: the worker script, an interpreter,
 * and whether the English and French weights are already local. It never starts
 * the worker (that costs ~20s and a gigabyte of memory), so a status request
 * stays instant.
 */
export async function pocketTtsReadiness(): Promise<
  SpeechReadiness & { python: string; modelsCached: { english: boolean; french: boolean } }
> {
  const config = getPocketTtsConfig();

  if (!fs.existsSync(config.sidecarScript)) {
    return {
      ready: false,
      detail: "The local voice worker is missing from this installation.",
      python: "",
      modelsCached: { english: false, french: false },
    };
  }

  const python = await probePython(config.pythonExecutable);
  if (!python.available) {
    return {
      ready: false,
      detail:
        "Python 3 is not available on this machine, so local voice playback is switched off. " +
        "Install Python and the pocket-tts package to enable it.",
      python: "",
      modelsCached: { english: false, french: false },
    };
  }

  const modelsCached = {
    english: isLanguageWeightsCached("english"),
    french: isLanguageWeightsCached("french"),
  };
  const cachedLanguages = Object.entries(modelsCached)
    .filter(([, cached]) => cached)
    .map(([language]) => language);

  if (cachedLanguages.length === 0) {
    return {
      ready: false,
      detail:
        `Python ${python.version} is available, but no local voice model is installed yet. ` +
        "Voice playback stays off until the weights are present on this machine.",
      python: python.version,
      modelsCached,
    };
  }

  return {
    ready: true,
    detail:
      `Local voice playback ready (Pocket TTS, Python ${python.version}, ` +
      `cached: ${cachedLanguages.join(", ")}).`,
    python: python.version,
    modelsCached,
  };
}
/* ------------------------------------------------------------------ */
/* Worker process                                                     */
/* ------------------------------------------------------------------ */

interface SidecarResult {
  wavB64: string;
  sampleRate: number;
  durationSeconds: number;
  firstChunkMs: number;
  synthesisMs: number;
  modelLoadMs: number;
  voice: string;
  model: string;
  truncated?: boolean;
  rssMb: number;
  peakRssMb: number;
}

interface SidecarFailure {
  code: string;
  message: string;
}

interface Pending {
  resolve: (value: SidecarResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const STARTUP_TIMEOUT_MS = 90_000;

/**
 * The worker's own diagnostics are worth keeping, but they must never put a
 * filesystem path into the server log: an absolute Windows path, a UNC path or a
 * POSIX path is replaced with a marker. The worker already prefixes its lines
 * with "[tts]", so that prefix is folded away before the server adds its own.
 */
function sanitizeWorkerLog(chunk: string): string {
  return chunk
    .trim()
    .replace(/^\[tts\]\s*/, "")
    .replace(/[A-Za-z]:[\\/][^\s,;)"']+/g, "<path>")
    .replace(/\\\\[^\\\s]+[\\/][^\s,;)"']+/g, "<path>")
    .replace(/(^|\s)\/(?:Users|home|opt|tmp|var|private|srv|etc)\/[^\s,;)"']+/g, "$1<path>");
}

/**
 * Owns exactly one worker process.
 *
 * The protocol is one JSON object per line in each direction, so a request is
 * addressed by a random id and answers are matched back to it. Nothing is ever
 * built by string concatenation of input: the request object is serialized as
 * JSON and written to the child's stdin.
 */
class PocketTtsWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startup: Promise<void> | null = null;
  private startupResolve: (() => void) | null = null;
  private startupReject: ((error: Error) => void) | null = null;
  /** Failure reported before a caller was waiting (for example a bad interpreter). */
  private startupError: Error | null = null;
  private buffer = "";
  private readonly pending = new Map<string, Pending>();
  private readonly statusWaiters = new Map<string, (payload: Record<string, unknown>) => void>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while a deliberate (idle) shutdown is in flight; that worker is unusable. */
  private stopping = false;
  private waiting = 0;
  /** Serializes requests: the engine is not thread-safe, so exactly one runs. */
  private tail: Promise<unknown> = Promise.resolve();

  /** Requests that are running or queued - used to bound the backlog. */
  get load(): number {
    return this.pending.size + this.waiting;
  }

  get running(): boolean {
    return this.child !== null && !this.child.killed && this.startup !== null;
  }

  /**
   * Queues one request and answers when the worker replies.
   *
   * Requests are chained, never run in parallel: Pocket TTS generation is not
   * thread-safe, and serializing also means one utterance cannot distort
   * another. `load` reports the queue depth so the caller can refuse work
   * instead of building a backlog.
   */
  async send(request: Record<string, unknown>): Promise<SidecarResult> {
    this.waiting += 1;
    const run = this.tail.then(
      () => this.dispatch(request),
      () => this.dispatch(request)
    );
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async dispatch(request: Record<string, unknown>): Promise<SidecarResult> {
    this.waiting -= 1;
    const child = await this.ensureStarted();
    const config = getPocketTtsConfig();
    const id = randomUUID();
    this.clearIdleTimer();

    return new Promise<SidecarResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A worker that has stopped answering is unusable: stop it so the next
        // request starts from a clean process instead of queueing behind it.
        this.stopNow();
        reject(
          new TtsError(
            "timeout",
            "Local voice playback timed out. The message text is unaffected - you can still read it."
          )
        );
      }, config.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      // JSON over stdin: request text is data, never part of a command line.
      const line = `${JSON.stringify({ id, ...request })}\n`;
      try {
        child.stdin.write(line, "utf8", (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(
            new TtsError("engine-unavailable", "The local voice worker stopped accepting requests.")
          );
        });
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new TtsError("engine-unavailable", "The local voice worker is not reachable."));
      }
    });
  }

  /** Diagnostic snapshot of the worker; starts it when needed. */
  async status(): Promise<Record<string, unknown>> {
    const child = await this.ensureStarted();
    const id = randomUUID();

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.statusWaiters.delete(id);
        reject(new TtsError("timeout", "The local voice worker did not answer a status request."));
      }, 30_000);

      this.statusWaiters.set(id, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });

      child.stdin.write(`${JSON.stringify({ id, cmd: "status" })}\n`);
    });
  }

  /** Graceful stop: the worker exits on its own, and is killed if it does not. */
  stop(): void {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    try {
      child.stdin.write(`${JSON.stringify({ cmd: "shutdown" })}\n`);
    } catch {
      this.stopNow();
      return;
    }
    setTimeout(() => {
      if (this.child === child) this.stopNow();
    }, 3_000);
  }

  private stopNow(): void {
    const child = this.child;
    this.child = null;
    this.startup = null;
    this.stopping = false;
    this.clearIdleTimer();
    this.buffer = "";

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(
        new TtsError("engine-unavailable", "The local voice worker stopped unexpectedly.")
      );
    }

    if (child) {
      try {
        child.stdin.end();
      } catch {
        /* already closed */
      }
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * Releases the worker (and its model memory) after a quiet period. The next
   * request simply starts it again, so this only trades a cold start for RAM.
   */
  private scheduleIdleShutdown(): void {
    const { idleShutdownMs } = getPocketTtsConfig();
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      // Never shut down on top of work: a request that is queued (waiting) or in
      // flight (pending) would land on a process that is already leaving.
      if (this.pending.size > 0 || this.waiting > 0) return;
      this.stop();
    }, idleShutdownMs);
    // Do not keep the Node event loop alive for the sake of a sleeping worker.
    this.idleTimer.unref?.();
  }

  /**
   * Starts the worker if it is not running and waits for its readiness line.
   *
   * The child is spawned with an argv array and `shell: false`, so nothing from
   * a request can reach a command line. `HF_HUB_OFFLINE=1` is forced so a
   * missing weight fails here instead of silently downloading from the network.
   */
  private async ensureStarted(): Promise<ChildProcessWithoutNullStreams> {
    // A failure that arrived before anyone was waiting is replayed here instead
    // of being lost, so a bad interpreter fails fast rather than hanging.
    if (this.startupError) {
      const error = this.startupError;
      this.startupError = null;
      throw error;
    }

    // A worker that was told to stop (idle shutdown) cannot be written to any
    // more. A request that arrives during that window gets a fresh process
    // rather than a 503 for a child that is on its way out.
    if (this.stopping) this.stopNow();

    if (this.startup) {
      try {
        await this.startup;
      } catch {
        /* that worker exited while we waited; a new one starts below */
      }
      if (this.child) return this.child;
    }

    const config = getPocketTtsConfig();
    if (!fs.existsSync(config.sidecarScript)) {
      throw new TtsError("engine-unavailable", "The local voice worker is missing from this installation.");
    }

    const child = spawn(config.pythonExecutable, [config.sidecarScript], {
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
        HF_HUB_OFFLINE: (process.env.HF_HUB_OFFLINE ?? "1").trim() || "1",
        HF_HUB_DISABLE_TELEMETRY: "1",
      },
    });

    this.child = child;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Worker diagnostics only: request text never appears in its log lines.
      const text = sanitizeWorkerLog(String(chunk));
      if (text) console.log(`[tts] ${text}`);
    });

    child.on("error", (error) => {
      const message = sanitizeWorkerLog(error instanceof Error ? error.message : String(error));
      console.error(`[tts] worker could not be started: ${message}`);
      if (this.child !== child) return;
      this.rejectStartup(new TtsError("engine-unavailable", "The local voice worker could not be started."));
      this.failPending("The local voice worker could not be started.");
    });

    child.on("close", (code) => {
      // A worker we already replaced (idle shutdown, restart after a timeout)
      // must not disturb the state of the process that took over.
      if (this.child !== child) return;
      this.child = null;
      this.startup = null;
      this.stopping = false;
      if (this.pending.size > 0) {
        console.warn(`[tts] worker exited (code ${code}) with ${this.pending.size} request(s) outstanding`);
      }
      this.rejectStartup(
        new TtsError("engine-unavailable", "The local voice worker stopped before it was ready.")
      );
      this.failPending("The local voice worker stopped unexpectedly.");
    });

    this.startup = new Promise<void>((resolve, reject) => {
      this.startupResolve = resolve;
      this.startupReject = reject;
    });

    const watchdog = setTimeout(() => {
      console.error("[tts] worker did not announce readiness in time");
      this.stopNow();
    }, STARTUP_TIMEOUT_MS);
    watchdog.unref?.();

    try {
      await this.startup;
      clearTimeout(watchdog);
      if (!this.child) {
        throw new TtsError("engine-unavailable", "The local voice worker stopped before it was ready.");
      }
      return this.child;
    } catch (error) {
      clearTimeout(watchdog);
      this.startup = null;
      throw error;
    }
  }

  private rejectStartup(error: Error): void {
    const reject = this.startupReject;
    this.startupResolve = null;
    this.startupReject = null;
    if (reject) reject(error);
    else this.startupError = error;
  }

  private failPending(message: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new TtsError("engine-unavailable", message));
    }
  }

  /** Accumulates stdout and splits it into whole protocol lines. */
  private onStdout(chunk: string): void {
    this.buffer += chunk;

    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleLine(line);
    }

    // Guard against a worker that never terminates a line.
    if (this.buffer.length > 64 * 1024 * 1024) {
      console.error("[tts] discarding an over-long worker response");
      this.buffer = "";
    }
  }

  private handleLine(line: string): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.warn("[tts] ignored a malformed line from the worker");
      return;
    }

    if (payload.event === "ready") {
      const resolve = this.startupResolve;
      this.startupResolve = null;
      this.startupReject = null;
      resolve?.();
      return;
    }

    const id = typeof payload.id === "string" ? payload.id : "";

    const statusWaiter = this.statusWaiters.get(id);
    if (statusWaiter) {
      this.statusWaiters.delete(id);
      statusWaiter(payload);
      return;
    }

    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (payload.ok === true) pending.resolve(payload as unknown as SidecarResult);
    else pending.reject(toTtsError(payload as unknown as SidecarFailure));

    this.scheduleIdleShutdown();
  }
}

/** Maps a worker failure onto the code the HTTP layer and the UI understand. */
function toTtsError(failure: SidecarFailure): TtsError {
  const code = String(failure.code ?? "synthesis-failed");
  const message = String(failure.message ?? "Local voice playback failed.");

  const mapped: TtsErrorCode =
    code === "unsupported-language"
      ? "unsupported-language"
      : code === "clone-unavailable"
        ? "voice-matching-unavailable"
        : code === "bad-voice-mode"
          ? "unsupported-voice-mode"
          : code === "bad-text"
            ? "empty-text"
            : code === "engine-unavailable"
              ? "engine-unavailable"
              : code === "timeout"
                ? "timeout"
                : "synthesis-failed";

  return new TtsError(mapped, message);
}

/* ------------------------------------------------------------------ */
/* Provider                                                           */
/* ------------------------------------------------------------------ */

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Local voice playback, backed by one Pocket TTS worker process.
 *
 * `synthesize` is the only place audio is produced for the application, and it
 * returns a complete WAV held in memory - there is no temporary file anywhere in
 * this pipeline to name, clean up or leak.
 */
export class PocketTtsProvider implements TextToSpeechProvider {
  readonly id = POCKET_TTS_PROVIDER_ID;
  readonly label = "Local Pocket TTS worker (Kyutai Pocket TTS, offline, on this machine)";

  private readonly worker = new PocketTtsWorker();

  /** Never starts the worker: /api/health must stay instant. */
  async readiness(): Promise<SpeechReadiness> {
    const { ready, detail } = await pocketTtsReadiness();
    return { ready, detail };
  }

  async synthesize(request: SpeechRequest): Promise<SynthesizedSpeech> {
    if (request.signal?.aborted) {
      throw new TtsError("cancelled", "Voice playback was cancelled.");
    }

    // Bound the backlog: a caller must never be able to queue minutes of work.
    if (this.worker.load >= getPocketTtsConfig().maxQueue) {
      throw new TtsError(
        "busy",
        "The local voice engine is still speaking another line. Try again in a moment."
      );
    }

    let onAbort: (() => void) | null = null;
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!request.signal) return;
      onAbort = () => reject(new TtsError("cancelled", "Voice playback was cancelled."));
      request.signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      const result = await Promise.race([
        this.worker.send({
          cmd: "synth",
          text: request.text,
          language: request.language,
          voiceMode: request.voiceMode,
        }),
        aborted,
      ]);

      const wavBase64 = typeof result.wavB64 === "string" ? result.wavB64 : "";
      const audio = Buffer.from(wavBase64, "base64");
      // A WAV header alone is 44 bytes: anything at or below that is no audio.
      if (audio.byteLength <= 44) {
        throw new TtsError("synthesis-failed", "The local voice engine produced no audio.");
      }

      return {
        audio,
        mimeType: "audio/wav",
        sampleRate: asNumber(result.sampleRate, 24_000),
        durationSeconds: asNumber(result.durationSeconds, 0),
        provider: this.id,
        model: typeof result.model === "string" ? result.model : POCKET_TTS_MODEL_ID,
        voice: typeof result.voice === "string" ? result.voice : POCKET_TTS_VOICES[request.language],
        voiceMode: request.voiceMode,
        synthesisMs: asNumber(result.synthesisMs, 0),
        modelLoadMs: asNumber(result.modelLoadMs, 0),
        firstAudioMs: asNumber(result.firstChunkMs, 0),
        truncated: result.truncated === true,
        cached: false,
      };
    } finally {
      if (onAbort && request.signal) request.signal.removeEventListener("abort", onAbort);
    }
  }

  /** Diagnostic snapshot of the worker (benchmarks and tests). */
  async status(): Promise<Record<string, unknown>> {
    return this.worker.status();
  }

  /** Releases the worker process and the model memory it holds. */
  shutdown(): void {
    this.worker.stop();
  }
}

/**
 * One provider per server process: it owns the single worker, so the model
 * residency policy is decided in one place.
 */
export const pocketTtsProvider = new PocketTtsProvider();

/** Stops the worker (used on server shutdown and at the end of a test run). */
export function stopPocketTtsWorker(): void {
  pocketTtsProvider.shutdown();
}

