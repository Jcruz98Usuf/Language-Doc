/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Local microphone capture for the HOST laptop (Phase 7A) and, since Phase 7C,
 * for the phone that joined the session over the LAN. One recorder, one endpoint,
 * one engine - so a browser and a laptop take the identical path to Whisper.
 *
 * Records raw PCM with the Web Audio API and returns 16 kHz mono samples ready
 * for POST /api/transcribe. It deliberately does NOT use the browser's own speech
 * recogniser: on Chrome that uploads audio to a remote service, which is exactly
 * the privacy gap this closes.
 *
 * That paragraph is worded on purpose. This `@license` header is the one comment
 * the build keeps verbatim in `dist/`, and the shipped bundle is scanned for the
 * recogniser's own identifier - so naming it here would put the very string the
 * scan forbids into the artefact the scan protects. Say it in prose instead.
 *
 * The resampling/PCM helpers are intentionally duplicated (not imported) from
 * the server's stt/audio.ts: that module is Node-only (Buffer) and must never be
 * pulled into the browser bundle.
 */

export const TARGET_SAMPLE_RATE = 16_000;

/** Hard cap: a runaway recording is truncated rather than rejected. */
const MAX_SECONDS = 60;
const MIN_SECONDS = 0.35;

/**
 * How long `resume()` is given before capture carries on without it.
 *
 * Bounded on purpose. WebKit can leave that promise pending for a context it does
 * not consider gesture-started, and an unbounded wait on it is a microphone button
 * stuck on "waiting for the microphone" for a microphone the user has already
 * granted.
 */
const RESUME_GRACE_MS = 600;

export interface RecordedClip {
  /** Mono, little-endian, 16-bit signed PCM at 16 kHz. */
  pcm16: Int16Array;
  sampleRate: number;
  seconds: number;
}

function audioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) ?? null;
}

export function isLocalCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    audioContextCtor() !== null
  );
}

/**
 * Human-readable reason voice input cannot run on this device, or null when it
 * can. Used for the honest banner instead of a silent failure.
 */
export function captureFailureReason(): string | null {
  if (!isLocalCaptureSupported()) {
    return "This browser cannot capture microphone audio. Please type the message - it is translated the same way.";
  }
  if (!window.isSecureContext) {
    return "Voice input needs a secure connection (HTTPS or localhost). Please type the message - it is translated the same way.";
  }
  return null;
}

/**
 * What this device reports about its own ability to capture, for the one question a
 * terminal and a server log cannot answer: why is the microphone button grey on the
 * phone? The phone is the only machine that knows, so the answer has to be readable
 * there - the participant view prints this on screen.
 *
 * Every field is something the browser states about itself. The permission state is
 * deliberately NOT part of the verdict: `captureFailureReason()` above never
 * consults it, because `permissions.query({ name: "microphone" })` throws on iOS
 * Safari and, on browsers that do implement it, can still answer "prompt" while the
 * microphone is already granted. Readiness is therefore decided from capability
 * alone, and attempting to record is what asks for - and settles - permission.
 */
export interface CaptureDiagnostics {
  secureContext: boolean;
  mediaDevices: boolean;
  getUserMedia: boolean;
  audioContext: boolean;
  /** The first condition actually blocking capture, or null when nothing is. */
  blockedBy: string | null;
}

export function captureDiagnostics(): CaptureDiagnostics {
  return {
    secureContext: typeof window !== "undefined" && window.isSecureContext === true,
    mediaDevices: typeof navigator !== "undefined" && typeof navigator.mediaDevices === "object" && navigator.mediaDevices !== null,
    getUserMedia: typeof navigator?.mediaDevices?.getUserMedia === "function",
    audioContext: audioContextCtor() !== null,
    blockedBy: captureFailureReason(),
  };
}

/**
 * The browser's own permission state, as a string, for the diagnostic readout only.
 *
 * Advisory by construction and by intent: it is never an input to any decision in
 * this app. "unsupported" is the honest answer on the browsers that cannot be asked
 * at all (Safari rejects this query name), and an answer that cannot be trusted is
 * not an answer a button may wait for.
 */
