/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Language Doctor / DualBridge server.
 *
 * Local-first: this Express API never contacts a cloud AI provider. Translation,
 * summarisation and profile extraction run on the local Ollama runtime through
 * src/server/services/languageEngine.ts.
 *
 *   React  ->  Express API  ->  Ollama (127.0.0.1:11434)  ->  qwen3:1.7b
 *
 * Endpoints:
 *   POST /api/translate       { text, from, to, context, domain }      -> { translatedText }
 *   POST /api/summarize       { profile, conversation, domain }        -> { summary }
 *   POST /api/parse-dialogue  { conversation, domain }                 -> domain profile JSON
 *   POST /api/sessions        { domain, localLanguage }                -> { sessionId, token, expiresAt }
 *   GET  /api/sessions/:id    token via x-session-token header         -> session state (no token)
 *   DELETE /api/sessions/:id  token via header or body                 -> { success }
 *   POST /api/transcribe      raw PCM / WAV body                       -> { text }
 *   POST /api/speech/synthesize { text, language, voiceMode }          -> audio/wav
 *   GET  /api/capabilities                                             -> language capability states
 *   GET  /api/health                                                   -> engine status
 *
 * Real-time private sessions (Phase 5) ride on the same HTTP server:
 *   handshake auth   { sessionId, token, role: "host" | "participant" }
 *   session:ready, participant-connected, participant-disconnected,
 *   message:processing, message:translated, message:error, session:ended
 * The client sends raw text only; direction, translation provider, model and
 * prompt stay server side. One host and one participant per session room.
 *
 * Temporary sessions are memory-only: no database, nothing written to disk, and
 * conversation content is never logged.
 */

import express from "express";
import type { Request, Response } from "express";
import { createServer } from "http";
import { createServer as createSecureServer } from "https";
import { existsSync, readFileSync } from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { Server as SocketServer } from "socket.io";
import { checkOllamaHealth, getOllamaConfig, isOllamaError, warmUpLocalModel } from "./src/server/services/ollama";
import {
  extractProfileWithLocalModel,
  summarizeWithLocalModel,
} from "./src/server/services/languageEngine";
import {
  describeLanguageCapabilities,
  describeTranslationEngine,
  normalizeDomain,
  translateText,
} from "./src/server/services/translation";
import { toAppDomain } from "./src/profile";
import {
  describeSttEngine,
  isSpeechLanguageSupported,
  normalizeSpeechLanguage,
  transcribeAudio,
  warmUpStt,
} from "./src/server/services/stt";
import { decodeAudioPayload } from "./src/server/services/stt/audio";
import { isSttError } from "./src/server/services/stt/types";
import {
  clearSpeechCache,
  describeSpeechEngine,
  isTtsError,
  synthesizeSpeech,
  warmUpSpeech,
} from "./src/server/services/speech/ttsProvider";
import { Language, Message } from "./src/types";
import {
  CLIENT_ROLE_TAKEN_MESSAGE,
  claimClientRole,
  createSession,
  endSession,
  getSession,
  getSessionStats,
  onSessionRemoved,
  startSessionSweeper,
  toPublicSession,
  updateSession,
  validateSessionToken,
} from "./src/server/services/sessions/sessionManager";

dotenv.config();

const PORT = Number.parseInt(process.env.PORT ?? "", 10) || 3000;
const HOST_URL = (process.env.HOST_URL ?? "").replace(/\/$/, "");

/** One socket message may carry at most this many characters after trimming. */
const MAX_MESSAGE_CHARS = 4000;

/**
 * LAN HTTPS for the participant phone (Phase 7C).
 *
 * A phone only hands over its microphone when the page is in a secure context,
 * and `http://<lan-ip>` never is one - so phone voice input needs real TLS with
 * a certificate the device has been told to trust. `npm run cert:lan` produces
 * that certificate with mkcert (see docs/phone-voice-demo.md). Nothing here
 * weakens the browser: no tunnel, no self-signed click-through, no insecure
 * origin flag - the device validates the chain or the page does not load.
 *
 * When a certificate is present TLS is the *only* listener. Socket.IO attaches to
 * a single HTTP(S) server (engine.io's `attach()` takes one server, not a list),
 * so running plain HTTP beside HTTPS would split every session in two: a host on
 * `http://localhost` and a phone on `https://<lan-ip>` would land in different
 * rooms and never see each other's messages. One listener keeps both devices in
 * the same room, on the scheme the phone requires.
 */
