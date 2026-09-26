/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared domain-profile helpers (Phase 2).
 *
 * Imported by both the React client and the server-side intelligence engine, so
 * this module deliberately has no Node or DOM dependencies.
 *
 * It owns three things:
 *   - the per-domain field lists that drive validation and merging;
 *   - "no information" detection, so an empty extraction can never erase a
 *     value the operator already confirmed;
 *   - the domain-aware safe merge used by the app state update path.
 */

import { AppDomain, DomainProfile } from "./types";

/** Values a model uses to mean "I found nothing". They are never authoritative. */
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
  "not available",
]);

const SCALAR_FIELDS: Record<AppDomain, readonly string[]> = {
  [AppDomain.CLINIC]: ["name", "age", "gender", "complaint", "intakeNotes"],
  [AppDomain.HOTEL]: ["guestName", "duration", "roomPreference", "budgetCategory", "specialRequests"],
  [AppDomain.OFFICE]: ["employeeName", "department", "meetingSubject", "workContext"],
};

const LIST_FIELDS: Record<AppDomain, readonly string[]> = {
  [AppDomain.CLINIC]: ["symptoms"],
  [AppDomain.HOTEL]: [],
  [AppDomain.OFFICE]: ["actionItems"],
};

/** Maps the wire string ("clinic" | "hotel" | "office") onto the enum. */
export function toAppDomain(value: unknown): AppDomain {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "hotel") return AppDomain.HOTEL;
  if (text === "office") return AppDomain.OFFICE;
  return AppDomain.CLINIC;
}

export function isMeaningfulText(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (EMPTY_MARKERS.has(text.toLowerCase())) return false;
  return !/^[.\-–—]+$/.test(text);
}

export function normalizeProfileText(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return isMeaningfulText(text) ? text : "";
}

export function normalizeProfileList(value: unknown): string[] {
  const items: string[] = [];

  const push = (candidate: unknown) => {
    const parts = typeof candidate === "string" ? candidate.split(/\r?\n|;/).filter(Boolean) : [candidate];
    for (const part of parts) {
      const text = normalizeProfileText(part);
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

  return items;
}

/** The one complete, validated shape of a profile for a given domain. */
export function createEmptyProfile(domain: AppDomain): DomainProfile {
  switch (domain) {
    case AppDomain.HOTEL:
      return {
        domain: AppDomain.HOTEL,
        guestName: "",
        duration: "",
        roomPreference: "",
        budgetCategory: "",
        specialRequests: "",
      };
    case AppDomain.OFFICE:
      return {
        domain: AppDomain.OFFICE,
        employeeName: "",
        department: "",
        meetingSubject: "",
        workContext: "",
        actionItems: [],
      };
    default:
      return {
        domain: AppDomain.CLINIC,
        name: "",
        age: "",
        gender: "",
        complaint: "",
        symptoms: [],
      };
  }
}

/** True when the profile holds no confirmed information at all. */
export function isProfileEmpty(profile: DomainProfile | null | undefined): boolean {
  if (!profile) return true;
  const record = profile as unknown as Record<string, unknown>;

  for (const field of SCALAR_FIELDS[profile.domain]) {
    if (normalizeProfileText(record[field])) return false;
  }
  for (const field of LIST_FIELDS[profile.domain]) {
    if (normalizeProfileList(record[field]).length) return false;
  }
  return true;
}

/** Output name used by Header/Sidebar, independent of the active domain. */
export function profilePrimaryName(profile: DomainProfile | null | undefined): string {
  if (!profile) return "";
  const record = profile as unknown as Record<string, unknown>;
  switch (profile.domain) {
    case AppDomain.HOTEL:
      return normalizeProfileText(record.guestName);
    case AppDomain.OFFICE:
      return normalizeProfileText(record.employeeName);
    default:
      return normalizeProfileText(record.name);
  }
}

/**
 * Returns the stored profile only when it belongs to the active domain. A domain
 * switch therefore invalidates the previous profile instead of letting hotel
 * data show up in clinic mode.
 */
export function activeProfileFor(
  domain: AppDomain,
  profile: DomainProfile | null | undefined
): DomainProfile | null {
  return profile && profile.domain === domain ? profile : null;
}

/**
 * Domain-aware safe merge.
 *
 * Rules (Phase 2):
 *  - empty / placeholder extractions never erase a confirmed value
 *    (existing.name = "Jackson" + new.name = "" -> "Jackson");
 *  - list fields keep their previous items unless the extraction produced new
 *    ones;
 *  - fields the operator typed into the intake form (`lockedFields`) outrank
 *    uncertain AI extraction;
 *  - a profile from another domain is discarded, never merged;
 *  - the discriminant is always the active domain, so a malformed model answer
 *    cannot relabel the profile.
 */
export function mergeDomainProfile(
  domain: AppDomain,
  existing: DomainProfile | null | undefined,
  incoming: unknown,
  options: { lockedFields?: readonly string[] } = {}
): DomainProfile {
  const base = existing && existing.domain === domain ? (existing as unknown as Record<string, unknown>) : {};
  const source = (incoming ?? {}) as Record<string, unknown>;
  const locked = new Set(options.lockedFields ?? []);
  const result = createEmptyProfile(domain) as unknown as Record<string, unknown>;

  for (const field of SCALAR_FIELDS[domain]) {
    const extracted = normalizeProfileText(source[field]);
    const previous = normalizeProfileText(base[field]);
    result[field] = extracted && !locked.has(field) ? extracted : previous;
  }

  for (const field of LIST_FIELDS[domain]) {
    const extracted = normalizeProfileList(source[field]);
    result[field] = extracted.length ? extracted : normalizeProfileList(base[field]);
  }

  result.domain = domain;
  return result as unknown as DomainProfile;
}

/**
 * Back-door placeholder used when an operator skips the intake wizard: the
 * conversation starts straight away and the AI keeps filling the profile.
 * Values are domain specific, no medical property is reused.
 */
export function createPlaceholderProfile(domain: AppDomain): DomainProfile {
  switch (domain) {
    case AppDomain.HOTEL:
      return {
        ...(createEmptyProfile(AppDomain.HOTEL) as Extract<DomainProfile, { domain: AppDomain.HOTEL }>),
        guestName: "Active Session Visitor",
        roomPreference: "Stay initiated directly",
      };
    case AppDomain.OFFICE:
      return {
        ...(createEmptyProfile(AppDomain.OFFICE) as Extract<DomainProfile, { domain: AppDomain.OFFICE }>),
        employeeName: "Active Session Participant",
        meetingSubject: "Session initiated directly",
      };
    default:
      return {
        ...(createEmptyProfile(AppDomain.CLINIC) as Extract<DomainProfile, { domain: AppDomain.CLINIC }>),
        name: "Active Session Visitor",
        complaint: "Consultation initiated directly",
      };
  }
}
