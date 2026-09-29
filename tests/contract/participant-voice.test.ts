/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Phase 7C contract: a phone across the LAN is a microphone for this laptop.
 *
 * Three claims have to hold at once for phone voice input to be worth trusting
 * in a clinic, and each is checked here rather than assumed:
 *
 *   1. the participant view has exactly one capture path, and it is this laptop's
 *      own recorder feeding the local engine. The browser recogniser that streams
 *      a patient's voice to a vendor is gone from the client and stays gone;
 *   2. audio arriving from another device cannot be dropped on the endpoint
 *      anonymously. It names the session it belongs to and proves it *before* a
 *      byte of it is read into memory;
 *   3. none of this disturbs what already worked: the typed path from the phone,
 *      and the laptop's own voice input.
 *
 * The LAN cases connect through this machine's real LAN address, never 127.0.0.1.
 * That distinction is the entire subject: the server decides what to demand of a
 * request from the interface it arrived on, so a test that dials loopback is not
 * standing where the phone stands. On a machine with no LAN address those cases
 * say so out loud and stand down - they never pass quietly.
 *
 * The audio itself is deliberately not asserted here. Whether Whisper turns a
 * phrase into the right words is Phase 7A's subject (`tests/models/speech`), and
 * it is the same engine for both callers; what changes for a phone is who may
 * call it, which is what this file is about.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import type { PeerCertificate, TLSSocket } from "node:tls";
import { io, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ROOT,
  api,
  baseUrl,
  itRequiring,
  lanAddresses,
  lanBaseUrl,
  probeEngines,
  request,
  type ApiResponse,
} from "../helpers/harness";

interface CreatedSession {
  sessionId: string;
  token: string;
  joinUrls: string[];
}

async function createSession(body: Record<string, unknown> = {}): Promise<CreatedSession> {
  const response = await api("/api/sessions", { method: "POST", body });
  expect(response.status, `create session: ${response.text}`).toBe(201);
  return response.json as CreatedSession;
}

/**
 * A short 16 kHz mono tone, standing in for a phrase spoken into a phone.
 *
 * Built here rather than borrowed from the speech suite on purpose: these cases
 * are about whether the request is allowed to reach the engine, so the clip has
 * to be cheap and never depend on the TTS engine being available.
 */
function spokenClip(seconds = 0.4): Buffer {
  const rate = 16_000;
  const frames = Math.round(rate * seconds);
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + frames * 2, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) {
    bytes.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 6_000), 44 + i * 2);
  }
  return bytes;
}

/**
 * One transcription request, shaped exactly as the participant view sends it
 * (`src/services/api.ts`): audio in the body, language in the query and in
 * `x-audio-language`, session headers only when the caller has a session.
 */
async function postClip(
  origin: string,
  options: { session?: CreatedSession; language?: string } = {}
): Promise<ApiResponse> {
  const language = options.language ?? "english";
  return request(origin, `/api/transcribe?language=${language}&rate=16000`, {
    method: "POST",
    headers: {
      "content-type": "audio/wav",
      "x-audio-language": language,
      ...(options.session
        ? { "x-session-id": options.session.sessionId, "x-session-token": options.session.token }
        : {}),
    },
    body: spokenClip(),
    timeoutMs: 120_000,
  });
}

/** The server's own machine-readable reason, when it gave one. */
function reasonCode(response: ApiResponse): string {
  return String((response.json as { code?: unknown } | null)?.code ?? "");
}


/* ------------------------------------------------------------------ */
/* 1. One capture path, and it is the laptop's own recorder            */
/* ------------------------------------------------------------------ */

