/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Local microphone capture for the HOST laptop (Phase 7A).
 *
 * Records raw PCM with the Web Audio API and returns 16 kHz mono samples ready
 * for POST /api/transcribe. It deliberately does NOT use the browser's
 * SpeechRecognition API: on Chrome that uploads audio to a remote service, which
 * is exactly the privacy gap this phase closes.
 *
 * The resampling/PCM helpers are intentionally duplicated (not imported) from
 * the server's stt/audio.ts: that module is Node-only (Buffer) and must never be
 * pulled into the browser bundle.
 */

export const TARGET_SAMPLE_RATE = 16_000;

/** Hard cap: a runaway recording is truncated rather than rejected. */
const MAX_SECONDS = 60;
const MIN_SECONDS = 0.35;

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

  get isRecording(): boolean {
    return this.active;
  }

  async start(): Promise<void> {
    const reason = captureFailureReason();
    if (reason) throw new Error(reason);
    if (this.active) return;

    const AudioCtor = audioContextCtor();
    if (!AudioCtor) throw new Error("Web Audio capture is not available in this browser.");

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // Ask the browser for 16 kHz so it resamples for us. Not every browser
    // honours the request, so the real rate is read back on stop() and the
    // samples are resampled only when they differ.
    let context: AudioContext;
    try {
      context = new AudioCtor({ sampleRate: TARGET_SAMPLE_RATE });
    } catch {
      context = new AudioCtor();
    }
    if (context.state === "suspended") await context.resume();

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