export async function queryMicrophonePermission(): Promise<string> {
  try {
    if (typeof navigator === "undefined" || !navigator.permissions?.query) return "unsupported";
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status?.state ?? "unknown";
  } catch {
    return "unsupported";
  }
}

/**
 * Turns a capture failure into the sentence a person on a phone can act on.
 *
 * The recorder's own messages ("too short", "no audio captured") pass through
 * unchanged. The names below are what a refusal actually arrives as, and each one
 * names the fallback that still works - typing, which is translated identically. A
 * greyed-out button with a technical string under it is not an explanation.
 */
export function describeCaptureFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access is blocked for this page. Allow it for this site in the browser settings, then tap the microphone again - or type the message, which is translated the same way.";
    case "NotFoundError":
      return "No microphone was found on this device. Please type the message - it is translated the same way.";
    case "NotReadableError":
      return "Another app is using the microphone. Close it and tap the microphone again - or type the message, which is translated the same way.";
    case "OverconstrainedError":
      return "This device's microphone cannot be opened with the requested settings. Please type the message - it is translated the same way.";
    case "AbortError":
      return "The microphone stopped before it started. Tap the microphone again - or type the message, which is translated the same way.";
    case "TimeoutError":
      return "The microphone did not answer in time. Tap the microphone again - or type the message, which is translated the same way.";
    default:
      return error instanceof Error && error.message
        ? error.message
        : "Microphone unavailable. Please type the message - it is translated the same way.";
  }
}

function resampleLinear(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const ratio = from / to;
  const length = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const next = Math.min(index + 1, input.length - 1);
    const fraction = position - index;
    out[i] = input[index] * (1 - fraction) + input[next] * fraction;
  }
  return out;
}

function floatToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out[i] = Math.round(clamped * 32767);
  }
  return out;
}
/**
 * Push-to-talk recorder. Buffers raw PCM in memory while recording; nothing is
 * written to disk and nothing is transmitted until stop() hands the clip to the
 * caller, which posts it to the local STT endpoint.
 */
export class LocalAudioRecorder {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private chunks: Float32Array[] = [];
  private frames = 0;
  private active = false;
  /** Set by `cancel()`, including while `start()` is still waiting for permission. */
  private cancelled = false;

  get isRecording(): boolean {
    return this.active;
  }

