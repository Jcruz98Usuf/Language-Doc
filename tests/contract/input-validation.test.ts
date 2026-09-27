/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contract tier: what the API refuses, and how it says so.
 *
 * The value of this file in CI: every case below is answered by validation code
 * that runs *before* an engine is touched, so the rules hold - and are enforced -
 * on a machine with no Ollama, no Whisper and no Pocket TTS. That is exactly the
 * set of guarantees the Phase 7A and 7B security checks proved by hand:
 *
 *   - a request with nothing in it is refused as a bad request, not as a crash
 *   - the language and voice-mode allow-lists cannot be widened by a client
 *   - an over-long request is refused rather than queued onto the CPU
 *   - a value that looks like a shell command is treated as data
 *   - a refusal never leaks a filesystem path, a stack trace, or the request text
 *
 * What needs a real engine lives in tests/models instead, and says so. One case here
 * is the deliberate exception - it asserts how the API answers *after* an engine has
 * taken the audio - and it skips with a printed reason wherever the weights are not
 * already on disk, rather than spending its time on a first-use download.
 */

import { describe, expect, it } from "vitest";
import { api, findPathLeaks, itRequiring, probeEngines, serverLog } from "../helpers/harness";

/** Distinctive marker: if it ever shows up in a response or a log, it leaked. */
const CANARY = "PHASE8-CANARY-4c1f9a";

const engines = await probeEngines();

/**
 * One case in this file is not answered by validation: it asks what the API returns
 * once an engine has accepted the audio and then failed to decode it. That needs a
 * Whisper engine with its weights already on disk, so it is skipped - out loud - when
 * they are not.
 */
const itWithStt = itRequiring(
  "POST /api/transcribe - answer after an engine accepts audio and cannot decode it",
  engines.stt,
  `no cached Whisper weights to fail with (${engines.note}); a cold engine spends the request downloading them`
);

/** Bodies that must always be answered with a 400 and a machine-readable code. */
async function expectRefusal(path: string, init: Parameters<typeof api>[1], code: string): Promise<void> {
  const response = await api(path, init);

  expect([400, 413], `${path} -> ${response.status}: ${response.text.slice(0, 160)}`).toContain(response.status);
  if (response.status === 413) return; // body-size cap fired first - also a refusal

  const body = response.json as { error?: string; code?: string } | null;
  expect(body, `${path} refused with a non-JSON body: ${response.text.slice(0, 160)}`).not.toBeNull();
  expect(body?.code, `expected code ${code}, got ${JSON.stringify(body)}`).toBe(code);
  expect(typeof body?.error).toBe("string");
  expect(response.text).not.toContain(CANARY);
  expect(findPathLeaks(response.text)).toEqual([]);
}

describe("POST /api/translate - input contract", () => {
  it("requires text", async () => {
    for (const body of [{}, { text: "" }, { text: "   " }, { text: null }, { text: 42 }] as const) {
      const response = await api("/api/translate", { method: "POST", body: body as Record<string, unknown> });
      expect(response.status, `body ${JSON.stringify(body)}`).toBe(400);
      expect((response.json as { error: string }).error).toMatch(/text/i);
    }
  });

  it("answers a malformed body with a JSON error and no internals", async () => {
    const response = await api("/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"text": "${CANARY}", `,
    });

    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: "Malformed JSON request body." });
    expect(response.text).not.toContain(CANARY);
  });

  it("fails as a service error - never a crash - when no engine can answer", async () => {
    // With Ollama and the local MT models absent this is the only answer a
    // translation can give, and it must still be a structured, honest one.
    const response = await api("/api/translate", {
      method: "POST",
      body: { text: "The patient feels well today", from: "English", to: "French" },
    });

    // 200 means an engine did answer, which is equally fine - the quality of an
    // answer is asserted in tests/models. What is never acceptable is a 5xx HTML
    // page, a body carrying paths, or a 200 with nothing in it.
    expect(response.status).toBeLessThan(600);
    expect(response.headers.get("content-type")).toMatch(/json/);
    expect(findPathLeaks(response.text)).toEqual([]);

    if (response.status === 200) {
      expect((response.json as { translatedText: string }).translatedText.trim().length).toBeGreaterThan(0);
      // The diagnostic headers are additive: they must never contradict the body.
      expect(response.headers.get("x-translation-validated")).toMatch(/^(true|false)$/);
    } else {
      expect([502, 503, 504]).toContain(response.status);
      expect((response.json as { error: string }).error.length).toBeGreaterThan(0);
    }
  });
});