describe("the participant view records locally, not through the browser", () => {
  const view = readFileSync(path.join(ROOT, "src/components/PrivateSessionParticipant.tsx"), "utf8");
  const apiSource = readFileSync(path.join(ROOT, "src/services/api.ts"), "utf8");

  it("captures with this laptop's recorder and posts it to the local endpoint", () => {
    expect(view).toContain("LocalAudioRecorder");
    expect(view).toContain("transcribeAudio(");
    expect(apiSource).toContain("/api/transcribe");
  });

  it("keeps the browser recogniser and every second audio pipeline out of the view", () => {
    // The repository-wide scan in `local-first.test.ts` covers the whole source
    // tree; this is the one file where a regression would actually reach a patient,
    // so it is asserted where the mistake would be made.
    const code = withoutComments(view);
    expect(code).not.toMatch(/SpeechRecognition/);
    expect(code).not.toMatch(/MediaRecorder/);
    // The view talks to `services/api` like every other view: one place where a
    // request is built, so one place where the session headers can be added.
    expect(code).not.toMatch(/fetch\(/);
  });

  it("explains a missing microphone instead of offering one that does nothing", () => {
    const capture = readFileSync(path.join(ROOT, "src/services/audioCapture.ts"), "utf8");
    // The sentence a person sees has to name the fallback they still have: typing,
    // which is translated identically. A silent failure reads as a broken app.
    expect(capture).toContain("isSecureContext");
    expect(capture).toMatch(/type the message/i);
    expect(view).toContain("captureFailureReason");
  });
});

/* ------------------------------------------------------------------ */
/* 1b. Readiness is real capability, re-answered - never a permission   */
/*    guess, and never a wait without an end                            */
/* ------------------------------------------------------------------ */

describe("the microphone button reflects real availability", () => {
  const capture = readFileSync(path.join(ROOT, "src/services/audioCapture.ts"), "utf8");
  const view = readFileSync(path.join(ROOT, "src/components/PrivateSessionParticipant.tsx"), "utf8");

  /**
   * The readiness verdict itself, with the prose set aside: from the top of the file
   * down to the diagnostics block, which is reporting rather than deciding.
   */
  function readinessSource(): string {
    const code = withoutComments(capture);
    return code.slice(0, code.indexOf("export interface CaptureDiagnostics"));
  }

  it("never lets a permission query decide whether the button works", () => {
    // A phone that has already granted the microphone must never be told to wait, and
    // this is where that would go wrong: `permissions.query({name:"microphone"})`
    // throws outright on iOS Safari and, on browsers that implement it, can answer
    // "prompt" while the permission is in fact granted. Asking is what settles
    // permission, so the verdict is capability only and the query is reported, never
    // consulted.
    const verdict = readinessSource();
    expect(verdict).not.toMatch(/permissions/);
    expect(verdict).toContain("captureFailureReason");
    expect(verdict).toContain("isSecureContext");
    expect(capture).toContain("export function captureDiagnostics");
    expect(capture).toContain("export async function queryMicrophonePermission");
  });

  it("creates the audio context inside the tap, before the permission prompt", () => {
    // The defect this locks down: the context used to be created after
    // `await getUserMedia(...)`, and on WebKit a context created outside a gesture is
    // born suspended and produces nothing. The result on a phone whose microphone had
    // *already* been granted was a button stuck on "waiting for the microphone".
    const code = withoutComments(capture);
    const contextAt = code.indexOf("new AudioCtor");
    const promptAt = code.indexOf("getUserMedia({");
    expect(contextAt).toBeGreaterThan(-1);
    expect(promptAt).toBeGreaterThan(-1);
    expect(contextAt).toBeLessThan(promptAt);
    // And the resume that context may still need is never awaited bare: that promise
    // is the one WebKit can leave pending for good, which froze the state machine.
    expect(code).not.toMatch(/await context\.resume\(\)/);
    expect(code).toContain("RESUME_GRACE_MS");
  });

  it("takes the readiness verdict again when the page comes back", () => {
    // Refuse, grant in site settings, return: the ordinary order on a phone. A verdict
    // taken once at mount would be stale for the rest of the session.
    expect(view).toContain("visibilitychange");
    expect(view).toContain("captureDiagnostics");
    expect(view).toContain("describeCaptureFailure");
    // StrictMode runs setup and cleanup twice on the same refs, so a `goneRef` that is
    // only ever set true would cancel every capture this page started.
    expect(view).toContain("goneRef.current = false");
  });

  it("bounds the wait, so waiting can never be the final state", () => {
    expect(view).toContain("START_WATCHDOG_MS");
    expect(view).toContain("The microphone did not start");
    // A refusal is answered with a sentence naming the way out that still works.
    const code = withoutComments(capture);
    const described = code.slice(code.indexOf("function describeCaptureFailure"));
    expect(described).toMatch(/NotAllowedError/);
    expect(described).toMatch(/type the message/i);
  });

  it("reports the diagnostics on the device that is failing", () => {
    // The phone is the only machine that knows why the phone's button is grey, so the
    // answer has to be readable there rather than only in a terminal.
    for (const field of ["secure-context", "mediaDevices", "getUserMedia", "audioContext", "permission", "blocked-by"]) {
      expect(view).toContain(field);
    }
    expect(view).toContain("Voice diagnostics");
  });
});

/** The sentence the user is shown, verbatim. */
function reasonText(response: ApiResponse): string {
  return String((response.json as { error?: unknown } | null)?.error ?? "");
}

function standDown(what: string): void {
  console.log(`[skip] ${what} - this machine has no LAN address to stand at`);
}

/**
 * Source with comments set aside. The scan is about code, not prose about code -
 * a file that explains why `MediaRecorder` was rejected is not a file that uses it.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}


/* ------------------------------------------------------------------ */
/* 2. The phone still types, and lands in the same room as the laptop   */
/* ------------------------------------------------------------------ */

const engines = await probeEngines();

/**
 * A socket opened the way the phone opens it: the origin the phone would use, the
 * same handshake fields the view sends, websocket only - so this cannot pass on a
 * fallback transport that the phone would not be using.
 */
function openPhone(origin: string, auth: Record<string, unknown>): Socket {
  return io(origin, {
    path: "/socket.io",
    transports: ["websocket"],
    auth,
    reconnection: false,
    timeout: 20_000,
  });
}

/**
 * A device identifier, in the shape the phone generates one (services/deviceIdentity).
 *
 * The client role is bound to the first device that joins (Issue 3), so every
 * participant socket has to name its device. The label is the only thing that
 * matters: two sockets with the same label are the same phone, two with different
 * labels are not, and the identifiers are padded to one length so they compare the
 * way real ones do.
 */
function deviceId(label: string): string {
  return `test-device-${label}-0123456789abcdef`;
}

/** The first payload of `event`, or a failure naming the event that never came. */
function nextEvent(socket: Socket, event: string, timeoutMs = 30_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const handler = (payload: any) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out after ${timeoutMs}ms waiting for "${event}"`));
    }, timeoutMs);
    socket.on(event, handler);
  });
}

function sendMessage(socket: Socket, text: string): Promise<any> {
  return new Promise((resolve, reject) => {
    socket.timeout(180_000).emit("message:send", { text }, (error: unknown, reply: unknown) => {
      if (error) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve(reply);
    });
  });
}

describe("the phone still types, and reaches the same room as the laptop", () => {
  const LAN = lanBaseUrl("http");

  it("refuses a phone that cannot prove the pairing", async () => {
    if (!LAN) return standDown("socket pairing");
    const stranger = openPhone(LAN, { sessionId: "LD-222222", token: "not-a-token", role: "participant" });
    try {
      const error = await nextEvent(stranger, "connect_error");
      expect(String((error as Error)?.message ?? error)).toMatch(/unauthorized/i);
      expect(stranger.connected).toBe(false);
    } finally {
      stranger.close();
    }
  });

  it("joins a paired phone into the session the laptop is holding", async () => {
    if (!LAN) return standDown("socket join");
    const session = await createSession({ domain: "general", localLanguage: "Swahili" });
    const phone = openPhone(LAN, {
      sessionId: session.sessionId,
      token: session.token,
      role: "participant",
      // The client role is bound to a device (Issue 3), so a phone must name itself.
      clientId: deviceId("phone-a"),
    });
    try {
      const ready = await nextEvent(phone, "session:ready");
      expect(ready.sessionId).toBe(session.sessionId);
      expect(ready.role).toBe("participant");
      expect(ready.participantConnected).toBe(true);

      // An empty message is refused without waking a model, which is the cheapest
      // proof that the phone's own send path is intact end to end.
      const refused = await sendMessage(phone, "");
      expect(refused.ok).toBe(false);
      expect(refused.error).toBe("empty");
    } finally {
      phone.close();
    }
  });

  itRequiring(
    "carries a typed message from the phone to the laptop and back translated",
    engines.translation,
    engines.note
  )("does so over the LAN address", async () => {
    if (!LAN) return standDown("typed round trip");
    const session = await createSession({ domain: "general", localLanguage: "Swahili" });
    const laptop = openPhone(LAN, { sessionId: session.sessionId, token: session.token, role: "host" });
    const phone = openPhone(LAN, {
      sessionId: session.sessionId,
      token: session.token,
      role: "participant",
      clientId: deviceId("phone-b"),
    });

    try {
      await nextEvent(laptop, "session:ready");
      await nextEvent(phone, "session:ready");

      const text = "I have a headache and a fever";
      const delivered = nextEvent(laptop, "message:translated");
      const ack = await sendMessage(phone, text);

      expect(ack.ok, `the phone's message was refused: ${JSON.stringify(ack)}`).toBe(true);
      const received = await delivered;
      expect(received.sender).toBe("patient");
      expect(received.message.originalText).toBe(text);
      expect(String(received.message.translation ?? "").length).toBeGreaterThan(0);
    } finally {
      phone.close();
      laptop.close();
    }
  });
});


