/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Local inference transport for Language Doctor.
 *
 * This is the ONLY module that talks to the local inference runtime (Ollama).
 * It is never imported by the browser bundle. The data path is:
 *
 *   React  ->  Express API (server.ts)  ->  Ollama (127.0.0.1:11434)  ->  qwen3:1.7b
 *
 * No cloud AI provider is contacted at any point, and no API keys are used.
 */

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen3:1.7b";

const DEFAULT_GENERATE_TIMEOUT_MS = 120_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

export type OllamaErrorCode = "unavailable" | "model-missing" | "timeout" | "bad-response" | "cancelled";

/** Error raised by the local engine, carrying a machine readable code. */
export class OllamaError extends Error {
  readonly code: OllamaErrorCode;
  readonly httpStatus?: number;

  constructor(message: string, code: OllamaErrorCode, httpStatus?: number) {
    super(message);
    this.name = "OllamaError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function isOllamaError(value: unknown): value is OllamaError {
  return value instanceof OllamaError;
}

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  generateTimeoutMs: number;
  healthTimeoutMs: number;
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : DEFAULT_OLLAMA_BASE_URL;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reads the local engine configuration from the environment (with safe defaults). */
export function getOllamaConfig(): OllamaConfig {
  return {
    baseUrl: normalizeBaseUrl(process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL),
    model: (process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL,
    generateTimeoutMs: readPositiveInt(process.env.OLLAMA_TIMEOUT_MS, DEFAULT_GENERATE_TIMEOUT_MS),
    healthTimeoutMs: readPositiveInt(process.env.OLLAMA_HEALTH_TIMEOUT_MS, DEFAULT_HEALTH_TIMEOUT_MS),
  };
}

/** Collapses whitespace and clips text so engine errors stay readable in logs. */
export function truncateForLog(value: string, max = 300): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}...`;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const forwardAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", forwardAbort, { once: true });
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", forwardAbort);
  }
}

function describeConnectionFailure(
  error: unknown,
  config: OllamaConfig,
  timeoutMs: number,
  externalSignal?: AbortSignal
): OllamaError {
  if (isOllamaError(error)) return error;

  if (externalSignal?.aborted) {
    return new OllamaError("Request cancelled before the local model answered.", "cancelled");
  }

  if (error instanceof Error && error.name === "AbortError") {
    return new OllamaError(
      `The local model "${config.model}" took longer than ${Math.round(timeoutMs / 1000)}s to answer. ` +
        `Try a shorter message or raise OLLAMA_TIMEOUT_MS.`,
      "timeout"
    );
  }

  const cause = (error as { cause?: { code?: string } } | undefined)?.cause?.code;
  const detail = cause ?? (error instanceof Error ? error.message : String(error));
  return new OllamaError(
    `Local AI engine unreachable at ${config.baseUrl} (${detail}). ` +
      `Start it with "ollama serve" and confirm "${config.model}" is pulled.`,
    "unavailable"
  );
}

/**
 * Removes reasoning wrappers that small local models sometimes emit
 * (for example qwen3 thinking blocks) so callers receive clean text.
 */
export function normalizeModelText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .trim();
}

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AskModelOptions {
  messages: OllamaChatMessage[];
  /** Ask Ollama to constrain the answer to a single JSON object. */
  jsonMode?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Overrides OLLAMA_MODEL for a single call. */
  model?: string;
  /**
   * How long Ollama keeps the model resident after this call ("30m", "1h", or
   * -1 to hold until shutdown). Defaults to "30m" so an idle demo does not turn
   * the next translation into a cold start.
   */
  keepAlive?: string;
  /** Caller supplied cancellation (for example a disconnected HTTP client). */
  signal?: AbortSignal;
}

export interface AskModelResult {
  text: string;
  model: string;
  durationMs: number;
  evalCount: number;
}

/**
 * Some Ollama builds ignore the `think` flag while others reject unknown fields.
 * We try with `think: false` first (keeps qwen3 answers fast and clean) and fall
 * back automatically if the runtime complains.
 */
let runtimeSupportsThinkFlag = true;

function buildChatRequestBody(options: AskModelOptions, model: string, useThinkFlag: boolean): string {
  const body: Record<string, unknown> = {
    model,
    messages: options.messages,
    stream: false,
    // Ollama unloads a model after 5 idle minutes by default, which silently made
    // the next translation pay a full reload mid-conversation - the "it got slow
    // again" effect. Holding the model for a long window keeps a demo's pauses
    // between sentences from turning into a cold start every few minutes.
    keep_alive: options.keepAlive ?? "30m",
    options: {
      temperature: options.temperature ?? 0.2,
      // Small models fall into repetition loops without a penalty. Keep the
      // window wide enough that narrowing-translation word choices stay natural.
      repeat_penalty: 1.15,
      repeat_last_n: 256,
      ...(options.maxOutputTokens ? { num_predict: options.maxOutputTokens } : {}),
    },
  };

  if (useThinkFlag) body.think = false;
  if (options.jsonMode) body.format = "json";

  return JSON.stringify(body);
}

/**
 * Low level call to the local chat endpoint (`POST /api/chat`).
 * Never called from the browser: only server-side services use this.
 */
export async function askModel(options: AskModelOptions): Promise<AskModelResult> {
  if (!options.messages.length) {
    throw new OllamaError("askModel() requires at least one message.", "bad-response");
  }

  const config = getOllamaConfig();
  const model = (options.model ?? config.model).trim() || config.model;
  const timeoutMs = options.timeoutMs ?? config.generateTimeoutMs;
  const startedAt = Date.now();

  const send = (useThinkFlag: boolean) =>
    fetchWithTimeout(
      `${config.baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: buildChatRequestBody(options, model, useThinkFlag),
      },
      timeoutMs,
      options.signal
    );

  let response: Response | null = null;
  let rejectionDetail = "";

  try {
    response = await send(runtimeSupportsThinkFlag);

    if (!response.ok && response.status === 400 && runtimeSupportsThinkFlag) {
      rejectionDetail = await response.text();
      if (/think/i.test(rejectionDetail)) {
        runtimeSupportsThinkFlag = false;
        response = await send(false);
      }
    }

    if (!response.ok) {
      const detail = rejectionDetail || (await response.text());
      if (response.status === 404) {
        throw new OllamaError(
          `Model "${model}" is not installed in the local Ollama library. Run "ollama pull ${model}" and try again.`,
          "model-missing",
          404
        );
      }
      throw new OllamaError(
        `The local AI engine rejected the request (HTTP ${response.status}). ${truncateForLog(detail)}`,
        "bad-response",
        response.status
      );
    }
  } catch (error) {
    throw describeConnectionFailure(error, config, timeoutMs, options.signal);
  }

  if (!response) {
    throw new OllamaError("The local AI engine did not return a response.", "unavailable");
  }

  let payload: { message?: { content?: string }; error?: string; eval_count?: number };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    throw new OllamaError("The local AI engine returned a response that was not valid JSON.", "bad-response");
  }

  if (payload.error) {
    throw new OllamaError(`The local AI engine reported an error: ${truncateForLog(payload.error)}`, "bad-response");
  }

  const text = normalizeModelText(payload.message?.content ?? "");
  if (!text) {
    throw new OllamaError("The local model returned an empty response. Try rephrasing the message.", "bad-response");
  }

  return { text, model, durationMs: Date.now() - startedAt, evalCount: payload.eval_count ?? 0 };
}

