/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Model tier: local speech, end to end.
 *
 * Phase 7B's contract is that the two required combinations - English and French in
 * `standard` mode - come back as playable audio, and that nothing had to be learned
 * about the engine to get them: no download, no browser speech synthesis, no cloud.
 * Phase 7A's is that a recording posted to `/api/transcribe` comes back as the words
 * that were spoken.
 *
 * Putting them in one file lets the two halves check each other: text spoken by the
 * local TTS engine and transcribed by the local Whisper engine has to come back the
 * same way. That is the closest this project gets to an end-to-end speech test
 * without a human in front of a microphone, and it is the test that catches a sample
 * rate, a channel count or a resampling step quietly changing on either side.
 *
 * Requires the engines; skipped with a reason when they are not installed.
 */

import { describe, expect, it } from "vitest";
import { api, findPathLeaks, logIsQuiet, probeEngines, suiteRequiring } from "../helpers/harness";

const engines = await probeEngines();
const speechSuite = suiteRequiring("local speech synthesis (Pocket TTS)", engines.tts, engines.note);

/** Sentences the Phase 7A STT benchmark already uses as reference transcripts. */
const SPOKEN = {
  english: "Good morning, my name is Amina and I have had a fever and a dry cough for three days.",
  french: "Bonjour, je voudrais une chambre pour deux nuits, sil vous plait.",
} as const;

interface Wav {
  sampleRate: number;
  channels: number;
  dataBytes: number;
}

/** Reads the fields that matter from the canonical 44-byte header. */
function readWav(buffer: Buffer): Wav {
  expect(buffer.subarray(0, 4).toString("ascii"), "the response is not a RIFF file").toBe("RIFF");
  expect(buffer.subarray(8, 12).toString("ascii"), "the RIFF file is not a WAVE file").toBe("WAVE");

  return {
    sampleRate: buffer.readUInt32LE(24),
    channels: buffer.readUInt16LE(22),
    dataBytes: buffer.length - 44,
  };
}

function synthesize(text: string, language: string) {
  return api("/api/speech/synthesize", {
    method: "POST",
    body: { text, language, voiceMode: "standard" },
    timeoutMs: 180_000,
  });
}

speechSuite("POST /api/speech/synthesize produces playable audio", () => {
  it("speaks English in standard mode", async () => {
    const response = await synthesize(SPOKEN.english, "english");

    expect(response.status, response.text.slice(0, 300)).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/audio\/wav/);

    const wav = readWav(response.bytes);
    expect(wav.channels).toBe(1);
    expect(wav.sampleRate).toBeGreaterThanOrEqual(8_000);
    expect(wav.dataBytes, "the file carries no audio").toBeGreaterThan(0);

    const durationMs = Number(response.headers.get("x-speech-duration-ms"));
    expect(durationMs, "the route must state how long the audio is").toBeGreaterThan(500);
    expect(durationMs).toBeLessThanOrEqual(30_000);
    expect(response.headers.get("x-speech-provider")).toBeTruthy();
    expect(response.headers.get("x-speech-voice")).toBeTruthy();
  });

  it("speaks French in standard mode", async () => {
    const response = await synthesize(SPOKEN.french, "french");

    expect(response.status, response.text.slice(0, 300)).toBe(200);
    const wav = readWav(response.bytes);
    expect(wav.dataBytes).toBeGreaterThan(0);
    expect(Number(response.headers.get("x-speech-duration-ms"))).toBeGreaterThan(300);
  });

  it("answers a repeated request from cache with byte-identical audio", async () => {
    const text = "The meeting is moved to Thursday at ten in the morning.";

    const first = await synthesize(text, "english");
    const second = await synthesize(text, "english");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("x-speech-cached"), "the first synthesis must not claim to be cached").not.toBe("1");
    expect(second.headers.get("x-speech-cached"), "the repeat request should have been a cache hit").toBe("1");
    expect(second.bytes.equals(first.bytes), "cached audio differs from the original").toBe(true);

    // `x-speech-synthesis-ms` is a diagnostic of the engine, not of the request: on
    // a hit the provider replays the stored result (`{ ...entry.value, cached: true }`),
    // so both responses carry the same number by design. What proves the cache is the
    // header and the identical bytes above - a wall-clock comparison here would fail on
    // the tie that correct behaviour produces, so the pair is printed instead of gated.
    const firstMs = Number(first.headers.get("x-speech-synthesis-ms"));
    const cachedMs = Number(second.headers.get("x-speech-synthesis-ms"));
    expect(firstMs, "the route must report how long the engine took").toBeGreaterThan(0);
    expect(cachedMs, "a hit must carry the same diagnostic as the original").toBe(firstMs);
    console.log(`[speech cache] synthesized ${firstMs}ms, replayed from cache with the same ${cachedMs}ms figure`);
  });

  it("keeps the engine's own probe noise out of the server log", () => {
    // Pocket TTS prints an ffmpeg-style `Input #0 ...` description of every voice
    // file it opens. The worker filters it where it is generated; this asserts the
    // filter is still in place after a real run of syntheses.
    const { quiet, offenders } = logIsQuiet("Input #0", "Stream #", "Error opening");
    expect(quiet, `engine chatter reached the log: ${offenders.join(", ")}`).toBe(true);
  });
});

const roundTrip = engines.tts && engines.stt;
if (!roundTrip) console.log(`[skip] text -> speech -> text round trip - ${engines.note}`);
const roundTripSuite = roundTrip ? describe : (describe.skip as typeof describe);

/** Content-word overlap: how many of the spoken words came back. */
function wordOverlap(reference: string, actual: string): number {
  const words = (value: string) =>
    new Set(
      value
        .toLowerCase()
        .replace(/[^a-zàâçéèêëîïôûùüÿñæœ' ]+/g, " ")
        .split(/\s+/)
        .filter((word) => word.length > 2)
    );

  const expected = words(reference);
  const heard = words(actual);
  if (expected.size === 0) return 0;

  let matched = 0;
  for (const word of expected) if (heard.has(word)) matched += 1;
  return matched / expected.size;
}

roundTripSuite("text -> speech -> text through both local engines", () => {
  it("returns the English sentence it was given, mostly word for word", async () => {
    const spoken = await synthesize(SPOKEN.english, "english");
    expect(spoken.status).toBe(200);

    // Post the WAV straight back: the transcribe route accepts a RIFF file as
    // readily as the raw PCM a browser sends, so nothing has to be reshaped here.
    const heard = await api("/api/transcribe", {
      method: "POST",
      headers: { "content-type": "audio/wav", "x-audio-language": "english" },
      body: spoken.bytes,
      timeoutMs: 300_000,
    });

    expect(heard.status, heard.text.slice(0, 300)).toBe(200);
    const text = String((heard.json as { text?: string }).text ?? "").trim();
    expect(text.length, "the transcription came back empty").toBeGreaterThan(0);

    const overlap = wordOverlap(SPOKEN.english, text);
    console.log(`[speech round trip] overlap ${(overlap * 100).toFixed(0)}% -> ${text}`);

    // 0.8 is a number the Phase 7A report clears comfortably; below it something in
    // the audio path changed size, rate or channel order.
    expect(overlap).toBeGreaterThanOrEqual(0.8);
    expect(heard.headers.get("x-transcription-provider")).toBeTruthy();
    expect(findPathLeaks(heard.text)).toEqual([]);
  });
});

