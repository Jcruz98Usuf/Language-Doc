/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Intelligence engine for Language Doctor (local-first).
 *
 * This module owns the non-translation AI tasks. Translation lives behind the
 * TranslationProvider abstraction in src/server/services/translation/, so the
 * two concerns stay separate:
 *
 *   Intelligence engine (this file)      translation engine (providers)
 *   - summarizeWithLocalModel()          - OllamaTranslationProvider
 *   - extractProfileWithLocalModel()     - LocalMtTranslationProvider
 *
 * Everything runs on the local Ollama runtime through src/server/services/ollama.ts.
 * Nothing here talks to a cloud provider, and no API key is involved.
 *
 * Response shapes preserved for the React client (see src/services/api.ts):
 *
 *   summarizeWithLocalModel()      -> string            (POST /api/summarize)
 *   extractProfileWithLocalModel() -> flat profile JSON (POST /api/parse-dialogue)
 */

import { askModel } from "./ollama";
import { collapseDegenerateRepetition, stripCodeFences } from "./textSanitizer";
import { createEmptyProfile, mergeDomainProfile, toAppDomain } from "../../profile";
import type { DomainProfile } from "../../types";
import { normalizeDomain, type Domain } from "./translation/types";

export type SupportedDomain = Domain;

const MAX_TRANSCRIPT_MESSAGES = 16;
const MAX_TRANSCRIPT_CHARS = 1800;
const MAX_FIELD_LENGTH = 400;
const MAX_LIST_ITEMS = 25;

interface RawMessage {
  sender?: unknown;
  text?: unknown;
  originalText?: unknown;
  translation?: unknown;
}

function toText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/**
 * Flattens the client's message array into a compact, model friendly transcript
 * so a 1.7B local model does not have to parse nested JSON.
 */
export function buildTranscript(conversation: unknown): string {
  const list = Array.isArray(conversation) ? conversation.slice(-MAX_TRANSCRIPT_MESSAGES) : [];
  const lines: string[] = [];

  for (const entry of list) {
    const message = (entry ?? {}) as RawMessage;
    const speaker = message.sender === "patient" ? "CLIENT" : "HOST";
    const original = toText(message.text ?? message.originalText);
    const translation = toText(message.translation);

    if (!original && !translation) continue;
    if (translation && translation !== original) {
      lines.push(`${speaker}: ${original} [translated: ${translation}]`);
    } else {
      lines.push(`${speaker}: ${original || translation}`);
    }
  }

  const transcript = lines.join("\n");
  return transcript.length > MAX_TRANSCRIPT_CHARS ? transcript.slice(-MAX_TRANSCRIPT_CHARS) : transcript;
}

const SUMMARY_SYSTEM: Record<SupportedDomain, string> = {
  clinic: [
    "You are a medical documentation assistant for the Language Doctor clinic bridge.",
    "You write structured intake summaries from a bilingual consultation transcript.",
    "",
    "Rules:",
    "- You are a communication assistant, NOT a doctor. Never diagnose, never suggest tests, medication or treatment, and never add clinical facts that were not spoken.",
    "- Preserve symptoms and medical terminology exactly as recorded.",
    "- Only use facts present in the profile data or the transcript; write \"Not stated\" when a field was never mentioned.",
    "- Keep the tone professional, factual and empathetic.",
    "- Follow the requested output format exactly.",
  ].join("\n"),
  hotel: [
    "You are a hospitality documentation assistant for a hotel and lodge front desk.",
    "You write structured guest booking summaries from a bilingual check-in transcript.",
    "",
    "Rules:",
    "- Only use facts present in the guest profile data or the transcript; write \"Not stated\" when a field was never mentioned.",
    "- Keep room classes, nights, dates, guest names, dietary needs and special requests exactly accurate.",
    "- Keep the tone warm, professional and hospitable.",
    "- Follow the requested output format exactly.",
  ].join("\n"),
  office: [
    "You are an executive documentation assistant for bilingual workplace meetings.",
    "You write concise, actionable meeting summaries from a bilingual sync transcript.",
    "",
    "Rules:",
    "- Only use facts present in the participant data or the transcript; write \"Not stated\" when a field was never mentioned.",
    "- Keep owners, deadlines, decisions and action items precise and unambiguous.",
    "- Keep the tone constructive, professional and concise.",
    "- Follow the requested output format exactly.",
  ].join("\n"),
};