/* ------------------------------------------------------------------ */
/* 3. Audio from another device must name its session                  */
/* ------------------------------------------------------------------ */

describe("voice from another device must name its session", () => {
  const LAN = lanBaseUrl("http");
  const distBuilt = existsSync(path.join(ROOT, "dist", "index.html"));

  it("refuses a LAN recording with no session before its audio is read", async () => {
    if (!LAN) return standDown("anonymous LAN recording");
    const response = await postClip(LAN);

    expect(response.status, response.text.slice(0, 300)).toBe(401);
    expect(reasonCode(response)).toBe("token-required");
    // The view prints this sentence verbatim, so it has to name the way out.
    expect(reasonText(response)).toMatch(/typing still works/i);
  });

  it("refuses a LAN recording whose token belongs to a different session", async () => {
    if (!LAN) return standDown("borrowed token");
    const session = await createSession();
    const response = await postClip(LAN, { session: { ...session, token: `${session.token}wrong` } });

/* ------------------------------------------------------------------ */
/* 4. The certificate the phone is asked to trust                      */
/* ------------------------------------------------------------------ */

const CERT_DIR = path.join(ROOT, "certs");
const CA_FILE = path.join(CERT_DIR, "rootCA.pem");

/**
 * Certificates are made per laptop (`npm run cert:lan`) and are git-ignored, so
 * this suite skips on a machine that has never made one. It does not fall back to
 * an unverified connection: a test that ignores the certificate would prove
 * nothing about the browser check Phase 7C exists to satisfy.
 */
const CERT_READY =
  existsSync(path.join(CERT_DIR, "cert.pem")) &&
  existsSync(path.join(CERT_DIR, "key.pem")) &&
  existsSync(CA_FILE);
if (!CERT_READY) console.log("[skip] HTTPS on the LAN address - run `npm run cert:lan` first");

/** A port nothing else is holding at this moment. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

interface TlsAnswer {
  status: number;
  json: Record<string, unknown> | null;
  /** The leaf the server presented, so its names can be read rather than assumed. */
  cert: PeerCertificate;
}

/**
 * One request over a real TLS connection, with mkcert's CA pinned as the only
 * anchor - the same chain a phone walks once its CA is installed, and with no way
 * to pass by switching verification off.
 */
function httpsRequest(
  origin: string,
  pathname: string,
  options: { ca: Buffer; method?: string; headers?: Record<string, string>; body?: Buffer }
): Promise<TlsAnswer> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      `${origin}${pathname}`,
      { method: options.method ?? "GET", ca: options.ca, headers: options.headers, timeout: 30_000 },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => {
          let json: Record<string, unknown> | null = null;
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            json = null;
          }
          resolve({
            status: response.statusCode ?? 0,
            json,
            cert: (response.socket as unknown as TLSSocket).getPeerCertificate(true),
          });
        });
      }
    );

