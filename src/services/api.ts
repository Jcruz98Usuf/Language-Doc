import { AppDomain, DomainProfile, Language, Message } from "../types";

/**
 * Thin client for the local-first Express API. Every AI task is executed by the
 * local Ollama runtime behind these endpoints, so no API keys are involved.
 */
async function postJson(path: string, body: unknown, fallbackMessage: string): Promise<any> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    // Surface the local engine's own message (for example "Local AI engine
    // unreachable") in the existing conversation error banner.
    let detail = "";
    try {
      const payload = (await response.json()) as { error?: unknown };
      if (typeof payload?.error === "string") detail = payload.error;
    } catch {
      detail = "";
    }
    throw new Error(detail || fallbackMessage);
  }

  return (await response.json()) as Record<string, any>;
}

export async function translateText(text: string, from: Language, to: Language, context?: string, domain?: string) {
  const data = await postJson("/api/translate", { text, from, to, context, domain }, "Translation failed");
  return data.translatedText;
}

export async function generateSummary(profile: DomainProfile | null, conversation: Message[], domain?: string) {
  const data = await postJson(
    "/api/summarize",
    { profile, conversation, domain },
    "Summary generation failed"
  );
  return data.summary;
}

/**
 * Structured profile extraction. The response is a complete domain profile
 * (Phase 2 discriminated union), already validated server side, so callers can
 * merge it without re-mapping fields.
 */
export async function parseDialogue(conversation: Message[], domain: string): Promise<DomainProfile> {
  return (await postJson("/api/parse-dialogue", { conversation, domain }, "Dialogue extraction failed")) as DomainProfile;
}

/* ------------------------------------------------------------------ */
/* Temporary private sessions (Phase 3)                                */
/* ------------------------------------------------------------------ */

/**
 * The session token is sent in the `x-session-token` header (documented
 * contract): ordinary API calls never place it in a URL or render it in the UI.
 */
export interface SessionHandle {
  sessionId: string;
  token: string;
  expiresAt: number;
  /** Primary LAN join link (`/join/<id>`), or null when no origin is known. */
  joinUrl?: string | null;
  /** Every detected join origin (HOST_URL override first, then LAN IPs). */
  joinUrls?: string[];
}

export interface PublicSession {
  sessionId: string;
  domain: string;
  localLanguage: string;
  createdAt: number;
  expiresAt: number;
  hostConnected: boolean;
  clientConnected: boolean;
  messages: unknown[];
}

/** Creates a temporary private session. Returns null when the server refuses. */
export async function createSession(
  domain: AppDomain,
  localLanguage: Language
): Promise<SessionHandle | null> {
  try {
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain, localLanguage }),
    });
    if (!response.ok) return null;
    return (await response.json()) as SessionHandle;
  } catch {
    return null;
  }
}

export async function fetchSession(sessionId: string, token: string): Promise<PublicSession | null> {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { "x-session-token": token },
    });
    if (!response.ok) return null;
    return (await response.json()) as PublicSession;
  } catch {
    return null;
  }
}

/** Ends a session: the server invalidates the token and drops its data. */
export async function endSession(sessionId: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      headers: { "x-session-token": token },
    });
    return response.ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Local speech-to-text (Phase 7A)                                     */
/* ------------------------------------------------------------------ */

export interface TranscriptionResult {
  text: string;
  provider: string;
  model: string;
  durationMs: number;
  audioSeconds: number;
}

/**
 * Sends locally recorded audio to the local speech-to-text engine.
 *
 * The clip is posted as raw 16-bit PCM. Transcription happens on this machine
 * (Whisper through the local engine) and the browser is never told which model
 * answered; the server records the numbers it needs for diagnostics only.
 * Nothing is stored: the server decodes the audio, transcribes it and drops it.
 *
 * `language` must be one the local engine supports (English, French, Swahili);
 * anything else is refused server side with a message the UI shows verbatim.
 */
export async function transcribeAudio(
  clip: { pcm16: Int16Array; sampleRate: number },
  language: string,
  domain?: string
): Promise<string> {
  const query = new URLSearchParams({
    language,
    rate: String(clip.sampleRate || 16000),
  });
  if (domain) query.set("domain", domain);

  const response = await fetch(`/api/transcribe?${query.toString()}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "x-audio-language": language,
    },
    body: new Uint8Array(clip.pcm16.buffer, clip.pcm16.byteOffset, clip.pcm16.byteLength),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const payload = (await response.json()) as { error?: unknown };
      if (typeof payload?.error === "string") detail = payload.error;
    } catch {
      detail = "";
    }
    throw new Error(detail || "Local transcription failed.");
  }

  const data = (await response.json()) as TranscriptionResult;
  return data.text;
}

/** Capability states shown as demo badges (CORE / DEMO READY / EXPERIMENTAL). */
export interface LanguageCapability {
  language: string;
  role: "pivot" | "demo" | "experimental";
  state: "supported" | "experimental" | "unavailable";
  provider: string | null;
  detail: string;
  directions: string[];
}

export interface CapabilitiesResponse {
  pivot: string;
  languages: LanguageCapability[];
}

/**
 * Reads which languages are validated for the demo. Failure is non-fatal: the
 * conversation UI keeps working and simply shows no capability badge.
 */
export async function fetchCapabilities(): Promise<CapabilitiesResponse | null> {
  try {
    const response = await fetch("/api/capabilities");
    if (!response.ok) return null;
    return (await response.json()) as CapabilitiesResponse;
  } catch {
    return null;
  }
}
