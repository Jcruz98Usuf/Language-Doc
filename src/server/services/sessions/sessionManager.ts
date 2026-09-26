/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Temporary session manager (Phase 3) - memory only.
 *
 * Design:
 *  - a plain Map<string, TranslationSession>; NO database and nothing is
 *    intentionally written to disk (no transcripts, no audio, no profile data);
 *  - the visible session id is short so it can be dictated by hand
 *    ("LD-K7P4X2") and never encodes personal information;
 *  - the security token is a separate 32-byte cryptographic secret and is
 *    compared in constant time;
 *  - sessions expire (sliding lifetime, plus an absolute cap) and a periodic
 *    sweep deletes them along with their messages and profile data;
 *  - logging is operational only: created / ended / swept counts. Never message
 *    content, never profile fields, never the token.
 *
 * validateSessionToken() is a plain function with no Express coupling so the
 * future Socket.IO handshake can reuse it unchanged.
 */

import crypto from "crypto";
import type {
  CreateSessionOptions,
  PublicSession,
  SessionConfig,
  SessionStats,
  TranslationSession,
  UpdateSessionPatch,
} from "./types";

/**
 * Unambiguous alphabet (no I, O, 0 or 1) so an id survives being read aloud or
 * written down. 32^6 ≈ 1.07e9 combinations, combined with a lookup retry.
 */
const ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ID_PREFIX = "LD-";
const ID_LENGTH = 6;
const MAX_ID_ATTEMPTS = 25;
const TOKEN_BYTES = 32;

const sessions = new Map<string, TranslationSession>();
let sweepTimer: ReturnType<typeof setInterval> | null = null;

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Lifetime policy: a sliding idle TTL (SESSION_TTL_MINUTES, default 30) that is
 * refreshed by activity, capped by an absolute maximum
 * (SESSION_ABSOLUTE_TTL_MINUTES, default 4x the TTL) so a session cannot live
 * forever just because someone keeps polling it.
 */
export function getSessionConfig(): SessionConfig {
  const ttlMinutes = positiveNumber(process.env.SESSION_TTL_MINUTES, 30);
  const absoluteTtlMinutes = Math.max(
    ttlMinutes,
    positiveNumber(process.env.SESSION_ABSOLUTE_TTL_MINUTES, ttlMinutes * 4)
  );
  return { ttlMinutes, absoluteTtlMinutes, sweepIntervalMs: 60_000 };
}

/** Cryptographically random, human readable session id ("LD-K7P4X2"). */
function generateSessionId(): string {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
    let id = ID_PREFIX;
    for (let index = 0; index < ID_LENGTH; index += 1) {
      id += ID_ALPHABET[crypto.randomInt(0, ID_ALPHABET.length)];
    }
    if (!sessions.has(id)) return id;
  }
  // Practically unreachable; fail loudly rather than reuse an id.
  throw new Error("Could not allocate a unique session id.");
}

function generateToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Constant-time token comparison; length differences short-circuit safely. */
function tokensMatch(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

export function createSession(options: CreateSessionOptions): { session: TranslationSession } {
  const config = getSessionConfig();
  const now = Date.now();
  const lifetimeMs = options.ttlMs && options.ttlMs > 0 ? options.ttlMs : config.ttlMinutes * 60_000;

  const session: TranslationSession = {
    id: generateSessionId(),
    token: generateToken(),
    createdAt: now,
    expiresAt: now + lifetimeMs,
    domain: options.domain,
    localLanguage: options.localLanguage,
    messages: [],
    hostConnected: true,
    clientConnected: false,
    profile: options.profile ?? null,
  };

  sessions.set(session.id, session);
  // Operational log only: no token, no content. Sub-minute lifetimes are shown
  // in seconds so a short test TTL does not display as "0m".
  const lifetimeLabel =
    lifetimeMs >= 60_000 ? `${Math.round(lifetimeMs / 60_000)}m` : `${Math.max(1, Math.round(lifetimeMs / 1000))}s`;
  console.log(`[session] created ${session.id} (${session.domain}, expires in ${lifetimeLabel})`);
  return { session };
}

/** Returns the live session, or null when it is unknown or already expired. */
export function getSession(sessionId: string): TranslationSession | null {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    dropSession(session, "expired");
    return null;
  }
  return session;
}