interface HttpsServer {
  /** Loopback, for the checks that are about the certificate itself. */
  origin: string;
  /** This machine's LAN address - where the phone stands. Null when there is none. */
  lanOrigin: string | null;
  stop: () => Promise<void>;
}

/** Boots a second server with TLS on, as `npm run dev` does when `certs/` exists. */
async function bootHttpsServer(): Promise<HttpsServer> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "production", PORT: String(port), HTTPS_ENABLED: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    for (let waited = 0; waited < 5_000 && child.exitCode === null; waited += 100) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const origin = `https://127.0.0.1:${port}`;
  const ca = readFileSync(CA_FILE);
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const health = await httpsRequest(origin, "/api/health", { ca });
      if (health.status === 200) {
        const address = lanAddresses()[0];
        return { origin, lanOrigin: address ? `https://${address}:${port}` : null, stop };
      }
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error("the HTTPS server never became reachable (is another `npm run dev` holding the port?)");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const tlsSuite = CERT_READY ? describe : (describe.skip as typeof describe);

tlsSuite("HTTPS on the LAN address (Phase 7C)", () => {
  let server: HttpsServer;
  let ca: Buffer;

  beforeAll(async () => {
    ca = readFileSync(CA_FILE);
    server = await bootHttpsServer();
  });

  afterAll(async () => {
    await server?.stop();
  });

  it("completes a handshake a phone can verify, on every address it might type", async () => {
    const answer = await httpsRequest(server.origin, "/api/health", { ca });
    expect(answer.status).toBe(200);
    expect(answer.json?.cloudProviders).toBe("none");

    // A certificate that omits the laptop's current address arrives on the phone as
    // a warning, and a warning is not something to click past in front of a patient
    // - so the names are read back and asserted, not assumed.
    const names = String(answer.cert.subjectaltname ?? "");
    expect(names).toContain("localhost");
    expect(names).toContain("127.0.0.1");
    for (const address of lanAddresses()) expect(names).toContain(address);
  });

  it("hands the host https join URLs, so the phone opens a secure context", async () => {
    const created = await httpsRequest(server.origin, "/api/sessions", {
      ca,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ domain: "general", localLanguage: "Swahili" })),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);

    const urls = (created.json?.joinUrls ?? []) as string[];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url.startsWith("https://")).toBe(true);
    expect(String(created.json?.joinUrl ?? "")).toContain("https://");
  });

  it("serves and guards the LAN interface itself, not only loopback", async () => {
    if (!server.lanOrigin) return standDown("TLS on the LAN address");
    const answer = await httpsRequest(server.lanOrigin, "/api/transcribe?language=english&rate=16000", {
      ca,
      method: "POST",
      headers: { "content-type": "audio/wav", "x-audio-language": "english" },
      body: spokenClip(0.1),
    });

    // Arriving here at all means the TLS listener answered a request sent to the LAN
    // interface with a certificate the pinned CA validates. A recording with no
    // session is then refused, exactly as it is over plain HTTP.
    expect(answer.status).toBe(401);
    expect(String(answer.json?.code ?? "")).toBe("token-required");
  });
});

    request.once("error", reject);
    request.once("timeout", () => request.destroy(new Error("the TLS connection timed out")));
    if (options.body) request.write(options.body);
    request.end();
  });
}


    expect(response.status, response.text.slice(0, 300)).toBe(403);
    expect(reasonCode(response)).toBe("invalid-token");
  });

  it("lets a paired phone's clip through to the local engine", async () => {
    if (!LAN) return standDown("paired LAN recording");
    const session = await createSession();
    const response = await postClip(LAN, { session });

    // The guard is what this file owns. What the engine then makes of the clip is
    // Phase 7A's subject (`tests/models/speech`): a 200, a "too short"/"empty
    // transcript" 400, or an engine-not-ready 503 all mean the audio was accepted
    // and reached Whisper, which is precisely the claim made here.
    expect([200, 400, 503], `unexpected answer: ${response.text.slice(0, 300)}`).toContain(response.status);
    expect(reasonCode(response)).not.toBe("token-required");
    expect(reasonCode(response)).not.toBe("invalid-token");
  });

  it("leaves the laptop's own voice input exactly as Phase 7A left it", async () => {
    // Loopback is the path the Recorder tab and the participant view have always
    // used on this machine; Phase 7C must not have started demanding a token here.
    const response = await postClip(baseUrl());
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });

  it("serves the participant app over the LAN address", async () => {
    if (!LAN) return standDown("LAN reachability");
    const app = await request(LAN, "/");
    expect(app.status).toBe(200);
    expect(app.headers.get("content-type")).toMatch(/text\/html/);

    if (!distBuilt) return standDown("the join page (run `npm run build`)");
    const session = await createSession();
    const join = await request(LAN, `/join/${session.sessionId}`);
    expect(join.status).toBe(200);
    expect(join.headers.get("content-type")).toMatch(/text\/html/);
  });
});
