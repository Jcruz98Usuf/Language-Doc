/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contract tier: temporary sessions (Phase 3) over real HTTP.
 *
 * These are the properties the session model is built on and that nothing else
 * tests: the token is returned exactly once, an id alone grants nothing, a token
 * from another session grants nothing, and ending a session is final. Every case
 * here is a real request to a running server - memory store and all.
 */

import { describe, expect, it } from "vitest";
import { api, bearer, withToken, type HealthJson } from "../helpers/harness";

interface CreatedSession {
  sessionId: string;
  token: string;
  expiresAt: number;
  joinUrl: string | null;
  joinUrls: string[];
}

async function createSession(body: Record<string, unknown> = {}): Promise<CreatedSession> {
  const response = await api("/api/sessions", { method: "POST", body });
  expect(response.status, `create session: ${response.text}`).toBe(201);
  return response.json as CreatedSession;
}

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

describe("POST /api/sessions", () => {
  it("returns 201 with a token that appears in no URL", async () => {
    const session = await createSession({ domain: "clinic", localLanguage: "French" });

    // The visible id is deliberately short and read-aloud safe ("LD-K7P4X2") so a
    // receptionist can dictate it: it is a label, not the secret. The token below
    // is the 32-byte credential, and it never appears in a URL.
    expect(session.sessionId).toMatch(/^LD-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
    expect(session.sessionId).not.toMatch(/[IO01]/);
    expect(typeof session.token).toBe("string");
    expect(session.token.length).toBeGreaterThanOrEqual(16);
    expect(typeof session.expiresAt).toBe("number");
    expect(session.expiresAt).toBeGreaterThan(Date.now());

    expect(Array.isArray(session.joinUrls)).toBe(true);
    expect(session.joinUrls.length).toBeGreaterThan(0);
    expect(session.joinUrl).toBe(session.joinUrls[0]);

    // The token is the only secret and must never travel in a URL: a QR code or a
    // browser history entry would otherwise hand out access to anyone who sees it.
    for (const url of session.joinUrls) {
      expect(url).toContain(session.sessionId);
      expect(url).not.toContain(session.token);
    }
  });

  it("accepts every domain and falls back to clinic for an unknown one", async () => {
    for (const domain of ["clinic", "hotel", "office", "not-a-domain"]) {
      const session = await createSession({ domain });
      const read = await api(`/api/sessions/${session.sessionId}`, { headers: withToken(session.token) });
      expect(read.status).toBe(200);
      expect((read.json as { domain: string }).domain).toBe(domain === "not-a-domain" ? "clinic" : domain);
    }
  });

  it("rejects a malformed JSON body with a JSON error, not a stack trace", async () => {
    const response = await api("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"domain": "clinic"',
    });

    expect(response.status).toBe(400);
    expect(response.json).toMatchObject({ error: expect.any(String) });
    expect(response.text).not.toMatch(/at .*\.ts:\d+|SyntaxError|Traceback/);
  });
});