const SUMMARY_TEMPLATE: Record<SupportedDomain, string> = {
  clinic: [
    "Write the intake summary using exactly this format (keep the headings, replace the ellipses):",
    "",
    "PATIENT INTAKE SUMMARY",
    "Name: ...",
    "DOB/Age: ...",
    "Primary Complaint: ...",
    "History of Present Illness: ...",
    "Notes: ...",
  ].join("\n"),
  hotel: [
    "Write the booking summary using exactly this format (keep the headings, replace the ellipses):",
    "",
    "GUEST BOOKING & HOSPITALITY SUMMARY",
    "Guest Name: ...",
    "Stay Duration (Nights): ...",
    "Room Preference: ...",
    "Budget Category: ...",
    "Special Requests & Activities: ...",
    "Overall Hospitality Plan: ...",
  ].join("\n"),
  office: [
    "Write the meeting summary using exactly this format (keep the headings, replace the ellipses):",
    "",
    "OFFICE SYNC & ALIGNMENT SUMMARY",
    "Primary Participant: ...",
    "Department/Role: ...",
    "Meeting Subject: ...",
    "Discussion Context/Topic: ...",
    "Key Decisions/Alignments: ...",
    "Agreed Action Items: ...",
  ].join("\n"),
};

/**
 * Profile extraction instructions (Phase 2).
 *
 * Each domain returns its OWN properties: the guest and office schemas never
 * mention medical fields, and the clinic schema never mentions rooms, stays or
 * action items. Property names match src/types.ts exactly, so a validated
 * answer can be merged straight into app state.
 */
const EXTRACT_PROMPT: Record<SupportedDomain, string> = {
  clinic: [
    "Return one flat JSON object with exactly these properties:",
    '{ "name": "patient full name", "age": "patient age", "gender": "male, female or other", "complaint": "chief health complaint as stated by the patient", "symptoms": ["symptoms mentioned"], "intakeNotes": "other relevant history stated by the patient" }',
    "",
    "Use \"\" for an unknown text property and [] for an unknown list. Do not guess.",
    "If the patient stated no symptoms, return an empty array. Do not diagnose and do not add advice.",
  ].join("\n"),
  hotel: [
    "Return one flat JSON object with exactly these properties:",
    '{ "guestName": "guest name", "duration": "length of stay, for example 3 nights", "roomPreference": "preferred room class or position", "budgetCategory": "Economy, Standard or Luxury", "specialRequests": "dietary needs, activities or other hospitality requests" }',
    "",
    "Use \"\" for an unknown text property and [] for an unknown list. Do not guess.",
    "This is a hotel conversation: never return medical properties such as age, gender, complaint or symptoms.",
  ].join("\n"),
  office: [
    "Return one flat JSON object with exactly these properties:",
    '{ "employeeName": "participant name", "department": "department or team", "meetingSubject": "core topic of the discussion", "workContext": "business problem or context being aligned", "actionItems": ["assigned action items"] }',
    "",
    "Use \"\" for an unknown text property and [] for an unknown list. Do not guess.",
    "This is a workplace conversation: never return medical properties such as age, gender, complaint or symptoms.",
  ].join("\n"),
};

const EXTRACT_SYSTEM: Record<SupportedDomain, string> = {
  clinic:
    "You extract structured facts from a bilingual English/East African clinic conversation. You never diagnose and never add clinical facts that were not spoken.",
  hotel:
    "You extract structured facts from a bilingual English/East African hotel check-in conversation. You never invent guest details.",
  office:
    "You extract structured facts from a bilingual English/East African workplace conversation. You never invent tasks, owners or deadlines.",
};

/* ------------------------------------------------------------------ */
/* Output cleaning (shared helpers live in textSanitizer.ts)           */
/* ------------------------------------------------------------------ */

/** Parses a model answer into a JSON object, tolerating fences and extra prose. */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = stripCodeFences(raw);
  const candidates = [text];

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next candidate
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Profile validation                                                  */
/* ------------------------------------------------------------------ */

/**
 * A validated extraction result is a complete domain profile (Phase 2), so the
 * server response shape and the client state shape are identical and the React
 * layer never re-maps fields.
 */
export type ExtractedProfile = DomainProfile;

// collapseDegenerateRepetition() now lives in ./textSanitizer and is shared with
// the translation providers.

const EMPTY_MARKERS = new Set([
  "",
  "-",
  "n/a",
  "na",
  "nil",
  "none",
  "null",
  "unknown",
  "undefined",
  "not stated",
  "not mentioned",
  "not provided",
  "not specified",
]);

/**
 * Accepted spellings per domain profile field. Aliases only cover *spellings of
 * the same field* (for example "chiefComplaint" for `complaint`); they never map
 * one concept onto another, so a stay length can no longer arrive as `age` and
 * an action item can no longer arrive as a symptom.
 */
