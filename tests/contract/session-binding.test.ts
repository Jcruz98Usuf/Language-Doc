/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contract tier: who may hold a session's client (participant) role, and what the
 * phone's back button is allowed to do.
 *
 * The pairing token proves the *session*; a per-browser device identifier proves the
 * *device*. Both halves matter in a clinic, because the join link is on a screen, can
 * be photographed and stays in browser history - so "the phone that joined has gone
 * quiet" must never mean "the role is free for whoever holds the link".
 *
 * Three cases have to hold at once, and all three are exercised here against a real
 * running server:
 *
 *   A. network drop: the same device reconnects - allowed, exactly as before;
 *   B. deliberate leave ("Not now"): the same device rejoins before expiry - allowed,
 *      because it is still the same device, and the session was never ended;
 *   C. a different device - or any device that does not name itself - while the
 *      original still owns the role: refused, whether the original is connected or
 *      gone for reasons nobody can see, and refused *without* disturbing the owner.
 *
 * Only the session ending releases the binding, so that is checked from both ends:
 * the host's DELETE and the participant's own "End session" call, which is the same
 * route with the same token and the same effect.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { io, type Socket } from "socket.io-client";
import { describe, expect, it } from "vitest";
import { ROOT, api, baseUrl, withToken, type ApiResponse } from "../helpers/harness";

interface CreatedSession {
  sessionId: string;
  token: string;
}

async function createSession(): Promise<CreatedSession> {
  const response = await api("/api/sessions", { method: "POST", body: { domain: "clinic" } });
  expect(response.status, `create session: ${response.text}`).toBe(201);
  return response.json as CreatedSession;
}

/** The server's own sentence for a refused client role. */
const CLIENT_ROLE_TAKEN = "This session already has a connected participant.";

/**
 * A socket opened the way the phone opens it: websocket only, no reconnection, and a
 * device identifier in the handshake. `openPhone` in participant-voice.test.ts is the
 * same shape; each helper stays beside the cases that use it.
 */
function openPhone(auth: Record<string, unknown>): Socket {
  return io(baseUrl(), {
    path: "/socket.io",
    transports: ["websocket"],
    auth,
    reconnection: false,
    timeout: 20_000,
  });
}

/** A device identifier, as services/deviceIdentity generates one. */
function deviceId(label: string): string {
  return `test-device-${label}-0123456789abcdef`;
}

/** The first payload of `event`, or a failure naming the event that never came. */
function nextEvent(socket: Socket, event: string, timeoutMs = 20_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const handler = (payload: any) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);
    socket.on(event, handler);
  });
}

/** Joins as the participant and resolves once the server has accepted the role. */
async function joinAs(device: string, session: CreatedSession) {
  const socket = openPhone({
    sessionId: session.sessionId,
    token: session.token,
    role: "participant",
    clientId: deviceId(device),
  });
  const ready = await nextEvent(socket, "session:ready");
  return { socket, ready };
}

/** The refusal a device receives, as the phone receives it. */
async function refusalFor(auth: Record<string, unknown>): Promise<Error & { data?: { code?: string } }> {
  const socket = openPhone(auth);
  try {
    return (await nextEvent(socket, "connect_error")) as Error & { data?: { code?: string } };
  } finally {
    socket.close();
  }
}

