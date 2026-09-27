/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Model tier: structured extraction through the Intelligence Engine.
 *
 * `/api/parse-dialogue` is where a language model writes into app state: whatever it
 * returns becomes the patient, guest or employee profile the user sees and that the
 * summary is built from. Two things must stay true, and only a real model run can
 * show it:
 *
 *   - the answer is a complete profile of the *right* domain, and
 *   - it carries facts that were actually spoken, and none the model invented.
 *
 * The assertions are about facts that were said in the transcript, plus the absence
 * of facts that were not. Exact wording is not asserted: the model is asked to
 * normalise, and a test that pinned its phrasing would be rewritten every time the
 * prompt improved.
 *
 * Requires Ollama; skipped with a reason when it is not there.
 */

import { describe, expect, it } from "vitest";
import { mergeDomainProfile } from "../../src/profile";
import { AppDomain, DomainProfile, PatientProfile } from "../../src/types";
import { api, findPathLeaks, probeEngines, suiteRequiring } from "../helpers/harness";

const engines = await probeEngines();
const suite = suiteRequiring(
  "profile extraction through the Intelligence Engine",
  engines.intelligence,
  engines.note
);

/** The client's own message shape: the route is only ever called with this. */
function turn(sender: "doctor" | "patient" | "user", text: string) {
  return { sender, text, originalText: text, translation: "", timestamp: new Date().toISOString() };
}

const CLINIC_CONVERSATION = [
  turn("doctor", "Good morning, what is your name and how old are you?"),
  turn("patient", "Good morning, my name is Amina Yusuf and I am thirty-four years old."),
  turn("doctor", "What symptoms have you been having?"),
  turn("patient", "I have had a fever and a dry cough for three days, and no chest pain."),
];

const HOTEL_CONVERSATION = [
  turn("user", "Good evening, I would like to check in please. My name is Peter Otieno."),
  turn("user", "I booked two nights, a quiet room on a high floor if possible."),
];

/** Medical fields a hotel profile must never carry, filled in or not. */
const MEDICAL_KEYS = ["age", "gender", "complaint", "symptoms"];

type ProfileJson = DomainProfile & Record<string, unknown>;

async function extract(conversation: unknown[], domain: string): Promise<ProfileJson> {
  const response = await api("/api/parse-dialogue", {
    method: "POST",
    body: { conversation, domain },
    timeoutMs: 180_000,
  });

  expect(response.status, `parse-dialogue (${domain}) -> ${response.text.slice(0, 300)}`).toBe(200);
  expect(response.json, `parse-dialogue (${domain}) returned a non-JSON body`).not.toBeNull();
  expect(findPathLeaks(response.text)).toEqual([]);
  return response.json as ProfileJson;
}

suite("Intelligence Engine profile extraction", () => {
  it("returns a clinic profile containing what was actually said", async () => {
    const profile = await extract(CLINIC_CONVERSATION, AppDomain.CLINIC);
    const facts = JSON.stringify(profile).toLowerCase();

    console.log("[parse-dialogue] clinic ->", JSON.stringify(profile));

    expect(profile.domain).toBe(AppDomain.CLINIC);
    expect(facts).toContain("amina");
    expect(facts).toContain("fever");
    expect(facts).toContain("cough");
  });

  it("does not invent the fact the conversation explicitly denied", async () => {
    const profile = await extract(CLINIC_CONVERSATION, AppDomain.CLINIC);
    const symptoms = Array.isArray(profile.symptoms) ? profile.symptoms.join(" | ").toLowerCase() : "";

    // "no chest pain" is the classic extraction failure: a negated symptom coming
    // back as a present one. A wrong symptom is worse than a missing one.
    expect(symptoms).not.toContain("chest pain");
  });

  it("returns a hotel profile, and keeps medicine out of it", async () => {
    const profile = await extract(HOTEL_CONVERSATION, AppDomain.HOTEL);
    const facts = JSON.stringify(profile).toLowerCase();

    console.log("[parse-dialogue] hotel ->", JSON.stringify(profile));

    expect(profile.domain).toBe(AppDomain.HOTEL);
    expect(facts).toContain("peter");

    for (const key of MEDICAL_KEYS) {
      const value = profile[key];
      const filled = Array.isArray(value) ? value.length > 0 : String(value ?? "").trim().length > 0;
      expect(filled, `hotel profile invented the medical field '${key}'`).toBe(false);
    }
  });

  it("cannot overwrite what the operator locked, whatever the model decided", async () => {
    // The Phase 2 merge rule, run against the model's real output rather than a
    // stand-in: fields the operator typed are locked, and an extraction - however
    // confident - does not get to rewrite them.
    const extracted = await extract(CLINIC_CONVERSATION, AppDomain.CLINIC);
    const existing = {
      ...(extracted as Record<string, unknown>),
      domain: AppDomain.CLINIC,
      gender: "female",
      complaint: "Severe headache since Monday",
    } as unknown as DomainProfile;

    // The merge returns the discriminated union; this conversation is a clinic one,
    // and the assertion below is that the discriminant really is clinic.
    const merged = mergeDomainProfile(AppDomain.CLINIC, existing, extracted, {
      lockedFields: ["complaint"],
    }) as PatientProfile;

    expect(merged.domain, "a malformed model answer must not relabel the profile").toBe(AppDomain.CLINIC);
    expect(merged.complaint).toBe("Severe headache since Monday");

    // A blank extraction fills a gap and never erases. The model is not obliged to
    // state a gender, so the untouched field is only asserted when it stayed blank.
    const extractedGender = String((extracted as Record<string, unknown>).gender ?? "").trim();
    if (extractedGender.length === 0) {
      expect(merged.gender).toBe("female");
    } else {
      console.log(`[merge] the extraction supplied a gender (${extractedGender}); overwriting it is correct`);
    }
  });
});
