/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "This tab is a participant", remembered across a refresh (Phase 7F).
 *
 * The pairing link is scrubbed from the address bar the moment it is consumed, so
 * the secret never sits in the URL, the history list, or a screenshot. That is the
 * right call, and it had one bad consequence: after a refresh there was no join
 * link left to detect, so the app started as an ordinary operator and a phone that
 * had been a participant five seconds earlier was looking at the host's welcome
 * screen - clinic UI, domain picker, everything a participant must never see.
 *
 * The fix keeps the secret out of the URL and still remembers the role, using two
 * different stores on purpose:
 *
 *   - `sessionStorage` holds the token. It survives a refresh (which is exactly the
 *     case that broke) and dies with the tab, so a closed tab leaves no credential
 *     behind. `localStorage` would be wrong: it would keep a live session token on
 *     a shared or clinic phone indefinitely.
 *   - the URL keeps a non-secret `?p=<session id>` marker. The id is printed on the
 *     host screen and means nothing without the token, but it tells this tab - and
 *     only this tab - that it is a participant and must never render host UI. A
 *     genuine host never has it, so the operator application is unaffected.
 *
 * `spent` is remembered for the same reason: once a session is over, a refresh must
 * go to the dead-link screen rather than starting over as an operator.
 */

const TOKEN_KEY = "language-doc.participant-token";
const SESSION_KEY = "language-doc.participant-session";

/** The query parameter that marks a URL as a participant's, not the host's. */
export const PARTICIPANT_PARAM = "p";

export type ParticipantLinkState = "active" | "spent";

/** Records the pairing credential for this tab only. */
export function rememberParticipantLink(sessionId: string, token: string): void {
  try {
    window.sessionStorage.setItem(TOKEN_KEY, token);
    window.sessionStorage.setItem(SESSION_KEY, sessionId);
  } catch {
    // Storage refused (private mode, blocked site data). The session still works for
    // this page load; only a refresh would forget it, which is a far better failure
    // than an exception on the way into a session.
  }
}

/** Marks the remembered link as finished, so a refresh cannot restart it. */
export function markParticipantLinkSpent(): void {
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
    window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing to do: without storage there was nothing to forget.
  }
}

/** Forgets the participant role entirely, e.g. when the host resets the app. */
export function forgetParticipantLink(): void {
  markParticipantLinkSpent();
}

/**
 * The credential this tab joined with, or null when it has none.
 *
 * The session id must match the one in the URL marker: a stale token from a previous
 * pairing must never be offered to a different session id.
 */
export function readParticipantLink(sessionId: string): { token: string } | null {
  try {
    const token = window.sessionStorage.getItem(TOKEN_KEY);
    const storedSession = window.sessionStorage.getItem(SESSION_KEY);
    if (!token || storedSession !== sessionId) return null;
    return { token };
  } catch {
    return null;
  }
}

/** True when this URL belongs to a participant tab rather than the host app. */
export function participantSessionFromUrl(): string | null {
  const pathMatch = /\/join\/([^/?#]+)/.exec(window.location.pathname);
  if (pathMatch) return decodeURIComponent(pathMatch[1]);

  const legacyId = new URLSearchParams(window.location.search).get("join");
  if (legacyId) return legacyId;

  return new URLSearchParams(window.location.search).get(PARTICIPANT_PARAM);
}