/** The session as a token holder sees it, for "was anything changed by that?" checks. */
async function readSession(session: CreatedSession): Promise<ApiResponse> {
  return api(`/api/sessions/${session.sessionId}`, { headers: withToken(session.token) });
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the client role belongs to one device", () => {
  it("A: lets the same device reconnect after its connection drops", async () => {
    const session = await createSession();
    const first = await joinAs("phone-a", session);
    first.socket.disconnect();

    // The same browser comes back. Nothing about the drop matters to the binding.
    const second = await joinAs("phone-a", session);
    expect(second.ready.role).toBe("participant");
    expect(second.ready.participantConnected).toBe(true);
    second.socket.disconnect();
  });

  it("A: still replaces a stale socket when the same device reconnects", async () => {
    // The reconnect takeover from Phase 5 must survive the binding: a phone that slept
    // before its old socket timed out is not locked out of its own session.
    const session = await createSession();
    const stale = await joinAs("phone-a", session);
    const evicted = nextEvent(stale.socket, "disconnect");
    const fresh = await joinAs("phone-a", session);

    await evicted;
    expect(stale.socket.connected).toBe(false);
    expect(fresh.socket.connected).toBe(true);
    fresh.socket.disconnect();
  });

  it("B: lets the same device rejoin after a deliberate leave, with the session alive", async () => {
    // "Not now" is a clean disconnect: the session keeps its data and its expiry, so
    // the same device - and only it - can open the link again and resume.
    const session = await createSession();
    const left = await joinAs("phone-a", session);
    left.socket.disconnect();
    await settle();

    // The session is still there, and the host was told the participant left.
    const state = await readSession(session);
    expect(state.status).toBe(200);
    expect((state.json as { clientConnected: boolean }).clientConnected).toBe(false);

    const back = await joinAs("phone-a", session);
    expect(back.ready.sessionId).toBe(session.sessionId);
    expect(Array.isArray(back.ready.messages)).toBe(true);
    back.socket.disconnect();
  });

  it("C: refuses a different device, and does not evict the owner", async () => {
    const session = await createSession();
    const owner = await joinAs("phone-a", session);

    const failure = await refusalFor({
      sessionId: session.sessionId,
      token: session.token,
      role: "participant",
      clientId: deviceId("phone-b"),
    });

    expect(failure.message).toBe(CLIENT_ROLE_TAKEN);
    expect(failure.data?.code).toBe("client-bound");

    // The owner keeps its role, and the session was not ended by the attempt.
    expect(owner.socket.connected).toBe(true);
    const state = await readSession(session);
    expect(state.status).toBe(200);
    expect((state.json as { clientConnected: boolean }).clientConnected).toBe(true);
    owner.socket.disconnect();
  });

  it("C: refuses a different device while the owner is offline for an unknown reason", async () => {
    // The whole point of the binding. The owner is gone as far as the server can see,
    // and why is unknowable from here: a powered-off phone, a crash, a browser that
    // killed the tab. "Unknown" must not read as "available".
    const session = await createSession();
    const owner = await joinAs("phone-a", session);
    owner.socket.disconnect();
    await settle();

    const failure = await refusalFor({
      sessionId: session.sessionId,
      token: session.token,
      role: "participant",
      clientId: deviceId("phone-b"),
    });
    expect(failure.message).toBe(CLIENT_ROLE_TAKEN);

    // And the refusal changed nothing at all.
    const state = await readSession(session);
    expect(state.status).toBe(200);
    expect((state.json as { clientConnected: boolean }).clientConnected).toBe(false);
  });

  it("C: refuses a device that does not name itself at all", async () => {
    // "Probably the same device" is exactly the assumption that let a second phone walk
    // in, so an unnamed participant is refused rather than trusted.
    const session = await createSession();
    const owner = await joinAs("phone-a", session);

    const failure = await refusalFor({
      sessionId: session.sessionId,
      token: session.token,
      role: "participant",
    });
    expect(failure.message).toBe(CLIENT_ROLE_TAKEN);
    expect(failure.data?.code).toBe("client-bound");
    expect(owner.socket.connected).toBe(true);
    owner.socket.disconnect();
  });

  it("does not bind the host role this way", async () => {
    // The binding is about the one client role. A host socket carries no device
    // identifier and must keep working, on the same session, alongside a phone.
    const session = await createSession();
    const owner = await joinAs("phone-a", session);
    const host = openPhone({ sessionId: session.sessionId, token: session.token, role: "host" });
    const ready = await nextEvent(host, "session:ready");
    expect(ready.role).toBe("host");
    host.disconnect();
    owner.socket.disconnect();
  });
});