interface TlsMaterial {
  key: string;
  cert: string;
  /** Where the material came from, for the startup log only. */
  source: string;
}

/** Certificate material for this boot, or null when this instance is plain HTTP. */
function resolveTlsMaterial(): TlsMaterial | null {
  const setting = (process.env.HTTPS_ENABLED ?? "").trim().toLowerCase();
  if (setting === "false" || setting === "0" || setting === "off") return null;

  const keyPath = path.resolve(process.cwd(), process.env.TLS_KEY_PATH ?? "certs/key.pem");
  const certPath = path.resolve(process.cwd(), process.env.TLS_CERT_PATH ?? "certs/cert.pem");
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    if (setting === "true" || setting === "1" || setting === "on") {
      console.error(
        `[tls] HTTPS_ENABLED is set but no certificate pair was found at ${keyPath} / ${certPath}; ` +
          "serving plain HTTP. Run `npm run cert:lan` to create one."
      );
    }
    return null;
  }

  try {
    return {
      key: readFileSync(keyPath, "utf8"),
      cert: readFileSync(certPath, "utf8"),
      source: `${path.basename(certPath)} + ${path.basename(keyPath)}`,
    };
  } catch (error) {
    console.error(`[tls] certificate could not be read (${error instanceof Error ? error.message : String(error)}); serving plain HTTP.`);
    return null;
  }
}

const TLS = resolveTlsMaterial();

/** Scheme every join URL and every advertised origin uses for this boot. */
const SECURE_SCHEME = TLS ? "https" : "http";

/**
 * Origins offered for private-session join links (`/join/<id>`).
 *
 * `HOST_URL`, when set, is listed first as an explicit override; every
 * non-internal, non-link-local IPv4 address of this machine follows so a phone
 * on the same LAN can scan without any configuration. Loopback is never
 * offered - it is unreachable from another device.
 */
function lanOrigins(): string[] {
  const origins: string[] = [];
  if (HOST_URL) origins.push(HOST_URL);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      origins.push(`${SECURE_SCHEME}://${entry.address}:${PORT}`);
    }
  }
  return [...new Set(origins)];
}

function buildJoinUrls(sessionId: string): string[] {
  const joinPath = `/join/${encodeURIComponent(sessionId)}`;
  return lanOrigins().map((origin) => `${origin}${joinPath}`);
}

/**
 * Aborts downstream model work when the browser goes away or supersedes a
 * request. This is what keeps translation the highest-priority operation: a
 * cancelled profile extraction stops occupying the local model.
 *
 * NOTE: the response lifecycle is used, not the request's. Node emits "close"
 * on the request object as soon as the body has been fully read, so listening
 * there aborted every request before the model could answer. A response only
 * closes early when the client really did disconnect.
 */
function createRequestSignal(_req: Request, res: Response): AbortSignal {
  const controller = new AbortController();
  const abortIfClientGone = () => {
    if (!res.writableEnded) controller.abort();
  };

  res.on("close", abortIfClientGone);
  res.on("finish", () => res.off("close", abortIfClientGone));
  return controller.signal;
}