  async start(): Promise<void> {
    const reason = captureFailureReason();
    if (reason) throw new Error(reason);
    if (this.active) return;
    this.cancelled = false;

    const AudioCtor = audioContextCtor();
    if (!AudioCtor) throw new Error("Web Audio capture is not available in this browser.");

    // Everything above the first `await` below runs inside the tap that called this,
    // and that is not cosmetic. Two things need that gesture and lose it afterwards:
    //   - `getUserMedia` is what raises the permission prompt, and a mobile browser
    //     only raises it for a live gesture;
    //   - WebKit returns an AudioContext that is born `suspended` when it is created
    //     outside a gesture, and a context created after the prompt is exactly that.
    //     A context that never leaves `suspended` produces no samples at all.
    // A phone with the microphone already granted therefore sat on "waiting for the
    // microphone" with nothing ever settling it. The context is created first and the
    // request is started without awaiting it, which keeps both inside the gesture.
    let context: AudioContext;
    try {
      // Ask the browser for 16 kHz so it resamples for us. Not every browser
      // honours the request, so the real rate is read back on stop() and the
      // samples are resampled only when they differ.
      context = new AudioCtor({ sampleRate: TARGET_SAMPLE_RATE });
    } catch {
      context = new AudioCtor();
    }
    // Started, never awaited bare: on WebKit this promise can stay pending for a
    // context it does not consider user-started, and awaiting it here is what left
    // `start()` unresolved - which is what froze the microphone button.
    if (context.state === "suspended") void context.resume().catch(() => undefined);

    const streamRequest = navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    let stream: MediaStream;
    try {
      stream = await streamRequest;
    } catch (permissionError) {
      // Refused, or nothing to grant to: the context opened above has no reason to
      // stay open, and the caller turns this into a sentence naming the fallback.
      void context.close();
      throw permissionError;
    }

    // Cancelled while the prompt was open - the page was left, or the user tapped
    // again. The grant that has just arrived must not leave a live microphone behind.
    if (this.cancelled) {
      this.cancelled = false;
      stream.getTracks().forEach((track) => track.stop());
      void context.close();
      return;
    }

    // Normally running by now. If it is not, give the resume one bounded chance and
    // carry on either way: the graph below works on a suspended context, it simply
    // produces no frames - which `stop()` reports honestly rather than leaving this
    // promise, and the button, unresolved.
    if (context.state === "suspended") {
      await Promise.race([
        context.resume().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, RESUME_GRACE_MS)),
      ]);
    }

    const source = context.createMediaStreamSource(stream);
    // ScriptProcessorNode is deprecated in favour of AudioWorklet, but it needs
    // no separate worklet module and is still supported by every target browser.
    const processor = context.createScriptProcessor(4096, 1, 1);
    const sink = context.createGain();
    sink.gain.value = 0; // keeps the graph alive without playing the mic back

    this.chunks = [];
    this.frames = 0;
    this.active = true;
    const maxFrames = MAX_SECONDS * context.sampleRate;

    processor.onaudioprocess = (event) => {
      if (!this.active || this.frames >= maxFrames) return;
      const input = event.inputBuffer.getChannelData(0);
      this.chunks.push(Float32Array.from(input));
      this.frames += input.length;
    };

    source.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);

    this.stream = stream;
    this.context = context;
    this.source = source;
    this.processor = processor;
    this.sink = sink;
  }

  /** Releases the microphone and returns the clip as 16 kHz mono PCM. */
  async stop(): Promise<RecordedClip> {
    const context = this.context;
    const sourceRate = context?.sampleRate ?? TARGET_SAMPLE_RATE;
    const frames = this.frames;
    const chunks = this.chunks;

    this.active = false;
    this.teardown();

    if (frames === 0) throw new Error("No audio was captured. Please try again.");

    const merged = new Float32Array(frames);
    let offset = 0;
    for (const chunk of chunks) {
      if (offset >= frames) break;
      const slice = chunk.subarray(0, Math.min(chunk.length, frames - offset));
      merged.set(slice, offset);
      offset += slice.length;
    }

    const seconds = merged.length / sourceRate;
    if (seconds < MIN_SECONDS) {
      throw new Error("That was too short to transcribe - hold the mic while you speak.");
    }

    const resampled = resampleLinear(merged, sourceRate, TARGET_SAMPLE_RATE);
    return {
      pcm16: floatToPcm16(resampled),
      sampleRate: TARGET_SAMPLE_RATE,
      seconds: resampled.length / TARGET_SAMPLE_RATE,
    };
  }

  /** Aborts a recording without producing a clip; the mic is released at once. */
  cancel(): void {
    // A `start()` may still be waiting for the microphone prompt. This flag is what
    // its continuation reads to hand back whatever the browser grants afterwards;
    // without it, cancelling before the prompt is answered left a live microphone.
    this.cancelled = true;
    this.active = false;
    this.chunks = [];
    this.frames = 0;
    this.teardown();
  }

  private teardown(): void {
    try {
      if (this.processor) {
        this.processor.onaudioprocess = null;
        this.processor.disconnect();
      }
    } catch {
      /* node already detached */
    }
    try {
      this.source?.disconnect();
    } catch {
      /* node already detached */
    }
    try {
      this.sink?.disconnect();
    } catch {
      /* node already detached */
    }
    try {
      this.stream?.getTracks().forEach((track) => track.stop());
    } catch {
      /* stream already closed */
    }
    try {
      void this.context?.close();
    } catch {
      /* context already closed */
    }

    this.processor = null;
    this.source = null;
    this.sink = null;
    this.stream = null;
    this.context = null;
  }
}

