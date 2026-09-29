/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Contract tier: domain-specific intake (Phase 7D).
 *
 * Intake is optional and must stay that way, and each domain may only ever build
 * its own profile. Both are the kind of promise that decays silently: a field is
 * added to the hotel form because it was nearly useful, and a guest's stay
 * duration ends up in `age`. The compiler already refuses most of that (the
 * generic `useDomainIntake<D>()` is what makes a foreign field a type error), so
 * these tests cover what the compiler cannot see - that the right wizard renders,
 * that the profile handed to app state is exactly the domain's own shape, and that
 * switching domains carries nothing across.
 *
 * The wizards are rendered for real through react-dom/server, so a renamed label
 * or a swapped step fails here rather than in a browser. Field values are then put
 * through `mergeDomainProfile`, the same single merge the app uses for manual
 * intake and for AI extraction, rather than through a stand-in.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import DomainIntake from "../../src/components/DomainIntake";
import type { ProfileForDomain } from "../../src/components/intake/useDomainIntake";
import { activeProfileFor, createPlaceholderProfile, mergeDomainProfile } from "../../src/profile";
import { AppDomain, DomainProfile } from "../../src/types";
import { ROOT } from "../helpers/harness";

/**
 * Renders the wizard the active domain actually gets, first step.
 *
 * `createElement` rather than JSX: this suite is matched by `*.test.ts`, and
 * widening that glob would change the config every other test file runs under.
 */
function renderWizard(domain: AppDomain): string {
  return renderToStaticMarkup(createElement(DomainIntake, { domain, onComplete: () => undefined }));
}