describe("only the session ending releases the client role", () => {
  it("participant 'End session' purges the data exactly as the host's does", async () => {
    // Issue 2's "End session" calls the same route with the same token, so the purge is
    // not a special case: token invalidated, messages and profile dropped, id gone.
    const session = await createSession();
    const owner = await joinAs("phone-a", session);
    const path = `/api/sessions/${session.sessionId}`;

    const ended = await api(path, { method: "DELETE", headers: withToken(session.token) });
    expect(ended.status).toBe(200);
    expect(ended.json).toMatchObject({ success: true, sessionId: session.sessionId });

    expect((await api(path, { headers: withToken(session.token) })).status).toBe(404);
    expect((await readSession(session)).status).toBe(404);
    owner.socket.disconnect();
  });

  it("tells both devices the session ended, whichever device ended it", async () => {
    const session = await createSession();
    const host = openPhone({ sessionId: session.sessionId, token: session.token, role: "host" });
    await nextEvent(host, "session:ready");
    const owner = await joinAs("phone-a", session);

    const hostNotified = nextEvent(host, "session:ended");
    const phoneNotified = nextEvent(owner.socket, "session:ended");

    // The phone ends it, through the participant path.
    const ended = await api(`/api/sessions/${session.sessionId}`, {
      method: "DELETE",
      headers: withToken(session.token),
    });
    expect(ended.status).toBe(200);

    const [hostEvent, phoneEvent] = await Promise.all([hostNotified, phoneNotified]);
    expect(hostEvent.sessionId).toBe(session.sessionId);
    expect(phoneEvent.sessionId).toBe(session.sessionId);
  });

  it("releases the role with the session, so a late device is refused as unauthorised", async () => {
    const session = await createSession();
    const owner = await joinAs("phone-a", session);
    owner.socket.disconnect();

    await api(`/api/sessions/${session.sessionId}`, { method: "DELETE", headers: withToken(session.token) });

    // Any device now fails at the credential, not at the binding: the session that
    // owned the role is gone, and a new pairing starts with a new link.
    const failure = await refusalFor({
      sessionId: session.sessionId,
      token: session.token,
      role: "participant",
      clientId: deviceId("phone-b"),
    });
    expect(failure.data?.code).toBe("unauthorized");
  });
});

describe("the phone's back button asks before it leaves", () => {
  const view = readFileSync(path.join(ROOT, "src/components/PrivateSessionParticipant.tsx"), "utf8");
  const identity = readFileSync(path.join(ROOT, "src/services/deviceIdentity.ts"), "utf8");

  it("intercepts back with a history entry instead of navigating away", () => {
    // pushState on entry, and the entry pushed back the moment the phone's back button
    // is used: the page cannot slide past this view into the welcome screen.
    expect(view).toContain("window.history.pushState");
    expect(view).toContain("popstate");
  });

  it("offers exactly the two answers, with no way to dismiss it silently", () => {
    expect(view).toContain("End session");
    expect(view).toContain("Not now");
    // The overlay itself must not be a third way out.
    expect(view).not.toMatch(/bg-slate-900\/60[^>]*onClick/);
  });

  it("ends the session on one answer and only disconnects on the other", () => {
    // "End session" is the host's own request, so the purge and the broadcast are the
    // same ones. "Not now" is a clean socket close: the host is told, and nothing is
    // purged, because the session is not over.
    expect(view).toContain("endSession(sessionId, token)");
    expect(view).toMatch(/socketRef\.current\?\.disconnect\(\)/);
    // Nothing on the "Not now" path may reach the ending request.
    const leavePath = view.slice(view.indexOf("const leaveWithoutEnding"));
    expect(leavePath.slice(0, 400)).not.toContain("endSession(");
  });

  it("reuses one device identity for rejoin - there is no second rejoin path", () => {
    expect(view).toContain("participantDeviceId");
    expect(view).toMatch(/clientId: participantDeviceId\(\)/);
    expect(identity).toContain("localStorage");
    expect(view).toContain("fetchSession");
  });

  it("says which device owns the role instead of implying the link is broken", () => {
    expect(view).toContain("client-bound");
    expect(view).toContain("This session already has a connected participant.");
  });

  it("does not offer a refused device the chance to end someone else's session", () => {
    // A device refused the role is not a participant of anything. Its back button
    // leaves; the end-or-leave question belongs only to the device that joined.
    expect(view).toMatch(/if \(sessionClosed \|\| rejected\) return;/);
  });
});