describe("GET /api/sessions/:id", () => {
  it("returns the public view for the holder of the token", async () => {
    const session = await createSession({ domain: "hotel", localLanguage: "English" });
    const response = await api(`/api/sessions/${session.sessionId}`, { headers: withToken(session.token) });

    expect(response.status).toBe(200);
    const body = response.json as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "clientConnected",
      "createdAt",
      "domain",
      "expiresAt",
      "hostConnected",
      "localLanguage",
      "messages",
      "sessionId",
    ]);
    expect(body.sessionId).toBe(session.sessionId);
    expect(body.domain).toBe("hotel");
    expect(body.messages).toEqual([]);
    // The device that created the session *is* the host, so it counts as connected
    // from the moment the session exists; the participant on the other side of the
    // room is the one nobody has joined yet.
    expect(body.hostConnected).toBe(true);
    expect(body.clientConnected).toBe(false);

    // The token is issued once, at creation, and is never readable again.
    expect(body).not.toHaveProperty("token");
  });

  it("accepts the Bearer form of the same token", async () => {
    const session = await createSession();
    const response = await api(`/api/sessions/${session.sessionId}`, { headers: bearer(session.token) });
    expect(response.status).toBe(200);
  });

  it("refuses an id with no token, a wrong token, and an unknown id - distinctly", async () => {
    const session = await createSession();
    const path = `/api/sessions/${session.sessionId}`;

    const anonymous = await api(path);
    expect(anonymous.status).toBe(401);
    expect(anonymous.json).toMatchObject({ error: expect.any(String) });

    expect((await api(path, { headers: withToken("definitely-not-the-token") })).status).toBe(403);

    // An unknown id reads as missing rather than unauthorised: an id on its own is
    // not a secret and grants nothing either way.
    expect((await api(`/api/sessions/${UNKNOWN_ID}`, { headers: withToken(session.token) })).status).toBe(404);
  });

  it("never lets one session's token read another session", async () => {
    const a = await createSession({ domain: "clinic" });
    const b = await createSession({ domain: "hotel" });

    const crossed = await api(`/api/sessions/${b.sessionId}`, { headers: withToken(a.token) });
    expect(crossed.status).toBe(403);
    expect(crossed.text).not.toContain("hotel");
  });
});

describe("DELETE /api/sessions/:id", () => {
  it("ends the session, after which the id no longer exists", async () => {
    const session = await createSession({ domain: "office" });
    const path = `/api/sessions/${session.sessionId}`;

    const ended = await api(path, { method: "DELETE", headers: withToken(session.token) });
    expect(ended.status).toBe(200);
    expect(ended.json).toMatchObject({ success: true, sessionId: session.sessionId });

    const after = await api(path, { headers: withToken(session.token) });
    expect(after.status).toBe(404);

    // Ending twice is not something the client has to special-case, and the second
    // attempt must not resurrect the session.
    expect((await api(path, { method: "DELETE", headers: withToken(session.token) })).status).toBe(404);
    expect((await api(path, { headers: withToken(session.token) })).status).toBe(404);
  });

  it("accepts the token in the body for clients that cannot set DELETE headers", async () => {
    const session = await createSession();
    const path = `/api/sessions/${session.sessionId}`;

    expect((await api(path, { method: "DELETE", body: { token: session.token } })).status).toBe(200);
    expect((await api(path, { headers: withToken(session.token) })).status).toBe(404);
  });

  it("refuses an unauthorised or unknown delete without ending anything", async () => {
    const keepAlive = await createSession();
    const path = `/api/sessions/${keepAlive.sessionId}`;

    expect((await api(path, { method: "DELETE" })).status).toBe(401);
    expect((await api(path, { method: "DELETE", headers: withToken("wrong") })).status).toBe(403);
    expect((await api(path, { method: "DELETE", body: { token: "wrong" } })).status).toBe(403);
    expect((await api(`/api/sessions/${UNKNOWN_ID}`, { method: "DELETE", body: { token: keepAlive.token } })).status).toBe(404);

    // None of those attempts changed anything.
    expect((await api(path, { headers: withToken(keepAlive.token) })).status).toBe(200);
  });

  it("counts live sessions in health, without exposing ids or tokens", async () => {
    const before = (await api("/api/health")).json as HealthJson;
    const session = await createSession();
    const after = (await api("/api/health")).json as HealthJson;

    const count = (value: HealthJson) => Number(value.sessions.activeCount);
    expect(count(after)).toBe(count(before) + 1);

    // Neither the id nor the token may appear in a health payload.
    const text = JSON.stringify(after);
    expect(text).not.toContain(session.sessionId);
    expect(text).not.toContain(session.token);

    await api(`/api/sessions/${session.sessionId}`, { method: "DELETE", headers: withToken(session.token) });
    const cleaned = (await api("/api/health")).json as HealthJson;
    expect(count(cleaned)).toBe(count(before));
  });
});
