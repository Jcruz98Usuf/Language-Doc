/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Temporary session types (Phase 3).
 *
 * Memory only: nothing here is written to disk, and no personal information is
 * ever encoded in a session id.
 */

import type { AppDomain, DomainProfile, Language, Message } from "../../../types";

export interface TranslationSession {
  /** Short, human communicable id, for example "LD-K7P4X2". No personal data. */
  id: string;
  /** Separate cryptographic secret. Never rendered; authenticated API calls never accept it from a URL. */
  token: string;

  createdAt: number;
  expiresAt: number;

  domain: AppDomain;
  localLanguage: Language;

  messages: Message[];

  hostConnected: boolean;
  clientConnected: boolean;

  /**
   * The device that owns the client (participant) role, or null before anyone has
   * claimed it. A random per-browser identifier, never a person: it exists so the
   * session can tell "the phone that joined" from "a different phone holding the
   * same link", and it survives disconnections on purpose - see claimClientRole().
   */
  clientId: string | null;

  /**
   * Temporary structured profile for this session. Kept here (not only in the
   * browser) so endSession() can also drop it from server memory.
   */
  profile: DomainProfile | null;
}

/** What a caller that already holds a valid token may see. Never the token. */
export interface PublicSession {
  sessionId: string;
  domain: AppDomain;
  localLanguage: Language;
  createdAt: number;
  expiresAt: number;
  hostConnected: boolean;
  clientConnected: boolean;
  messages: Message[];
}

export interface CreateSessionOptions {
  domain: AppDomain;
  localLanguage: Language;
  profile?: DomainProfile | null;
  /** Diagnostic/test override for the lifetime, in milliseconds. */
  ttlMs?: number;
}

export interface UpdateSessionPatch {
  messages?: Message[];
  profile?: DomainProfile | null;
  hostConnected?: boolean;
  clientConnected?: boolean;
}

export interface SessionConfig {
  /** Sliding lifetime in minutes (SESSION_TTL_MINUTES, default 30). */
  ttlMinutes: number;
  /** Hard cap on total lifetime (SESSION_ABSOLUTE_TTL_MINUTES, default 4x TTL). */
  absoluteTtlMinutes: number;
  /** How often expired sessions are swept (default every 60s). */
  sweepIntervalMs: number;
}

export interface SessionStats {
  status: "ready";
  activeCount: number;
  ttlMinutes: number;
}