/**
 * Phase 7F: the phone is a participant, not an operator.
 *
 * Every symptom in that round of reports came from one design mistake - the
 * participant view delegating its "I am finished" to `onClosed`, which returned the
 * phone to the host's welcome screen. From there it saw the clinic UI, the domain
 * picker and the private-session launcher; "Not now" looked like a dead session;
 * and an ended link looked reusable. These tests pin the correction.
 */
describe("the pairing link carries the participant UI and nothing else", () => {
  const view = readFileSync(path.join(ROOT, "src/components/PrivateSessionParticipant.tsx"), "utf8");
  const app = readFileSync(path.join(ROOT, "src/App.tsx"), "utf8");

  it("never sends the phone to the welcome screen from the participant view", () => {
    // The finished-state button used to call onClosed(), which set AppMode.WELCOME.
    // It now goes to onEnded, and the only remaining onClosed wiring is the footer
    // fallback for a host that does not pass onEnded at all.
    expect(view).not.toMatch(/onClick=\{onClosed\}/);
    expect(view).toContain("onEnded");
  });

  it("'Not now' parks the phone on a rejoin screen instead of navigating away", () => {
    const leavePath = view.slice(view.indexOf("const leaveWithoutEnding"));
    const block = leavePath.slice(0, 600);

    // It disconnects (the host must see a clean leave) and parks - it does not
    // leave the view, and it does not end anything.
    expect(block).toMatch(/socketRef\.current\?\.disconnect\(\)/);
    expect(block).toContain("setLeft(true)");
    expect(block).not.toContain("onClosed()");
    expect(view).toContain("Rejoin session");
  });

  it("reconnects on rejoin through the same device binding", () => {
    // Rejoining must reuse the one socket path, or the device binding would be
    // re-claimed by a second connection and the host would see a churn.
    expect(view).toContain("const rejoin");
    expect(view).toMatch(/\[sessionId, token, left\]/);
  });

  it("stops offering a rejoin once the session is gone", () => {
    // A parked phone has no socket, so it would never hear session:ended and would
    // promise a rejoin into a session the host had already ended. It polls instead.
    expect(view).toContain("PARKED_POLL_INTERVAL_MS");
    expect(view).toContain("fetchSession");
    expect(view).toContain("left && !ended");
  });

  it("shows a spent link a dead end, not the host application", () => {
    // An early return, so the operator UI is not merely hidden - it is never built.
    expect(app).toContain("if (participantLinkClosed) {");
    expect(app).toContain("This private session has ended");
    const early = app.indexOf("if (participantLinkClosed) {");
    const welcome = app.indexOf("mode === AppMode.WELCOME &&");
    expect(early).toBeGreaterThan(-1);
    expect(early, "the dead-link screen must come before any host screen is rendered").toBeLessThan(welcome);
  });

  it("answers the host's back button with the same two choices", () => {
    // The host had no history guard at all: back unloaded the page and abandoned a
    // live session while the phone carried on talking to it.
    expect(app).toContain("setHostLeavePrompt(true)");
    expect(app).toContain("Leave this private session?");
    expect(app).toContain("End session");
    expect(app).toContain("Not now");
  });

  it("'Not now' on the host keeps the session; 'End session' really ends it", () => {
    expect(app).toMatch(/const endSessionFromHostBack = async \(\) => \{/);
    const end = app.slice(app.indexOf("const endSessionFromHostBack"));
    expect(end.slice(0, 600)).toContain("endSession(privateSession.sessionId, privateSession.token)");
    // Dismissing the host's question must not tear the session down.
    const dismiss = app.slice(app.indexOf("onClick={() => setHostLeavePrompt(false)}"));
    expect(dismiss.slice(0, 120)).not.toContain("endSession(");
  });
});

/**
 * The refresh case, which is the one that actually broke.
 *
 * Consuming the pairing link scrubs the secret from the URL on purpose, and that
 * left nothing to detect on reload - so a phone that had been a participant came
 * back as an operator, on the host's welcome screen. These pin the two halves of
 * the fix: the role is remembered for the tab, and the URL keeps a marker that
 * distinguishes a participant tab from a host tab.
 */
describe("a refresh never turns a participant into the host", () => {
  const app = readFileSync(path.join(ROOT, "src/App.tsx"), "utf8");
  const link = readFileSync(path.join(ROOT, "src/services/participantLink.ts"), "utf8");
  const view = readFileSync(path.join(ROOT, "src/components/PrivateSessionParticipant.tsx"), "utf8");

  it("remembers the pairing for the tab, in sessionStorage rather than localStorage", () => {
    // sessionStorage survives a refresh (the broken case) and dies with the tab, so
    // a live token is never left on a shared or clinic phone.
    expect(link).toContain("window.sessionStorage");
    expect(link).not.toContain("window.localStorage");
    expect(app).toContain("rememberParticipantLink");
    expect(app).toContain("readParticipantLink");
  });

  it("keeps a non-secret marker in the URL so a participant tab is recognisable", () => {
    expect(link).toContain("PARTICIPANT_PARAM");
    expect(app).toContain("participantSessionFromUrl");
    // The secret must never be written back into the URL.
    expect(app).not.toMatch(/replaceState\([^)]*token/);
  });

  it("rejoins from the remembered credential when the URL has no token", () => {
    expect(app).toMatch(/const remembered = readParticipantLink\(sessionId\)/);
    const restore = app.slice(app.indexOf("const remembered = readParticipantLink"));
    expect(restore.slice(0, 400)).toContain("setParticipantJoin({ sessionId, token: remembered.token })");
  });

  it("sends a spent link to the dead end rather than the welcome screen", () => {
    // Marker present, no credential: the pairing is finished.
    const spent = app.slice(app.indexOf("setParticipantLinkClosed(true);"));
    expect(spent.slice(0, 200)).not.toContain("AppMode.WELCOME");
  });

  it("forgets the credential as soon as the session is over, by any route", () => {
    // One place catches the self-end, the host broadcast, the parked poll and the
    // unauthorized check, so a refresh afterwards cannot retry a dead session.
    expect(view).toContain("if (sessionClosed) markParticipantLinkSpent();");
    expect(app).toContain("markParticipantLinkSpent");
  });

  it("keeps the marker after the end, so a refresh still knows this is a participant", () => {
    const leave = app.slice(app.indexOf("const leaveParticipantView"));
    const block = leave.slice(0, 1400);
    expect(block).toContain("PARTICIPANT_PARAM");
    // Dropping the marker would put the next refresh straight back on the host UI.
    expect(block).not.toMatch(/replaceState\(null, "", window\.location\.pathname\)/);
  });

  it("no history rewrite may rebuild the URL from pathname alone", () => {
    // This is the bug that made refresh land on the host's welcome screen, and it
    // was invisible: `pathname` is a perfectly valid URL, it is just missing the
    // `?p=` marker, so the participant's own back-button guard erased the very thing
    // that identified the tab as a participant.
    const participant = readFileSync(path.join(ROOT, "src/components/PrivateSessionParticipant.tsx"), "utf8");
    for (const [name, source] of [["App.tsx", app], ["PrivateSessionParticipant.tsx", participant]] as const) {
      const bare = source.match(/(?:push|replace)State\([^)]*window\.location\.pathname/g);
      expect(bare, `${name} rebuilds a history URL from pathname, dropping the ?p= marker`).toBeNull();
    }
  });
});
