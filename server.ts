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
import { Language, Message } from "./src/types";
import {
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
 * Origins offered for private-session join links (`/join/<id>`).
 *
 * `HOST_URL`, when set, is listed first as an explicit override; every
 * non-internal, non-link-local IPv4 address of this machine follows so a phone
 * on the same LAN can scan without any configuration. Loopback is never
 * offered - it is unreachable from another device.
 */
function buildJoinUrls(sessionId: string): string[] {
  const origins: string[] = [];
  if (HOST_URL) origins.push(HOST_URL);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      origins.push(`http://${entry.address}:${PORT}`);
    }
  }
  const uniqueOrigins = [...new Set(origins)];
  const joinPath = `/join/${encodeURIComponent(sessionId)}`;
  return uniqueOrigins.map((origin) => `${origin}${joinPath}`);
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
function readSessionToken(req: Request): string {
  const header = readString(req.header("x-session-token"));
  if (header) return header;

  const authorization = readString(req.header("authorization"));
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? match[1].trim() : "";
}

/** Maps a client supplied language name onto the Language enum. */
function readLanguage(value: unknown): Language {
  const text = readString(value).toLowerCase();
  const match = Object.values(Language).find((language) => language.toLowerCase() === text);
  return match ?? Language.SWAHILI;
}

async function startServer(): Promise<void> {
  const app = express();
  const httpServer = createServer(app);
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

  io.use((socket, next) => {
    const { sessionId, token, role } = socket.handshake.auth as Record<string, unknown>;
    if ((role !== "host" && role !== "participant") || !validateSessionToken(sessionId, token)) {
      next(new Error("Unauthorized private session."));
      return;
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
   * Local speech-to-text for the HOST laptop (Phase 7A).
   *
   * Audio is posted here, decoded in memory, transcribed by a local engine and
   * dropped: nothing is written to disk, no audio leaves this machine, and the
   * browser never learns which engine or model answered.
   *
   * Body: raw 16-bit little-endian mono PCM (the browser contract), or a
   * RIFF/WAVE file. `?rate=` states the raw PCM sample rate; everything is
   * resampled to 16 kHz for Whisper.
   */
  app.post(
    "/api/transcribe",
    express.raw({
      type: ["application/octet-stream", "audio/wav", "audio/x-wav", "audio/webm"],
      limit: "24mb",
    }),
    async (req, res) => {
      try {
        const language = readString(req.header("x-audio-language")) || readString(req.query.language) || "english";
        if (!isSpeechLanguageSupported(language)) {
          res.status(400).json({
            error:
              `Local speech-to-text does not support ${language} yet. ` +
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
    console.log(`Language Doctor running on http://localhost:${PORT}`);
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
  });
}

startServer();