describe("POST /api/parse-dialogue - input contract", () => {
  it("answers a malformed body with a JSON error and no internals", async () => {
    const response = await api("/api/parse-dialogue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: `{"conversation": ["${CANARY}"]`,
    });

    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: "Malformed JSON request body." });
    expect(response.text).not.toContain(CANARY);
  });

  it("fails cleanly when the chat model is not reachable", async () => {
    const response = await api("/api/parse-dialogue", {
      method: "POST",
      body: { conversation: [`${CANARY} doctor, my name is Amina`], domain: "clinic" },
    });

    // A missing model is a 503 with a code, not a 500 with a stack.
    expect([200, 502, 503]).toContain(response.status);
    expect(response.headers.get("content-type")).toMatch(/json/);
    if (response.status !== 200) {
      expect((response.json as { error: string }).error.length).toBeGreaterThan(0);
    }
    expect(findPathLeaks(response.text)).toEqual([]);
    expect(response.text).not.toContain(CANARY);
  });
});

describe("POST /api/transcribe - input contract (Phase 7A)", () => {
  it("refuses an unsupported language before touching an engine", async () => {
    // The STT allow-list is English, French and Swahili (WHISPER_LANGUAGES), so
    // "unsupported" has to mean genuinely outside it. Swahili is supported here -
    // unlike TTS, which only has voices for two languages - and the first run of
    // this file mistook that for a hole in the guard.
    const refused = ["klingon", "not-a-language", "english; rm -rf /", "../../../etc/passwd", "a".repeat(4000)];

    for (const language of refused) {
      const started = Date.now();
      const response = await api("/api/transcribe", {
        method: "POST",
        headers: { "content-type": "audio/wav", "x-audio-language": language },
        body: Buffer.alloc(0),
      });

      expect(response.status, `${language.slice(0, 24)} -> ${response.status}`).toBe(400);
      expect((response.json as { code: string }).code, `language: ${language.slice(0, 24)}`).toBe(
        "unsupported-language"
      );
      // No model load, no sidecar call: the guard answers on its own.
      expect(Date.now() - started, "the language check must not wait on an engine").toBeLessThan(5000);
      expect(findPathLeaks(response.text)).toEqual([]);
    }

    // A refusal is rendered by the client, so what it may contain is a decision of
    // its own: a real (typo-shaped) language name is named for the person reading
    // it, anything else is described instead of being handed back verbatim.
    const named = await api("/api/transcribe", {
      method: "POST",
      headers: { "content-type": "audio/wav", "x-audio-language": "klingon" },
      body: Buffer.alloc(0),
    });
    expect((named.json as { error: string }).error).toContain("klingon");

    const refusedShape = await api("/api/transcribe", {
      method: "POST",
      headers: { "content-type": "audio/wav", "x-audio-language": "../../../etc/passwd" },
      body: Buffer.alloc(0),
    });
    expect((refusedShape.json as { code: string }).code).toBe("unsupported-language");
    expect((refusedShape.json as { error: string }).error).not.toContain("/etc/");
    expect(findPathLeaks(refusedShape.text)).toEqual([]);
  });

  it("lets the languages it supports through the guard", async () => {
    // The other half of an allow-list. An empty body is deliberately sent: an
    // accepted language gets as far as the audio decoder and answers `bad-audio`,
    // which proves the guard let it through without needing a working engine.
    for (const language of ["english", "french", "swahili", "French", "  english  "]) {
      const response = await api("/api/transcribe", {
        method: "POST",
        headers: { "content-type": "audio/wav", "x-audio-language": language },
        body: Buffer.alloc(0),
      });

      expect(response.status).toBe(400);
      expect((response.json as { code: string }).code, `language: ${language}`).not.toBe("unsupported-language");
      expect((response.json as { code: string }).code, `language: ${language}`).toBe("bad-audio");
    }
  });

  it("refuses audio it cannot read as a bad request rather than a server error", async () => {
    // A content type the raw parser does not claim: the route receives a non-Buffer
    // body and must say "bad audio" instead of throwing a TypeError (which surfaced
    // as an opaque 500 in Phase 7A and hid the real cause).
    const mismatched = await api("/api/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ not: "audio" }),
    });
    expect(mismatched.status).toBe(400);
    expect((mismatched.json as { code: string }).code).toBe("bad-audio");

    // Correct content type, no bytes at all.
    const empty = await api("/api/transcribe", {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: Buffer.alloc(0),
    });
    expect(empty.status).toBe(400);
    expect((empty.json as { code: string }).code).toBe("bad-audio");
  });

  itWithStt("answers structured JSON for audio it accepts but cannot process", async () => {
    // Two seconds of nonsense PCM. Whether an engine is installed decides the
    // status; what must hold either way is that the answer is JSON, without paths.
    const noise = await api("/api/transcribe?rate=16000", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: Buffer.alloc(16_000 * 2 * 2, 0x7f),
      timeoutMs: 120_000,
    });

    expect(noise.status).toBeLessThan(600);
    expect(String(noise.headers.get("content-type"))).toMatch(/json/);
    expect(findPathLeaks(noise.text)).toEqual([]);
  });

  it("enforces the request body cap instead of buffering indefinitely", async () => {
    // The route declares `limit: "24mb"`. Exceeding it must be refused at the
    // transport layer, before any decoding or model work.
    const oversized = await api("/api/transcribe", {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: Buffer.alloc(25 * 1024 * 1024, 0x41),
      timeoutMs: 60_000,
    });

    expect([413, 400], `oversized upload -> ${oversized.status}`).toContain(oversized.status);
    expect(String(oversized.headers.get("content-type"))).toMatch(/json/);
  });
});