export interface OllamaHealth {
  baseUrl: string;
  model: string;
  reachable: boolean;
  modelInstalled: boolean;
  installedModels: string[];
  latencyMs: number | null;
  error: string | null;
  hint: string | null;
}

function matchesModelName(installedName: string, configuredModel: string): boolean {
  const installed = installedName.trim().toLowerCase();
  const configured = configuredModel.trim().toLowerCase();
  if (!installed || !configured) return false;
  if (installed === configured) return true;
  if (!configured.includes(":") && installed.split(":")[0] === configured) return true;
  return installed === `${configured}:latest`;
}

/**
 * Probes the local engine: is Ollama up, and is the configured model pulled?
 * Backs the GET /api/health endpoint. Short timeout so it never blocks a demo.
 */
export async function checkOllamaHealth(): Promise<OllamaHealth> {
  const config = getOllamaConfig();
  const startedAt = Date.now();

  try {
    const response = await fetchWithTimeout(
      `${config.baseUrl}/api/tags`,
      { method: "GET", headers: { Accept: "application/json" } },
      config.healthTimeoutMs
    );
    const latencyMs = Date.now() - startedAt;

    if (!response.ok) {
      return {
        baseUrl: config.baseUrl,
        model: config.model,
        reachable: false,
        modelInstalled: false,
        installedModels: [],
        latencyMs,
        error: `Ollama answered the model list request with HTTP ${response.status}.`,
        hint: `Confirm OLLAMA_BASE_URL (${config.baseUrl}) points at a running "ollama serve" instance.`,
      };
    }

    const payload = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
    const installedModels = (payload.models ?? [])
      .map((entry) => (entry.name ?? entry.model ?? "").trim())
      .filter((name) => name.length > 0)
      .sort((a, b) => a.localeCompare(b));

    const modelInstalled = installedModels.some((name) => matchesModelName(name, config.model));

    return {
      baseUrl: config.baseUrl,
      model: config.model,
      reachable: true,
      modelInstalled,
      installedModels,
      latencyMs,
      error: null,
      hint: modelInstalled ? null : `Run "ollama pull ${config.model}" to install the configured model.`,
    };
  } catch (error) {
    return {
      baseUrl: config.baseUrl,
      model: config.model,
      reachable: false,
      modelInstalled: false,
      installedModels: [],
      latencyMs: null,
      error: describeConnectionFailure(error, config, config.healthTimeoutMs).message,
      hint: `Start the local engine with "ollama serve", then run "ollama pull ${config.model}".`,
    };
  }
}

/**
 * Loads the configured model into memory so the first real request of a demo is
 * not slowed down by a cold start. Never throws: failures are reported only.
 */
export async function warmUpLocalModel(): Promise<{ ok: boolean; durationMs: number; error: string | null }> {
  const startedAt = Date.now();
  try {
    await askModel({
      messages: [{ role: "user", content: "ping" }],
      temperature: 0,
      maxOutputTokens: 8,
      timeoutMs: 60_000,
    });
    return { ok: true, durationMs: Date.now() - startedAt, error: null };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}