const FIELD_ALIASES: Record<SupportedDomain, Record<string, readonly string[]>> = {
  clinic: {
    name: ["name", "patientName", "fullName", "patient"],
    age: ["age", "patientAge"],
    gender: ["gender", "sex"],
    complaint: ["complaint", "chiefComplaint", "primaryComplaint", "reason", "reasonForVisit"],
    symptoms: ["symptoms", "symptomList", "symptomsList"],
    intakeNotes: ["intakeNotes", "notes", "history", "medicalHistory"],
  },
  hotel: {
    guestName: ["guestName", "name", "guest", "fullName"],
    duration: ["duration", "lengthOfStay", "nights", "stayDuration", "stay"],
    roomPreference: ["roomPreference", "room", "preferredRoom", "roomClass", "roomType"],
    budgetCategory: ["budgetCategory", "budget", "budgetClass", "priceRange"],
    specialRequests: ["specialRequests", "requests", "dietary", "diet", "dietaryConstraints", "activities"],
  },
  office: {
    employeeName: ["employeeName", "name", "participant", "presenter", "fullName"],
    department: ["department", "team", "division", "unit"],
    meetingSubject: ["meetingSubject", "subject", "topic", "agenda"],
    workContext: ["workContext", "context", "problem", "challenge", "background"],
    actionItems: ["actionItems", "actions", "tasks", "nextSteps"],
  },
};