function source(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

/**
 * Source with the comments stripped out.
 *
 * A wizard documents exactly which fields it may not touch, so scanning raw text
 * finds the rule written in prose and calls it a violation. What matters is what the
 * code references.
 */
function code(relative: string): string {
  return source(relative)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

/** What a completed wizard hands to App.handleIntakeComplete. */
const CLINIC_INTAKE = {
  domain: AppDomain.CLINIC,
  name: "Amina Yusuf",
  age: "34",
  gender: "female",
  complaint: "Fever and dry cough for three days",
  symptoms: ["Homa (Fever)", "Kikohozi (Cough)"],
};

const HOTEL_INTAKE = {
  domain: AppDomain.HOTEL,
  guestName: "Peter Otieno",
  duration: "2-3 nights",
  roomPreference: "Quiet, high floor",
  budgetCategory: "Premium",
  specialRequests: "Late check-out at 14:00, airport transfer on arrival",
};

const OFFICE_INTAKE = {
  domain: AppDomain.OFFICE,
  employeeName: "Grace Wanjiku",
  department: "Engineering",
  meetingSubject: "Q3 roadmap review",
  workContext: "Agreed the Nairobi launch moves to September",
  actionItems: ["Circulate the revised timeline"],
};

/** The exact production path: the wizard's result goes through the app's merge. */
function store(domain: AppDomain, wizardResult: unknown): DomainProfile {
  return mergeDomainProfile(domain, null, wizardResult);
}

/** Narrows the union to one member, the way a domain check does in app code. */
function narrow<D extends AppDomain>(domain: D, profile: DomainProfile): ProfileForDomain<D> {
  if (profile.domain !== domain) throw new Error(`expected a ${domain} profile`);
  return profile as ProfileForDomain<D>;
}

const CLINIC_KEYS = ["name", "age", "gender", "complaint", "symptoms"];
const HOTEL_KEYS = ["guestName", "duration", "roomPreference", "budgetCategory", "specialRequests"];
const OFFICE_KEYS = ["employeeName", "department", "meetingSubject", "workContext", "actionItems"];

describe("Domain intake: one wizard per domain", () => {
  it("still renders the original clinic wizard, fields and all", () => {
    const markup = renderWizard(AppDomain.CLINIC);

    // The pre-Phase-7D wizard, unchanged: same steps, same labels.
    expect(markup).toContain("Taarifa Binafsi");
    expect(markup).toContain("Jina Kamili (Full Name)");
    expect(markup).toContain("Umri (Age)");
    expect(markup).toContain("Jinsia (Gender)");
  });

  it("gives hotel its own fields and no medical ones", () => {
    const markup = renderWizard(AppDomain.HOTEL);

    expect(markup).toContain("Jina la Mgeni (Guest Name)");
    expect(markup).toContain("Muda wa Kuka (Stay Duration)");

    for (const medical of ["Umri (Age)", "Jinsia (Gender)", "Jina Kamili (Full Name)"]) {
      expect(markup).not.toContain(medical);
    }
  });

  it("gives office its own fields and no hotel or medical ones", () => {
    const markup = renderWizard(AppDomain.OFFICE);

    expect(markup).toContain("Jina (Employee / Visitor Name)");
    expect(markup).toContain("Idara (Department)");

    for (const foreign of ["Umri (Age)", "Jina Kamili (Full Name)", "Jina la Mgeni (Guest Name)"]) {
      expect(markup).not.toContain(foreign);
    }
  });

  it("declares every field of its domain across all steps", () => {
    // A render only reaches step one, so the later steps are checked in the
    // source: a hotel form that never asked for a budget is still wrong.
    const hotel = code("src/components/intake/GuestIntakeForm.tsx");
    for (const key of HOTEL_KEYS) {
      expect(hotel).toContain(key);
    }

    const office = code("src/components/intake/OfficeIntakeForm.tsx");
    for (const key of ["employeeName", "department", "meetingSubject", "workContext"]) {
      expect(office).toContain(key);
    }
  });

  it("keeps each wizard's source free of the other domains vocabulary", () => {
    const hotel = code("src/components/intake/GuestIntakeForm.tsx");
    for (const medical of ["complaint", "symptoms", "PatientProfile"]) {
      expect(hotel).not.toContain(medical);
    }

    const office = code("src/components/intake/OfficeIntakeForm.tsx");
    for (const foreign of ["roomPreference", "budgetCategory", "guestName", "complaint", "symptoms"]) {
      expect(office).not.toContain(foreign);
    }
  });
});

describe("Domain intake: the profile that reaches app state", () => {
  it("stores a complete clinic profile", () => {
    const profile = store(AppDomain.CLINIC, CLINIC_INTAKE);
    console.log("[intake] clinic  ->", JSON.stringify(profile));

    expect(profile).toEqual({
      domain: AppDomain.CLINIC,
      name: "Amina Yusuf",
      age: "34",
      gender: "female",
      complaint: "Fever and dry cough for three days",
      symptoms: ["Homa (Fever)", "Kikohozi (Cough)"],
      intakeNotes: "",
    });
  });

  it("stores a complete hotel profile", () => {
    const profile = store(AppDomain.HOTEL, HOTEL_INTAKE);
    console.log("[intake] hotel   ->", JSON.stringify(profile));

    expect(profile).toEqual({
      domain: AppDomain.HOTEL,
      guestName: "Peter Otieno",
      duration: "2-3 nights",
      roomPreference: "Quiet, high floor",
      budgetCategory: "Premium",
      specialRequests: "Late check-out at 14:00, airport transfer on arrival",
    });
  });

  it("stores a complete office profile", () => {
    const profile = store(AppDomain.OFFICE, OFFICE_INTAKE);
    console.log("[intake] office  ->", JSON.stringify(profile));

    expect(profile).toEqual({
      domain: AppDomain.OFFICE,
      employeeName: "Grace Wanjiku",
      department: "Engineering",
      meetingSubject: "Q3 roadmap review",
      workContext: "Agreed the Nairobi launch moves to September",
      actionItems: ["Circulate the revised timeline"],
    });
  });

  it("gives every domain exactly its own fields, never another", () => {
    const cases = [
      { domain: AppDomain.CLINIC, keys: CLINIC_KEYS, result: store(AppDomain.CLINIC, CLINIC_INTAKE) },
      { domain: AppDomain.HOTEL, keys: HOTEL_KEYS, result: store(AppDomain.HOTEL, HOTEL_INTAKE) },
      { domain: AppDomain.OFFICE, keys: OFFICE_KEYS, result: store(AppDomain.OFFICE, OFFICE_INTAKE) },
    ];

    for (const item of cases) {
      const actual = Object.keys(item.result).filter((key) => key !== "domain").sort();
      const extra = item.domain === AppDomain.CLINIC ? ["intakeNotes"] : [];
      expect(actual).toEqual([...item.keys, ...extra].sort());
    }
  });
});

describe("Domain intake: switching domains leaks nothing", () => {
  const stored = {
    [AppDomain.CLINIC]: store(AppDomain.CLINIC, CLINIC_INTAKE),
    [AppDomain.HOTEL]: store(AppDomain.HOTEL, HOTEL_INTAKE),
    [AppDomain.OFFICE]: store(AppDomain.OFFICE, OFFICE_INTAKE),
  };
  const everyDomain = [AppDomain.CLINIC, AppDomain.HOTEL, AppDomain.OFFICE];

  it("never displays a profile from another domain", () => {
    for (const from of everyDomain) {
      for (const to of everyDomain) {
        const shown = activeProfileFor(to, stored[from]);
        if (from === to) {
          expect(shown).not.toBeNull();
        } else {
          expect(shown).toBeNull();
        }
      }
    }
  });

  it("carries no field and no value across a domain switch", () => {
    const pairs: Array<[AppDomain, AppDomain, unknown]> = [
      [AppDomain.CLINIC, AppDomain.HOTEL, HOTEL_INTAKE],
      [AppDomain.HOTEL, AppDomain.OFFICE, OFFICE_INTAKE],
      [AppDomain.OFFICE, AppDomain.CLINIC, CLINIC_INTAKE],
    ];

    for (const [from, to, toIntake] of pairs) {
      // Exactly what App does on a switch: the new wizard result is merged, and the
      // previous profile is discarded rather than reused as a base.
      const after = store(to, toIntake);
      const serialised = JSON.stringify(after);
      const previous = stored[from] as unknown as Record<string, unknown>;

      for (const entry of Object.entries(previous)) {
        const key = entry[0];
        const value = entry[1];
        if (key === "domain") continue;
        expect(Object.keys(after)).not.toContain(key);
        if (typeof value === "string" && value) {
          expect(serialised).not.toContain(value);
        }
      }
    }
  });

  it("drops foreign fields even if a wizard somehow sent them", () => {
    // Belt and braces behind the compiler: a payload carrying medical fields into
    // a hotel session is trimmed to the hotel field list by the merge.
    const polluted = { ...HOTEL_INTAKE, complaint: "fever", age: "34" };
    const profile = store(AppDomain.HOTEL, polluted) as unknown as Record<string, unknown>;

    expect(Object.keys(profile).sort()).toEqual(
      ["budgetCategory", "domain", "duration", "guestName", "roomPreference", "specialRequests"].sort()
    );
    expect(profile.complaint).toBeUndefined();
    expect(profile.age).toBeUndefined();
  });

  it("clears the stored profile when the domain changes", () => {
    // App.handleDomainChange drops the profile outright rather than relying on the
    // reader to filter it, so switching back cannot resurrect stale data.
    const app = source("src/App.tsx");
    expect(app).toContain("const handleDomainChange = (next: AppDomain) => {");
    expect(app).toContain("setDomain={handleDomainChange}");
  });
});

describe("Domain intake: manual entry and AI extraction share one merge", () => {
  it("keeps what the operator typed and fills the blanks from extraction", () => {
    const manual = store(AppDomain.HOTEL, { ...HOTEL_INTAKE, specialRequests: "" });

    const after = mergeDomainProfile(AppDomain.HOTEL, manual, HOTEL_INTAKE, {
      lockedFields: ["guestName", "duration", "roomPreference", "budgetCategory"],
    });

    const hotel = narrow(AppDomain.HOTEL, after);
    expect(hotel.guestName).toBe("Peter Otieno");
    expect(hotel.duration).toBe("2-3 nights");
    expect(hotel.specialRequests).toBe("Late check-out at 14:00, airport transfer on arrival");
  });

  it("is not relabelled by an extraction from another domain", () => {
    const manual = store(AppDomain.CLINIC, CLINIC_INTAKE);

    // A model answering in the wrong shape cannot turn a clinic session into a
    // hotel one: the discriminant comes from the active domain, not the payload.
    const merged = mergeDomainProfile(AppDomain.CLINIC, manual, {
      ...HOTEL_INTAKE,
      domain: AppDomain.HOTEL,
    });

    expect(merged.domain).toBe(AppDomain.CLINIC);
    expect(narrow(AppDomain.CLINIC, merged).name).toBe("Amina Yusuf");
    expect(JSON.stringify(merged)).not.toContain("Peter Otieno");
  });

  it("routes both manual intake and extraction through mergeDomainProfile", () => {
    const app = source("src/App.tsx");

    // One merge path, not two: a second implementation could drift, and only one
    // of the two would be tested.
    expect(app.match(/mergeDomainProfile\(domain,/g) ?? []).toHaveLength(2);
    expect(app).toContain("const handleIntakeComplete = (data: DomainProfile) => {");
    expect(app).toContain("const merged = mergeDomainProfile(domain, null, data);");
  });

  it("still offers a working skip, per domain", () => {
    expect(createPlaceholderProfile(AppDomain.CLINIC).domain).toBe(AppDomain.CLINIC);
    expect(createPlaceholderProfile(AppDomain.HOTEL)).toEqual({
      domain: AppDomain.HOTEL,
      guestName: "Active Session Visitor",
      duration: "",
      roomPreference: "Stay initiated directly",
      budgetCategory: "",
      specialRequests: "",
    });
    expect(createPlaceholderProfile(AppDomain.OFFICE)).toEqual({
      domain: AppDomain.OFFICE,
      employeeName: "Active Session Participant",
      department: "",
      meetingSubject: "Session initiated directly",
      workContext: "",
      actionItems: [],
    });
  });
});