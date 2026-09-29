/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Who this browser is, for a session's client (participant) role.
 *
 * A random, per-browser identifier that means nothing and names nobody: the pairing
 * token still proves the session, and this only lets the server tell "the phone that
 * joined" from "a different phone holding the same link". The join link travels by
 * QR code and can be photographed, be in a browser history, or be typed in by
 * someone else; the device identifier is what makes the role belong to one device
 * for the life of the session.
 *
 * Stored in `localStorage` rather than `sessionStorage`, and the difference is the
 * whole reason this works in a clinic: `sessionStorage` dies with the tab, and a
 * phone browser discards backgrounded tabs under memory pressure. A participant who
 * left with "Not now" - or whose phone locked and was evicted - has to be able to
 * rejoin with the same link, and a tab that came back empty would look like a
 * different device and be refused. `localStorage` survives both cases and is still
 * per-browser: another browser, another profile, or a private tab has its own
 * storage and is a different device as far as the server is concerned. That
 * limitation is documented in docs/phone-voice-demo.md.
 */

const STORAGE_KEY = "language-doc.participant-device";

let cached: string | null = null;

/**
 * 128 bits of randomness as hex. `crypto.getRandomValues` is available on insecure
 * origins too (unlike `crypto.subtle`), but the fallback keeps a page that somehow
 * has no Web Crypto working instead of throwing on the way into a session.
 */
function randomDeviceId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * This browser's participant identifier, created on first use and reused after.
 *
 * Cached in memory as well as in storage, so every socket this page opens names the
 * same device even if storage becomes unavailable later.
 */
export function participantDeviceId(): string {
  if (cached) return cached;

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      cached = stored;
      return stored;
    }
    const created = randomDeviceId();
    window.localStorage.setItem(STORAGE_KEY, created);
    cached = created;
    return created;
  } catch {
    // Site data can be refused (private modes, blocked storage). The session still
    // works; the identity simply lives as long as this page, which means a reload
    // may look like a different device and be treated as one.
    cached = randomDeviceId();
    return cached;
  }
}