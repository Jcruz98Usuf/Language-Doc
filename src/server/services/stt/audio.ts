/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Audio decoding for POST /api/transcribe.
 *
 * Everything here works on an in-memory Buffer: the request body is decoded,
 * resampled and handed to the STT engine, then dropped. No audio is written to
 * disk and nothing is kept after the transcript is produced.
 *
 * Accepted payloads:
 *   - application/octet-stream : raw PCM, mono, little-endian (16-bit signed)
 *   - audio/wav                : RIFF/WAVE (PCM or IEEE float, any channel count)
 *
 * Both paths normalise to 16 kHz mono float samples, which is what Whisper (and
 * whisper.cpp) expect.
 */

import { SttError } from "./types";
import type { PcmAudio } from "./types";

/** Whisper's native input rate. */
export const TARGET_SAMPLE_RATE = 16_000;

const MIN_AUDIO_SECONDS = 0.35;
const MAX_AUDIO_SECONDS = 60;

export function pcm16ToFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = samples[i] / 32768;
  return out;
}

/** Linear-interpolation resampler - dependency free and adequate for speech. */
export function resampleLinear(input: Float32Array, from: number, to: number): Float32Array {
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

/** Averages interleaved channels down to mono. */
function toMono(samples: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return samples;
  const frames = Math.floor(samples.length / channels);
  const out = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) sum += samples[frame * channels + channel];
    out[frame] = sum / channels;
  }
  return out;
}

interface WavData {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
}


/** Minimal RIFF/WAVE reader: PCM (1) and IEEE float (3), 8/16/32-bit. */
export function decodeWav(buffer: Buffer): WavData {
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new SttError("bad-audio", "Audio payload is not a RIFF/WAVE file.");
  }

  let offset = 12;
  let format = 1;
  let channels = 1;
  let sampleRate = TARGET_SAMPLE_RATE;
  let bitsPerSample = 16;
  let data: Buffer | null = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = buffer.readUInt16LE(body);
      channels = Math.max(1, buffer.readUInt16LE(body + 2));
      sampleRate = buffer.readUInt32LE(body + 4) || TARGET_SAMPLE_RATE;
      bitsPerSample = buffer.readUInt16LE(body + 14) || 16;
    } else if (id === "data") {
      data = buffer.subarray(body, Math.min(body + size, buffer.length));
    }
    offset = body + size + (size % 2);
  }

  if (!data) throw new SttError("bad-audio", "WAVE file has no data chunk.");

  const isFloat = format === 3;
  const bytesPerSample = isFloat ? 4 : Math.max(1, bitsPerSample / 8);
  const samples = new Float32Array(Math.floor(data.length / bytesPerSample));

  if (isFloat) {
    for (let i = 0; i < samples.length; i += 1) samples[i] = data.readFloatLE(i * 4);
  } else if (bitsPerSample === 16) {
    for (let i = 0; i < samples.length; i += 1) samples[i] = data.readInt16LE(i * 2) / 32768;
  } else if (bitsPerSample === 32) {
    for (let i = 0; i < samples.length; i += 1) samples[i] = data.readInt32LE(i * 4) / 2147483648;
  } else {
    // 8-bit WAVE is unsigned.
    for (let i = 0; i < samples.length; i += 1) samples[i] = (data[i] - 128) / 128;
  }

  return { samples, sampleRate, channels };
}

/** True when the payload looks like raw RIFF rather than header-less PCM. */
export function looksLikeWav(buffer: Buffer): boolean {
  return buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF";
}

export interface DecodeOptions {
  /** Sample rate claimed by the client for a raw PCM body. */
  declaredRate?: number;
}

/**
 * Normalises any accepted payload to 16 kHz mono float samples and enforces the
 * minimum/maximum duration so a silent tap or a runaway recording produces a
 * clear error instead of a bogus transcript.
 */
export function decodeAudioPayload(body: Buffer | undefined, options: DecodeOptions = {}): PcmAudio {
  if (!body || body.length === 0) {
    throw new SttError("bad-audio", "No audio was submitted.");
  }

  let samples: Float32Array;
  let sourceRate: number;

  if (looksLikeWav(body)) {
    const wav = decodeWav(body);
    samples = toMono(wav.samples, wav.channels);
    sourceRate = wav.sampleRate;
  } else {
    // Raw PCM: mono, little-endian, 16-bit signed (the browser contract).
    const even = body.length - (body.length % 2);
    samples = pcm16ToFloat(new Int16Array(body.buffer.slice(body.byteOffset, body.byteOffset + even)));
    sourceRate = options.declaredRate ?? TARGET_SAMPLE_RATE;
  }

  if (sourceRate < 8_000 || sourceRate > 192_000) {
    throw new SttError("bad-audio", `Unsupported sample rate ${sourceRate} Hz.`);
  }

  const seconds = samples.length / sourceRate;
  if (seconds < MIN_AUDIO_SECONDS) {
    throw new SttError("too-short", "That recording was too short to transcribe. Hold the mic a little longer.");
  }
  if (seconds > MAX_AUDIO_SECONDS) {
    throw new SttError("too-long", `Recordings are limited to ${MAX_AUDIO_SECONDS} seconds.`);
  }

  return {
    samples: resampleLinear(samples, sourceRate, TARGET_SAMPLE_RATE),
    sampleRate: TARGET_SAMPLE_RATE,
  };
}