const LIST_FIELDS = new Set(["symptoms", "actionItems"]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pickValue(source: Record<string, unknown>, aliases: readonly string[]): unknown {
  const lookup = new Map<string, unknown>();
  for (const [key, value] of Object.entries(source)) {
    lookup.set(normalizeKey(key), value);
  }

  for (const alias of aliases) {
    const value = lookup.get(normalizeKey(alias));
    if (value !== undefined && value !== null) return value;
  }

  return undefined;
}

function normalizeScalar(value: unknown): string {
  const text = toText(value).replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (EMPTY_MARKERS.has(text.toLowerCase())) return "";
  if (/^[.\-–—]+$/.test(text)) return "";
  return text.length > MAX_FIELD_LENGTH ? text.slice(0, MAX_FIELD_LENGTH) : text;
}

function normalizeList(value: unknown): string[] {
  const items: string[] = [];

  const push = (candidate: unknown) => {
    const parts = typeof candidate === "string" ? candidate.split(/\r?\n|;/).filter(Boolean) : [candidate];
    for (const part of parts) {
      const text = normalizeScalar(part);
      if (!text) continue;
      if (items.some((existing) => existing.toLowerCase() === text.toLowerCase())) continue;
      items.push(text);
    }
  };

  if (Array.isArray(value)) {
    value.forEach(push);
  } else if (value !== undefined && value !== null) {
    push(value);
  }

  return items.slice(0, MAX_LIST_ITEMS);
}

/** Unwraps a profile the model nested one level deep, for example { "profile": { ... } }. */
function unwrapProfile(raw: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(raw);
  if (keys.length !== 1) return raw;
  const only = raw[keys[0]];
  if (only && typeof only === "object" && !Array.isArray(only)) {
    return only as Record<string, unknown>;
  }
  return raw;
}

/**
 * Validates model output before it reaches application state (Phase 2).
 *
 * Empty values are deliberately dropped: the client merges every extraction into
 * the confirmed profile, so keeping blanks would erase information the operator
 * already confirmed. Missing information is never invented here.
 *
 * The result is always a complete domain profile (correct discriminant, every
 * field present, `""` / `[]` where nothing was found) so it satisfies
 * src/types.ts without any client-side re-mapping.
 */
export function coerceProfile(domain: SupportedDomain, raw: Record<string, unknown>): ExtractedProfile {
  const source = unwrapProfile(raw);
  const extracted: Record<string, unknown> = {};

  for (const [field, aliases] of Object.entries(FIELD_ALIASES[domain])) {
    const value = pickValue(source, aliases);
    if (value === undefined) continue;

    if (LIST_FIELDS.has(field)) {
      const list = normalizeList(value);
      if (list.length) extracted[field] = list;
      continue;
    }

    const text = normalizeScalar(value);
    if (text) extracted[field] = text;
  }

  return mergeDomainProfile(toAppDomain(domain), null, extracted);
}

function safeJson(value: unknown, max = 2000): string {
  if (value === undefined || value === null) return "{}";
  try {
    const json = JSON.stringify(value);
    return json.length > max ? `${json.slice(0, max)}...` : json;
  } catch {
    return "{}";
  }
}

/* ------------------------------------------------------------------ */
/* Local AI tasks (kept in sync with the existing HTTP contracts)      */
/* ------------------------------------------------------------------ */

export interface SummarizeRequest {
  profile?: unknown;
  conversation: unknown;
  domain?: unknown;
}

/** Structured end-of-session document generated by the local model. */
export async function summarizeWithLocalModel(input: SummarizeRequest): Promise<string> {
  const domain = normalizeDomain(input.domain);
  const transcript = buildTranscript(input.conversation);

  const profileLabel =
    domain === "hotel"
      ? "Guest profile data (may be incomplete):"
      : domain === "office"
        ? "Participant profile data (may be incomplete):"
        : "Patient profile data (may be incomplete):";

  const userPrompt = [
    SUMMARY_TEMPLATE[domain],
    "",
    profileLabel,
    safeJson(input.profile),
    "",
    transcript ? "Conversation transcript:" : "Conversation transcript: (no conversation was recorded)",
    transcript || "(empty)",
  ].join("\n");

  const { text } = await askModel({
    messages: [
      { role: "system", content: SUMMARY_SYSTEM[domain] },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
    maxOutputTokens: 300,
  });

  return collapseDegenerateRepetition(stripCodeFences(text));
}

export interface ExtractProfileRequest {
  conversation: unknown;
  domain?: unknown;
  /** Caller supplied cancellation, so a superseded extraction frees the model. */
  signal?: AbortSignal;
}

/**
 * Extraction must never compete with translation for the model. Two small
 * guards keep it cheap:
 *
 *  - identical transcripts are never re-extracted back to back (short TTL
 *    result cache), which is what happens when the UI re-fires extraction
 *    without new messages;
 *  - identical *concurrent* requests are coalesced into one model call.
 *
 * Requests carrying an AbortSignal (the HTTP path) are always executed
 * separately so that cancelling one really does cancel its model call.
 */
const EXTRACTION_RESULT_TTL_MS = 15_000;
const EXTRACTION_CACHE_LIMIT = 50;
const recentExtractions = new Map<string, { at: number; value: ExtractedProfile }>();
const inFlightExtractions = new Map<string, Promise<ExtractedProfile>>();

function fingerprint(domain: SupportedDomain, transcript: string): string {
  // FNV-1a: stable, dependency free, and only ever used as an in-memory key.
  let hash = 2166136261;
  for (let index = 0; index < transcript.length; index += 1) {
    hash ^= transcript.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${domain}:${(hash >>> 0).toString(36)}:${transcript.length}`;
}

function rememberExtraction(key: string, value: ExtractedProfile): void {
  if (recentExtractions.size >= EXTRACTION_CACHE_LIMIT) {
    const oldest = recentExtractions.keys().next().value;
    if (oldest !== undefined) recentExtractions.delete(oldest);
  }
  recentExtractions.set(key, { at: Date.now(), value });
}

/**
 * Extracts profile details from the live conversation with the local model.
 * Returns a validated flat profile. Unparsable answers log a warning and yield
 * an empty object instead of breaking the conversation flow.
 */
export async function extractProfileWithLocalModel(input: ExtractProfileRequest): Promise<ExtractedProfile> {
  const domain = normalizeDomain(input.domain);
  const transcript = buildTranscript(input.conversation);
  // Nothing was said: return an empty profile of the right shape. Merging it
  // into state is a no-op, so confirmed information is never touched.
  if (!transcript) return createEmptyProfile(toAppDomain(domain));

  const key = fingerprint(domain, transcript);
  const cancellable = input.signal !== undefined;

  if (!cancellable) {
    const cached = recentExtractions.get(key);
    if (cached && Date.now() - cached.at < EXTRACTION_RESULT_TTL_MS) return cached.value;

    const running = inFlightExtractions.get(key);
    if (running) return running;
  }

  const task = runExtraction(domain, transcript, input.signal);

  if (!cancellable) {
    inFlightExtractions.set(key, task);
    void task
      .then((value) => rememberExtraction(key, value))
      .catch(() => undefined)
      .finally(() => inFlightExtractions.delete(key));
  }

  return task;
}

async function runExtraction(
  domain: SupportedDomain,
  transcript: string,
  signal?: AbortSignal
): Promise<ExtractedProfile> {
  const userPrompt = [
    EXTRACT_PROMPT[domain],
    "",
    "Conversation transcript:",
    transcript,
    "",
    "Return only the JSON object.",
  ].join("\n");

  const { text } = await askModel({
    messages: [
      { role: "system", content: EXTRACT_SYSTEM[domain] },
      { role: "user", content: userPrompt },
    ],
    jsonMode: true,
    temperature: 0,
    maxOutputTokens: 220,
    signal,
  });

  const parsed = extractJsonObject(text);
  if (!parsed) {
    // That answer is built from the conversation, so it is not logged - not even a
    // 200-character excerpt, because it can contain the patient's own words and
    // complaints. The log records what kind of answer came back (how long, what it
    // opened with), which is what makes the failure diagnosable, and the caller gets
    // an empty profile: guessing from a broken answer would be worse than saying
    // nothing was extracted.
    const trimmed = text.trim();
    const opening = trimmed.length > 0 ? JSON.stringify(trimmed.slice(0, 1)) : '""';
    console.warn(
      `[local-ai] ${domain} profile extraction returned unparsable JSON (${trimmed.length} chars, opening ${opening})`
    );
    return createEmptyProfile(toAppDomain(domain));
  }

  return coerceProfile(domain, parsed);
}