/**
 * Plain, framework-free validation used by the HTTP routes now and by the
 * Socket.IO handshake later. Never throws.
 */
export function validateSessionToken(sessionId: unknown, token: unknown): boolean {
  if (typeof sessionId !== "string" || typeof token !== "string") return false;
  if (!sessionId || !token) return false;

  const session = sessions.get(sessionId);
  if (!session) return false;
  if (session.expiresAt <= Date.now()) {
    dropSession(session, "expired");
    return false;
  }
  return tokensMatch(session.token, token);
}

/** Everything a token holder may see - never the token itself. */
export function toPublicSession(session: TranslationSession): PublicSession {
  return {
    sessionId: session.id,
    domain: session.domain,
    localLanguage: session.localLanguage,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    hostConnected: session.hostConnected,
    clientConnected: session.clientConnected,
    messages: session.messages,
  };
}

/**
 * Applies a patch and refreshes the sliding expiry, bounded by the absolute cap.
 * Returns the updated session, or null when it is gone or already expired.
 */
export function updateSession(sessionId: string, patch: UpdateSessionPatch): TranslationSession | null {
  const session = getSession(sessionId);
  if (!session) return null;

  if (patch.messages) session.messages = patch.messages;
  if (patch.profile !== undefined) session.profile = patch.profile;
  if (patch.hostConnected !== undefined) session.hostConnected = patch.hostConnected;
  if (patch.clientConnected !== undefined) session.clientConnected = patch.clientConnected;

  const config = getSessionConfig();
  const absoluteDeadline = session.createdAt + config.absoluteTtlMinutes * 60_000;
  session.expiresAt = Math.min(Date.now() + config.ttlMinutes * 60_000, absoluteDeadline);
  return session;
}

/**
 * Clears the session's data from memory and forgets it. Used by DELETE and by
 * the expiry sweep - the transcript and profile are released here, not merely
 * flagged as inactive.
 */
export type SessionRemovalReason = "expired" | "ended";
type SessionRemovalListener = (sessionId: string, reason: SessionRemovalReason) => void;
const removalListeners = new Set<SessionRemovalListener>();

/**
 * Notified whenever a session leaves the map (DELETE, TTL sweep, or lazy
 * expiry on access). The server uses this to broadcast `session:ended` to
 * paired devices and disconnect their sockets. Returns an unsubscribe function.
 */
export function onSessionRemoved(listener: SessionRemovalListener): () => void {
  removalListeners.add(listener);
  return () => {
    removalListeners.delete(listener);
  };
}

function dropSession(session: TranslationSession, reason: SessionRemovalReason): void {
  session.messages = [];
  session.profile = null;
  session.token = "";
  sessions.delete(session.id);

  // Operational log only: id and reason, never content.
  console.log(`[session] ${reason === "ended" ? "ended" : "expired"} ${session.id}`);

  for (const listener of removalListeners) {
    try {
      listener(session.id, reason);
    } catch (error) {
      console.error(`[session] removal listener failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Ends a session: token invalidated, messages and profile dropped. */
export function endSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  dropSession(session, "ended");
  return true;
}

/** Removes every expired session. Returns how many were swept. */
export function cleanupExpiredSessions(): number {
  const now = Date.now();
  let removed = 0;

  for (const session of [...sessions.values()]) {
    if (session.expiresAt <= now) {
      dropSession(session, "expired");
      removed += 1;
    }
  }

  if (removed > 0) {
    // Count only - no ids, no content, no tokens.
    console.log(`[session] sweep removed ${removed} expired session(s)`);
  }
  return removed;
}

export function getSessionCount(): number {
  return sessions.size;
}

/** Health payload: readiness and a count - never a token or session content. */
export function getSessionStats(): SessionStats {
  return { status: "ready", activeCount: sessions.size, ttlMinutes: getSessionConfig().ttlMinutes };
}

/** Starts the periodic sweep. The timer is unref'd so it never blocks exit. */
export function startSessionSweeper(): void {
  if (sweepTimer) return;
  const { sweepIntervalMs } = getSessionConfig();
  sweepTimer = setInterval(() => cleanupExpiredSessions(), sweepIntervalMs);
  sweepTimer.unref();
}

export function stopSessionSweeper(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}
