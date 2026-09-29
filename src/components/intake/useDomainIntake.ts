/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Domain-parameterised intake state (Phase 7D).
 *
 * The wizard is generic over the domain instead of being written once per domain.
 * That is not a style choice, it is the requirement "a hotel form must never build a
 * PatientProfile" turned into something the compiler enforces:
 *
 *   const { update } = useDomainIntake(AppDomain.HOTEL);
 *   update({ guestName: "Peter" });     // fine
 *   update({ complaint: "headache" });  // COMPILE ERROR
 *
 * `ProfileForDomain<D>` is `Extract<DomainProfile, { domain: D }>`, so the patch
 * object is typed from the same discriminated union the server validates against.
 * There is no second, looser "intake form" shape anywhere in the client.
 *
 * Note on the two casts below: `createEmptyProfile` and the object spread both
 * return the *union* `DomainProfile`, while `D` says which member is meant. The
 * compiler cannot follow that relationship, so it is asserted once, here, in the
 * one place where a domain is already fixed. The public surface (the `update` /
 * `toggle` patches) stays fully checked.
 */

import { useState } from "react";
import { AppDomain, DomainProfile } from "../../types";
import { createEmptyProfile } from "../../profile";

/** The one union member belonging to `D`. This is the whole type-safety story. */
export type ProfileForDomain<D extends AppDomain> = Extract<DomainProfile, { domain: D }>;

/** Fields of a profile that hold plain text. */
type ScalarKeys<P> = { [K in keyof P]-?: P[K] extends string[] ? never : K }[keyof P];

/**
 * Fields of a profile that hold a string list (clinic symptoms, office action
 * items). A domain with no list field - hotel - resolves this to `never`, so
 * `toggle()` is simply not callable there.
 */
type ListKeys<P> = { [K in keyof P]-?: P[K] extends string[] ? K : never }[keyof P];

export function useDomainIntake<D extends AppDomain>(domain: D) {
  const [profile, setProfile] = useState<ProfileForDomain<D>>(
    () => createEmptyProfile(domain) as ProfileForDomain<D>
  );

  /**
   * Applies a patch to this domain's profile.
   *
   * Because the parameter is `Partial<ProfileForDomain<D>>` and object literals are
   * excess-property checked at the call site, passing a field that belongs to
   * another domain does not compile.
   */
  const update = (patch: Partial<ProfileForDomain<D>>) => {
    setProfile((previous) => ({ ...previous, ...patch }) as ProfileForDomain<D>);
  };

  /** Adds/removes one entry in a list field. Unavailable on domains without one. */
  const toggle = (key: ListKeys<ProfileForDomain<D>>, value: string) => {
    setProfile((previous) => {
      const current = previous[key] as string[];
      const next = current.includes(value)
        ? current.filter((item) => item !== value)
        : [...current, value];
      return { ...previous, [key]: next } as ProfileForDomain<D>;
    });
  };

  /** The list field of this domain, or `null` when it has none (hotel). */
  const listField = (key: ListKeys<ProfileForDomain<D>>) => profile[key] as string[] | undefined;

  return {
    profile,
    update,
    toggle,
    /** The entries currently selected in a list field of this domain. */
    listField,
  };
}
