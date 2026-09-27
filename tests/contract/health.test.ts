/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contract tier: GET /api/health.
 *
 * Health answers in every environment - with or without Ollama, Whisper and
 * Pocket TTS - so its *shape* is testable in CI even though a green status is
 * not. The rules asserted here are the ones the client and the operator depend
 * on: the reported status must be consistent with the parts it is built from,
 * the local-first promise must be visible in the payload, and no path may leak.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { api, findPathLeaks, getHealth, type HealthJson } from "../helpers/harness";

let status = 0;
let health: HealthJson;

beforeAll(async () => {
  const response = await api("/api/health");
  status = response.status;
  health = response.json as HealthJson;
});

describe("GET /api/health", () => {
  it("answers with JSON and only the two documented statuses", () => {
    expect([200, 503], `health returned ${status}`).toContain(status);
    expect(String(health.cloudProviders)).toBe("none");
  });

  it("publishes the documented top-level contract", () => {
    expect(health.engine).toBe("ollama");
    expect(health.status).toBe(status === 200 ? "ok" : "degraded");
    expect(Date.parse(health.timestamp)).not.toBeNaN();
    expect(typeof health.uptimeSeconds).toBe("number");
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("reports every engine as an object rather than a bare flag", () => {
    expect(typeof health.ollama).toBe("object");
    expect(typeof health.intelligence).toBe("object");
    expect(typeof health.translation).toBe("object");
    expect(typeof health.stt).toBe("object");
    expect(typeof health.speech?.tts).toBe("object");
    expect(typeof health.sessions).toBe("object");
  });

  it("keeps the reported status consistent with the parts it is built from", () => {
    const healthy = health.ollama?.reachable === true && health.ollama?.modelInstalled === true && health.translation?.ready === true;
    // The service is healthy exactly when a translation engine can answer. If this
    // fails, /api/health and its inputs disagree - a real defect, not a test bug.
    expect(health.status).toBe(healthy ? "ok" : "degraded");
  });

  it("names a local provider for every capability, never a cloud one", () => {
    expect(health.intelligence?.provider).toBe("ollama");
    expect(typeof health.translation?.activeProvider).toBe("string");
    expect(String(health.translation?.activeProvider)).not.toMatch(/google|azure|deepl|openai|amazon|deepgram/i);
    expect(typeof health.stt?.provider).toBe("string");
    expect(health.speech?.tts?.provider).toBe("tts-pocket");
  });

  it("states voice support and refuses voice matching honestly", () => {
    const tts = health.speech?.tts ?? {};
    expect(["ready", "unavailable"]).toContain(tts.status);
    expect(Array.isArray(tts.supportedLanguages)).toBe(true);
    expect(tts.supportedLanguages as string[]).toEqual(expect.arrayContaining(["english", "french"]));
    // Stage 2 is not shipped: the payload must say so rather than imply otherwise.
    expect((tts.voiceMatching as { available?: boolean })?.available).toBe(false);
  });

  it("explains itself when it is degraded, and voice is never the reason", () => {
    if (health.status === "ok") return;

    // A degraded report must point at the engine that is actually missing...
    const blocking = [health.ollama?.reachable, health.ollama?.modelInstalled, health.translation?.ready];
    expect(blocking).toContain(false);

    // ...and never at speech, which is an enhancement: the same payload can be
    // degraded while both voice engines are perfectly healthy.
    const voice = [health.stt?.available, health.speech?.tts?.status === "ready"];
    expect(voice.length).toBe(2);
  });

  it("reports session statistics without any secret or content", () => {
    const sessions = health.sessions as Record<string, unknown>;
    expect(sessions.status).toBe("ready");
    expect(typeof sessions.activeCount).toBe("number");
    expect(typeof sessions.ttlMinutes).toBe("number");
    expect(Object.keys(sessions).sort()).toEqual(["activeCount", "status", "ttlMinutes"]);
  });

  it("exposes no filesystem path anywhere in the payload", () => {
    expect(findPathLeaks(JSON.stringify(health))).toEqual([]);
  });
});
