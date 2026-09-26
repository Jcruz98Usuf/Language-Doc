/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Optional local speech-to-text SIDECAR provider (whisper.cpp).
 *
 * This is the "small sidecar service" variant of the Phase 7A architecture: a
 * local process that Express calls over HTTP, exactly like the existing
 * local-mt translation sidecar. It is NOT the active engine by default, because
 * this machine has no whisper.cpp binary installed and the in-process ONNX
 * provider needs no extra binary at all. It stays here so that dropping in a
 * whisper.cpp build later is a configuration change, not a code change.
 *
 * Expected local runtime contract (nothing here is exposed to the browser):
 *
 *   GET  {STT_SIDECAR_URL}/health
 *        -> { "status": "ok", "engine": "whisper.cpp", "model": "ggml-tiny.en.bin" }
 *   POST {STT_SIDECAR_URL}/transcribe
 *        <- body: raw 16-bit little-endian mono PCM at 16 kHz
 *           header x-audio-rate: 16000
 *           header x-audio-language: english
 *        -> { "text": "..." }
 *
 * Licence note: whisper.cpp is MIT and the ggml Whisper weights it loads are
 * MIT (openai/whisper), so this path keeps the same redistributable,
 * no-cloud posture as the translation models.
 */

import { SttError } from "./types";
import type {
  SpeechToTextProvider,
  SttReadiness,
  TranscriptionRequest,
  TranscriptionResult,
} from "./types";

export const WHISPER_CPP_PROVIDER_ID = "stt-whisper-cpp";
export const DEFAULT_WHISPER_CPP_URL = "http://127.0.0.1:8081";

const HEALTH_TIMEOUT_MS = 1_500;

export function getWhisperCppConfig(): { url: string; model: string | null } {
  const url = (process.env.STT_SIDECAR_URL ?? DEFAULT_WHISPER_CPP_URL).trim().replace(/\/+$/, "");
  const model = (process.env.STT_SIDECAR_MODEL ?? "").trim();
  return { url: url.length > 0 ? url : DEFAULT_WHISPER_CPP_URL, model: model.length > 0 ? model : null };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class WhisperCppProvider implements SpeechToTextProvider {
  readonly id = WHISPER_CPP_PROVIDER_ID;
  readonly label = "Local whisper.cpp sidecar (HTTP)";

  async readiness(): Promise<SttReadiness> {
    const { url } = getWhisperCppConfig();
    try {
      const response = await fetchWithTimeout(`${url}/health`, { method: "GET" }, HEALTH_TIMEOUT_MS);
      if (!response.ok) {
        return { ready: false, detail: `whisper.cpp sidecar answered HTTP ${response.status}.` };
      }
      const payload = (await response.json()) as { status?: unknown; model?: unknown };
      if (payload.status !== "ok") {
        return { ready: false, detail: "whisper.cpp sidecar reported it is not ready." };
      }
      const model = typeof payload.model === "string" ? payload.model : "unknown model";
      return { ready: true, detail: `Local whisper.cpp sidecar ready (${model}).` };
    } catch {
      return { ready: false, detail: `No local whisper.cpp sidecar listening at ${url}.` };
    }
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const { url } = getWhisperCppConfig();
    const startedAt = Date.now();

    // Float samples are converted back to the 16-bit PCM the sidecar expects.
    const pcm = new Int16Array(request.audio.samples.length);
    for (let i = 0; i < request.audio.samples.length; i += 1) {
      pcm[i] = Math.max(-1, Math.min(1, request.audio.samples[i])) * 32767;
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(
        `${url}/transcribe`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "x-audio-rate": String(request.audio.sampleRate),
            "x-audio-language": request.language ?? "english",
          },
          body: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength),
        },
        60_000
      );
    } catch (error) {
      throw new SttError(
        "unavailable",
        `Local whisper.cpp sidecar is unreachable at ${url}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (!response.ok) {
      throw new SttError("failed", `Local whisper.cpp sidecar answered HTTP ${response.status}.`);
    }

    const payload = (await response.json()) as { text?: unknown };
    const text = typeof payload.text === "string" ? payload.text.replace(/\s+/g, " ").trim() : "";
    if (!text) {
      throw new SttError("empty-transcript", "The local whisper.cpp sidecar returned no text.");
    }

    return {
      text,
      provider: this.id,
      model: getWhisperCppConfig().model ?? "whisper.cpp",
      durationMs: Date.now() - startedAt,
      audioSeconds: request.audio.samples.length / request.audio.sampleRate,
    };
  }
}