describe("POST /api/speech/synthesize - allow-lists (Phase 7B)", () => {
  it("refuses text there is nothing to speak, and text too long to speak", async () => {
    await expectRefusal("/api/speech/synthesize", { method: "POST", body: { text: "", language: "english" } }, "empty-text");
    await expectRefusal(
      "/api/speech/synthesize",
      { method: "POST", body: { text: "   \n\t ", language: "english" } },
      "empty-text"
    );
    await expectRefusal(
      "/api/speech/synthesize",
      { method: "POST", body: { text: `${CANARY}${"a".repeat(1194)}`, language: "english" } },
      "text-too-long"
    );

    // The cap is 500 characters: one over is refused, exactly at the cap is not.
    // At the cap the engine decides what happens (503 without Pocket TTS), which is
    // why only the refusal code is asserted here.
    const atCap = await api("/api/speech/synthesize", { method: "POST", body: { text: "a".repeat(500), language: "english" } });
    expect((atCap.json as { code?: string } | null)?.code).not.toBe("text-too-long");

    // A 300 kB request is a size attack, not a sentence.
    const huge = await api("/api/speech/synthesize", {
      method: "POST",
      body: { text: "b".repeat(300_000), language: "english" },
      timeoutMs: 60_000,
    });
    expect([400, 413]).toContain(huge.status);
  });

  it("refuses every language outside the two it has voices for", async () => {
    // The Phase 7B list, unchanged: injection-shaped, merely-unsupported and
    // path-shaped values are all refused identically, before any worker starts.
    for (const language of ["english; rm -rf /", "swahili", "../../../etc/passwd", "english --config /tmp/evil.yaml"]) {
      await expectRefusal(
        "/api/speech/synthesize",
        { method: "POST", body: { text: `${CANARY} hello`, language } },
        "unsupported-language"
      );
    }
  });

  it("refuses a voice mode it does not implement, and one that is not a mode", async () => {
    await expectRefusal(
      "/api/speech/synthesize",
      { method: "POST", body: { text: `${CANARY} hello`, language: "english", voiceMode: "standard; whoami" } },
      "unsupported-voice-mode"
    );
    await expectRefusal(
      "/api/speech/synthesize",
      { method: "POST", body: { text: `${CANARY} hello`, language: "english", voiceMode: "../../../voices" } },
      "unsupported-voice-mode"
    );

    // Voice matching is Stage 2 and not shipped: it must be refused with its own
    // code and a 503 rather than quietly answered with the wrong voice.
    const clone = await api("/api/speech/synthesize", {
      method: "POST",
      body: { text: `${CANARY} hello`, language: "english", voiceMode: "clone" },
    });
    expect(clone.status).toBe(503);
    expect((clone.json as { code: string }).code).toBe("voice-matching-unavailable");
    expect(clone.text).not.toContain(CANARY);
  });

  it("never writes the spoken text into a server log line", async () => {
    // The route logs `[tts] <code>: <message>` only - never the request text. This
    // asserts that on the log this very run produced. The parent process appends the
    // child's output asynchronously, so give the pipe a moment to drain.
    let ttsLines: string[] = [];
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      ttsLines = serverLog()
        .split(/\r?\n/)
        .filter((line) => line.includes("[tts]"));
      if (ttsLines.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    expect(ttsLines.length, "the abuse cases above should have left a [tts] log line").toBeGreaterThan(0);
    for (const line of ttsLines) {
      expect(line).not.toContain(CANARY);
      expect(findPathLeaks(line)).toEqual([]);
    }
  });
});