/** Turns local engine failures into useful HTTP responses for the UI. */
function sendEngineError(res: Response, error: unknown, fallbackMessage: string): void {
  if (isOllamaError(error)) {
    if (error.code === "cancelled") {
      // The caller already disconnected; nothing to answer.
      console.log("[local-ai] request cancelled by the caller");
      if (!res.headersSent) res.status(499).json({ error: error.message, code: error.code });
      return;
    }

    console.error(`[local-ai] ${error.code}: ${error.message}`);
    const status = error.code === "bad-response" ? 502 : 503;
    if (!res.headersSent) res.status(status).json({ error: error.message, code: error.code });
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(`[local-ai] unexpected failure: ${message}`);
  if (!res.headersSent) res.status(500).json({ error: fallbackMessage });
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Session token transport (documented contract):
 *   - primary:  `x-session-token: <token>`
 *   - also accepted: `Authorization: Bearer <token>` (for future Socket.IO/QR clients)
 * The token is never accepted from a URL and is never logged.
 */
/**
 * Socket.IO passes `message` to the client and nothing else, so a machine-readable
 * reason for a refusal rides along in `data`. The phone branches on a code instead of
 * on English prose, which keeps the wording of those sentences free to change.
 */
function withCode(error: Error, code: string): Error {
  (error as Error & { data?: unknown }).data = { code };
  return error;
}

/** Reads the session token from the header, or from a Bearer authorization. */
function readSessionToken(req: Request): string {
  const header = readString(req.header("x-session-token"));
  if (header) return header;

  const authorization = readString(req.header("authorization"));
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? match[1].trim() : "";
}

/**
 * True when the request arrived through this machine's own loopback interface.
 *
 * Phase 7A could leave `POST /api/transcribe` unauthenticated because the only
 * caller was a browser tab on this laptop. Phase 7C adds a caller across the LAN,
 * so the distinction now carries weight: loopback keeps the behaviour the laptop
 * path was built and tested against, anything else has to name the session its
 * audio belongs to.
 */
function isLoopbackRequest(req: Request): boolean {
  const raw = req.socket.remoteAddress ?? "";
  // Node reports IPv4 peers to a dual-stack socket as `::ffff:a.b.c.d`.
  const address = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  return address === "::1" || address.startsWith("127.");
}

/**
 * Session guard for `POST /api/transcribe` (Phase 7C, Step 3).
 *
 * Runs before the body parser, so audio from a device that cannot prove which
 * session it belongs to is never read into memory at all. A phone carries the
 * token exactly as every other session-scoped route does (`x-session-token`, or
 * `Authorization: Bearer`), and a token that does not belong to the session it
 * names is refused rather than honoured.
 */
function requireTranscribeAuth(req: Request, res: Response, next: express.NextFunction): void {
  if (isLoopbackRequest(req)) {
    next();
    return;
  }

  const sessionId = readString(req.header("x-session-id"));
  const token = readSessionToken(req);
  const refused = "Please reopen the session from the QR code - typing still works and is translated the same way.";

  if (!sessionId || !token) {
    res.status(401).json({
      error: `Voice input from another device must be paired with a session. ${refused}`,
      code: "token-required",
    });
    return;
  }
  if (!validateSessionToken(sessionId, token)) {
    res.status(403).json({
      error: `That pairing does not belong to this session. ${refused}`,
      code: "invalid-token",
    });
    return;
  }
  next();
}

/** Maps a client supplied language name onto the Language enum. */
function readLanguage(value: unknown): Language {
  const text = readString(value).toLowerCase();
  const match = Object.values(Language).find((language) => language.toLowerCase() === text);
  return match ?? Language.SWAHILI;
}

async function startServer(): Promise<void> {
  const app = express();
  // TLS when a LAN certificate exists, plain HTTP when it does not - see the
  // note above `resolveTlsMaterial` for why there is never one beside the other.
  const httpServer = TLS ? createSecureServer({ key: TLS.key, cert: TLS.cert }, app) : createServer(app);
  const io = new SocketServer(httpServer, { path: "/socket.io" });
  const config = getOllamaConfig();

  // Conversation payloads can be long; the old 100kb default could reject them.
  app.use(express.json({ limit: "2mb" }));

  /* ------------------------------------------------------------------ */
  /* Local AI endpoints                                                  */
  /* ------------------------------------------------------------------ */

  app.get("/api/health", async (_req, res) => {
    const ollama = await checkOllamaHealth();
    const translation = await describeTranslationEngine();
    // Translation is the critical interactive path: the service is only healthy
    // when a translation engine can actually answer.
    const healthy = ollama.reachable && ollama.modelInstalled && translation.ready;

    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      engine: "ollama",
      cloudProviders: "none",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      ollama,
      // Summaries + structured extraction stay on the local chat model.
      intelligence: {
        role: "summarise + parse-dialogue (not translation)",
        provider: "ollama",
        model: ollama.model,
        available: ollama.reachable && ollama.modelInstalled,
      },
      translation,
      // Local speech-to-text for the host laptop (Phase 7A). Reported
      // separately: voice is an enhancement, translation is the critical path,
      // so a missing STT model must not mark the whole service degraded.
      stt: await describeSttEngine(),
      // Local voice playback (Phase 7B). Reported under `speech` so input and
      // output live side by side: model ids and availability only, no paths.
      speech: { tts: await describeSpeechEngine() },
      // Temporary sessions: readiness + count only (no tokens, no content).
      sessions: getSessionStats(),
    });
  });

  /**
   * Language capability states for the demo UI. Deliberately reports only
   * language names, states and model/licence identifiers — no system paths,
   * cache locations, environment values or secrets.
   */
  app.get("/api/capabilities", async (_req, res) => {
    try {
      const capabilities = await describeLanguageCapabilities();
      res.json(capabilities);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[capabilities] ${message}`);
      res.status(500).json({ error: "Could not read language capabilities." });
    }
  });

  /* ------------------------------------------------------------------ */
  /* Temporary sessions (Phase 3) - memory only, no database             */
  /* ------------------------------------------------------------------ */

  /**
   * Creates a temporary session and returns its secret token. The token is only
   * ever returned here; later requests present it in the `x-session-token`
   * header (or `Authorization: Bearer`). It is never put in a URL.
   */
  app.post("/api/sessions", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { session } = createSession({
      domain: toAppDomain(body.domain),
      localLanguage: readLanguage(body.localLanguage),
    });

    res.status(201).json({
      sessionId: session.id,
      token: session.token,
      expiresAt: session.expiresAt,
      // The join URL never carries the token - only the QR fragment does.
      joinUrl: buildJoinUrls(session.id)[0] ?? null,
      joinUrls: buildJoinUrls(session.id),
    });
  });

  /**
   * Socket handshake: the token proves the session, the device identifier proves who
   * owns the client role.
   *
   * Socket.IO only carries `message` to the client by default, so a machine-readable
   * `data.code` is attached to each refusal. The phone branches on the code instead
   * of on English prose, which keeps the sentences free to change.
   */
  io.use((socket, next) => {
    const { sessionId, token, role, clientId } = socket.handshake.auth as Record<string, unknown>;
    if ((role !== "host" && role !== "participant") || !validateSessionToken(sessionId, token)) {
      next(withCode(new Error("Unauthorized private session."), "unauthorized"));
      return;
    }

    /**
     * Device binding: the first device to join owns the client role for the life of
     * the session, and only that device may (re)take it - whether it is reconnecting
     * after a dropped network, rejoining after a deliberate leave, or offline right
     * now for a reason nobody knows.
     *
     * This is checked BEFORE the takeover loop below, and that order is the point: a
     * refused device must not evict the legitimate one on its way out. Rejection is
     * deliberately blind to whether the owner is currently connected - "we cannot
     * tell why it is gone" is never treated as "the role is free".
     */
    if (role === "participant") {
      const claim = claimClientRole(sessionId, clientId);
      if (claim === "foreign") {
        next(withCode(new Error(CLIENT_ROLE_TAKEN_MESSAGE), "client-bound"));
        return;
      }
    }

    // At most one host and one participant per session - the newest connection
    // for a role WINS (reconnect takeover). A phone that sleeps and comes back
    // before its stale socket has timed out would otherwise be locked out of the
    // session permanently, because the dead socket is still registered. The
    // stale peer is disconnected here instead of rejecting the newcomer.
    //
    // The replaced socket is flagged before `disconnect()` so its own disconnect
    // handler (below) knows the role is being handed over rather than abandoned:
    // presence must not flap to "disconnected" during a takeover.
    for (const peer of [...io.sockets.sockets.values()]) {
      if (peer.data.sessionId === sessionId && peer.data.role === role) {
        peer.data.replaced = true;
        peer.disconnect(true);
      }
    }
    socket.data.sessionId = sessionId;
    socket.data.role = role;
    next();
  });

  /**
   * `session:ended` must reach both paired devices whether the session was
   * ended by the host (DELETE), by the TTL sweep, or by lazy expiry on access -
   * so the broadcast hangs off the manager's removal hook rather than off a
   * single route, and the paired sockets are torn down immediately.
   */
  onSessionRemoved((sessionId) => {
    const room = `session:${sessionId}`;
    io.to(room).emit("session:ended", { sessionId });
    for (const peer of io.sockets.sockets.values()) {
      if (peer.data.sessionId === sessionId) peer.disconnect(true);
    }
    // Voice playback belongs to the conversation that just ended: drop the
    // in-memory clips with it, on the same hook rather than a second one.
    clearSpeechCache();
  });

  io.on("connection", (socket) => {
    const sessionId = socket.data.sessionId as string;
    const role = socket.data.role as "host" | "participant";
    const room = `session:${sessionId}`;
    socket.join(room);

    if (role === "host") updateSession(sessionId, { hostConnected: true });
    else updateSession(sessionId, { clientConnected: true });

    // One replay event per (re)connect: language/domain for the UI, the
    // canonical transcript so a reconnecting device resumes, and presence flags
    // so the client needs no second round trip.
    const session = getSession(sessionId);
    socket.emit("session:ready", {
      sessionId,
      role,
      domain: session?.domain ?? null,
      localLanguage: session?.localLanguage ?? null,
      expiresAt: session?.expiresAt ?? null,
      hostConnected: session?.hostConnected ?? false,
      participantConnected: session?.clientConnected ?? false,
      messages: session?.messages ?? [],
    });
    if (role === "participant") socket.to(room).emit("participant-connected", { connected: true });

    /**
     * Validated, server-authoritative message flow.
     *
     * The client sends only raw text: direction is derived from the role and the
     * session's own configuration, so a client cannot choose the target
     * language, provider, model or prompt. The canonical Message is stored in
     * the session first, then acked to the sender and broadcast to the room.
     * Rejections answer the ack (and tell the peer) instead of throwing.
     */
    socket.on("message:send", (payload: unknown, ack?: (reply: unknown) => void) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const fail = (code: string, notifyPeer = false) => {
        if (notifyPeer) socket.to(room).emit("message:error", { code });
        reply({ ok: false, error: code });
      };

      const active = getSession(sessionId);
      if (!active) {
        fail("session-ended", true);
        return;
      }

      if (typeof payload !== "object" || payload === null) {
        fail("invalid-payload");
        return;
      }
      const body = payload as Record<string, unknown>;
      if (typeof body.text !== "string") {
        fail("invalid-payload");
        return;
      }
      const text = body.text.trim();
      if (!text) {
        fail("empty");
        return;
      }
      if (text.length > MAX_MESSAGE_CHARS) {
        fail("too-long");
        return;
      }

      // Direction is fixed by the session, never by the caller.
      const sourceLanguage = role === "host" ? Language.ENGLISH : active.localLanguage;
      const targetLanguage = role === "host" ? active.localLanguage : Language.ENGLISH;
      const requestedTarget =
        typeof body.targetLanguage === "string" ? body.targetLanguage.trim().toLowerCase() : "";
      if (requestedTarget && requestedTarget !== String(targetLanguage).toLowerCase()) {
        fail("invalid-language");
        return;
      }

      const sender = role === "host" ? "doctor" : "patient";
      socket.to(room).emit("message:processing", { sender });

      void translateText({
        text,
        sourceLanguage: String(sourceLanguage),
        targetLanguage: String(targetLanguage),
        domain: normalizeDomain(active.domain),
        context: `Communication from ${sender} in domain context ${active.domain}.`,
      })
        .then((result) => {
          const current = getSession(sessionId);
          if (!current) {
            fail("session-ended", true);
            return;
          }

          const message: Message = {
            id: randomUUID(),
            text,
            sender,
            originalText: text,
            translation: result.text,
            timestamp: new Date(),
          };
          updateSession(sessionId, { messages: [...current.messages, message] });

          socket.to(room).emit("message:translated", { message, sender });
          reply({ ok: true, message });
        })
        .catch((error) => {
          // The failure is logged; the message content never is.
          console.error(
            `[session] message translation failed: ${error instanceof Error ? error.message : String(error)}`
          );
          fail("translation-failed", true);
        });
    });

    socket.on("disconnect", () => {
      // This socket was evicted by a reconnect takeover: the role is already
      // owned by the newer connection, so presence stays "connected".
      if (socket.data.replaced) return;

      // A reconnecting tab may already hold a fresh socket for this role.
      const stillConnected = [...io.sockets.sockets.values()].some(
        (peer) => peer.id !== socket.id && peer.data.sessionId === sessionId && peer.data.role === role
      );
      if (stillConnected) return;

      if (role === "host") {
        updateSession(sessionId, { hostConnected: false });
        return;
      }
      updateSession(sessionId, { clientConnected: false });
      socket.to(room).emit("participant-disconnected", { connected: false });
    });
  });

  /**
   * Returns the session state for a token holder (never the token itself).
   *
   * Status codes: 404 unknown/expired id, 401 no token, 403 token mismatch.
   * Distinguishing "unknown" from "wrong token" is intentional for
   * development: an id alone grants no access, and the token remains the only
   * secret. No session is ever reachable with another session's token.
   */
  app.get("/api/sessions/:sessionId", (req, res) => {
    const sessionId = req.params.sessionId;
    const session = getSession(sessionId);

    if (!session) {
      res.status(404).json({ error: "Session not found or expired." });
      return;
    }

    const token = readSessionToken(req);
    if (!token) {
      res.status(401).json({ error: "Missing session token." });
      return;
    }
    if (!validateSessionToken(sessionId, token)) {
      res.status(403).json({ error: "Invalid session token." });
      return;
    }

    res.json(toPublicSession(session));
  });

  /**
   * Ends a session: token invalidated, messages and profile dropped from memory,
   * and later access fails. The token is read from the header, or from an
   * `{ token }` body for clients that cannot set headers on DELETE.
   */
  app.delete("/api/sessions/:sessionId", (req, res) => {
    const sessionId = req.params.sessionId;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const session = getSession(sessionId);

    if (!session) {
      res.status(404).json({ error: "Session not found or expired." });
      return;
    }

    const token = readSessionToken(req) || readString(body.token);
    if (!token) {
      res.status(401).json({ error: "Missing session token." });
      return;
    }
    if (!validateSessionToken(sessionId, token)) {
      res.status(403).json({ error: "Invalid session token." });
      return;
    }

    endSession(sessionId);
    res.json({ success: true, sessionId });
  });

  app.post("/api/translate", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const text = readString(body.text);

      if (!text) {
        res.status(400).json({ error: "Field 'text' is required." });
        return;
      }

      // Provider selection stays server side; the client contract is unchanged.
      const sourceLanguage = readString(body.from) || readString(body.sourceLanguage) || "English";
      const targetLanguage = readString(body.to) || readString(body.targetLanguage) || "Swahili";

      const result = await translateText({
        text,
        sourceLanguage,
        targetLanguage,
        context: readString(body.context),
        domain: normalizeDomain(body.domain),
        signal: createRequestSignal(req, res),
      });

      // Diagnostic headers (additive: the JSON body contract is untouched) so a
      // developer can see which engine answered and whether it was validated.
      res.setHeader("X-Translation-Provider", result.provider);
      res.setHeader("X-Translation-Model", result.model);
      res.setHeader("X-Translation-Validated", result.unvalidatedFallback ? "false" : "true");
      res.setHeader("X-Translation-Ms", String(result.durationMs));
      if (result.pivoted) res.setHeader("X-Translation-Pivot", "english");
      if (result.unvalidatedFallback) {
        console.warn(
          `[translation] chat-model fallback used for ${sourceLanguage} -> ${targetLanguage}: ` +
            `no dedicated local MT model is available for this direction. Result is NOT validated.`
        );
      }

      res.json({ translatedText: result.text });
    } catch (error) {
      sendEngineError(res, error, "Translation failed");
    }
  });

  app.post("/api/summarize", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const summary = await summarizeWithLocalModel({
        // Phase 2 clients post "profile" (a domain profile); "patientData" is
        // still accepted so an older client keeps working.
        profile: body.profile ?? body.patientData ?? {},
        conversation: body.conversation,
        domain: body.domain,
      });

      res.json({ summary });
    } catch (error) {
      sendEngineError(res, error, "Summary generation failed");
    }
  });

  app.post("/api/parse-dialogue", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const profile = await extractProfileWithLocalModel({
        conversation: body.conversation,
        domain: body.domain,
        signal: createRequestSignal(req, res),
      });

      res.json(profile);
    } catch (error) {
      sendEngineError(res, error, "Failed to parse dialogue");
    }
  });

  /**
   * Local speech-to-text for the host laptop (Phase 7A) and, since Phase 7C, for
   * the participant phone across the LAN.
   *
   * Audio is posted here, decoded in memory, transcribed by a local engine and
   * dropped: nothing is written to disk, no audio leaves this machine, and the
   * browser never learns which engine or model answered. There is exactly one
   * transcription route - a phone sends the same raw PCM a laptop sends and gets
   * the same answer; it does not have a voice pipeline of its own.
   *
   * Body: raw 16-bit little-endian mono PCM (the browser contract), or a
   * RIFF/WAVE file. `?rate=` states the raw PCM sample rate; everything is
   * resampled to 16 kHz for Whisper.
   *
   * `requireTranscribeAuth` in front of the body parser means a request from
   * another device carries a session token before a byte of audio is read.
   */
  app.post(
    "/api/transcribe",
    requireTranscribeAuth,
    express.raw({
      type: ["application/octet-stream", "audio/wav", "audio/x-wav", "audio/webm"],
      limit: "24mb",
    }),
    async (req, res) => {
      try {
        const language = readString(req.header("x-audio-language")) || readString(req.query.language) || "english";
        if (!isSpeechLanguageSupported(language)) {
          // The requested name is echoed only when it plainly is a language name.
          // The client renders `error` as text, so arbitrary request content - a
          // path, a marker, four thousand characters - must not be reflected back
          // into the response body.
          const trimmed = language.trim();
          const safeName = /^[A-Za-z][A-Za-z -]{1,15}$/.test(trimmed) ? trimmed : "";
          res.status(400).json({
            error: safeName
              ?
                `Local speech-to-text does not support ${safeName} yet. ` +
                "Please type the message instead - text is translated the same way."
              :
                "Local speech-to-text does not support that language yet. " +
                "Please type the message instead - text is translated the same way.",
            code: "unsupported-language",
          });
          return;
        }

        const declaredRate = Number.parseInt(readString(req.query.rate) || readString(req.header("x-audio-rate")), 10);
        const domain = readString(req.query.domain);
        const audio = decodeAudioPayload(req.body as Buffer, {
          declaredRate: Number.isFinite(declaredRate) && declaredRate > 0 ? declaredRate : undefined,
        });

        const result = await transcribeAudio({
          audio,
          language: normalizeSpeechLanguage(language),
          domain,
          signal: createRequestSignal(req, res),
        });

        // Diagnostic headers, matching the translation endpoint's style.
        res.setHeader("X-Transcription-Provider", result.provider);
        res.setHeader("X-Transcription-Model", result.model);
        res.setHeader("X-Transcription-Ms", String(result.durationMs));

        res.json({
          text: result.text,
          provider: result.provider,
          model: result.model,
          durationMs: result.durationMs,
          audioSeconds: Number(result.audioSeconds.toFixed(2)),
        });
      } catch (error) {
        if (isSttError(error)) {
          const status =
            error.code === "cancelled"
              ? 499
              : error.code === "unsupported-language" ||
                  error.code === "too-short" ||
                  error.code === "too-long" ||
                  error.code === "bad-audio" ||
                  // An unintelligible or silent recording is a client-side input
                  // problem, not a service outage.
                  error.code === "empty-transcript"
                ? 400
                : 503;
          if (status !== 499) console.error(`[stt] ${error.code}: ${error.message}`);
          if (!res.headersSent) res.status(status).json({ error: error.message, code: error.code });
          return;
        }

        const message = error instanceof Error ? error.message : String(error);
        console.error(`[stt] unexpected failure: ${message}`);
        if (!res.headersSent) res.status(500).json({ error: "Local transcription failed." });
      }
    }
  );

  /* ------------------------------------------------------------------ */
  /* Local voice playback (Phase 7B, Stage 1)                            */
  /* ------------------------------------------------------------------ */

  /**
   * Speaks one line with the local Pocket TTS worker.
   *
   * Body: `{ text, language, voiceMode }` as JSON. `language` is `english` or
   * `french`, `voiceMode` is `standard`; both are validated here, and a request
   * that asks for anything else is refused rather than guessed at. The response
   * is a complete 16-bit PCM WAV. The audio is generated on this machine and is
   * never written to disk, so there is no file to clean up and no URL that
   * outlives the response.
   */
  app.post("/api/speech/synthesize", async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const speech = await synthesizeSpeech({
        text: body.text,
        language: body.language,
        voiceMode: body.voiceMode ?? "standard",
        signal: createRequestSignal(req, res),
      });

      // Diagnostics, matching the transcription endpoint's style: identifiers
      // and timings only - never the text, never the audio.
      res.setHeader("X-Speech-Provider", speech.provider);
      res.setHeader("X-Speech-Voice", speech.voice);
      res.setHeader("X-Speech-Duration-Ms", String(Math.round(speech.durationSeconds * 1000)));
      res.setHeader("X-Speech-Synthesis-Ms", String(Math.round(speech.synthesisMs)));
      res.setHeader("X-Speech-First-Audio-Ms", String(Math.round(speech.firstAudioMs)));
      if (speech.cached) res.setHeader("X-Speech-Cached", "1");
      if (speech.truncated) res.setHeader("X-Speech-Truncated", "1");

      res.status(200).type("audio/wav").send(speech.audio);
    } catch (error) {
      if (isTtsError(error)) {
        const status =
          error.code === "cancelled"
            ? 499
            : error.code === "unsupported-language" ||
                error.code === "unsupported-voice-mode" ||
                error.code === "text-too-long" ||
                error.code === "empty-text" ||
                error.code === "bad-request"
              ? 400
              : error.code === "busy"
                ? 429
                : error.code === "timeout"
                  ? 504
                  : error.code === "synthesis-failed"
                    ? 500
                    : 503;
        if (status !== 499) console.error(`[tts] ${error.code}: ${error.message}`);
        if (!res.headersSent) res.status(status).json({ error: error.message, code: error.code });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tts] unexpected failure: ${message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: "Local voice playback failed.", code: "synthesis-failed" });
      }
    }
  });

  /* ------------------------------------------------------------------ */
  /* Frontend                                                            */
  /* ------------------------------------------------------------------ */

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  /* ------------------------------------------------------------------ */
  /* Error handling                                                      */
  /* ------------------------------------------------------------------ */

  // Must stay last. Returns JSON (never an HTML stack trace) so malformed
  // requests cannot leak local file paths to a client.
  app.use((error: unknown, _req: express.Request, res: Response, _next: express.NextFunction) => {
    if (res.headersSent) return;

    const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 500;
    const message =
      status === 400
        ? "Malformed JSON request body."
        : status === 413
          ? "Request body too large."
          : "Unexpected server error.";

    console.error(`[api] ${status}: ${error instanceof Error ? error.message : String(error)}`);
    res.status(status).json({ error: message });
  });

  httpServer.listen(PORT, "0.0.0.0", async () => {
    console.log(`Language Doctor running on ${SECURE_SCHEME}://localhost:${PORT}`);
    if (TLS) {
      console.log(
        `LAN HTTPS: on (${TLS.source}) - a phone must have the mkcert root CA installed ` +
          "(one time, see docs/phone-voice-demo.md)"
      );
      for (const origin of lanOrigins()) {
        console.log(`  phone can join at: ${origin}`);
      }
    } else {
      console.log(
        "LAN HTTPS: off (no certificate) - a phone can still pair and type over http://, but its " +
          "browser keeps the microphone closed outside a secure context. Run `npm run cert:lan` once to enable phone voice."
      );
    }
    // Memory-only temporary sessions with a periodic expiry sweep.
    startSessionSweeper();
    const sessionStats = getSessionStats();
    console.log(
      `Temporary sessions: memory-only, ${sessionStats.ttlMinutes}m sliding lifetime (swept every 60s)`
    );
    console.log(`Local AI engine: "${config.model}" via ${config.baseUrl} (no cloud AI provider configured)`);

    const translation = await describeTranslationEngine();
    console.log(
      `Translation engine: ${translation.activeProvider} (selection: ${translation.selection}` +
        `${translation.dedicatedLocalMt.ready ? ", dedicated local MT ready" : ""})`
    );
    if (translation.dedicatedLocalMt.detail) {
      console.log(`Dedicated local MT: ${translation.dedicatedLocalMt.detail}`);
    }

    // Warm the model so the first request of a session is not a cold start.
    void warmUpLocalModel().then((result) => {
      console.log(
        result.ok
          ? `Local model "${config.model}" is warm (ready in ${result.durationMs}ms)`
          : `Local model warm-up skipped: ${result.error}`
      );
    });

    // Local speech-to-text status (host laptop voice input).
    void warmUpStt();

    // Local voice playback status (Phase 7B). Reported only - the worker starts
    // on the first replay, so a session that never uses voice pays nothing.
    void warmUpSpeech();
  });
}

startServer();
