/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Hotel intake wizard (Phase 7D).
 *
 * Builds a `GuestProfile` and nothing else. That is enforced by the compiler, not
 * by convention: `useDomainIntake(AppDomain.HOTEL)` types every patch from
 * `Extract<DomainProfile, { domain: AppDomain.HOTEL }>`, so writing
 * `update({ complaint: "..." })` here is a type error rather than a silent leak of
 * a hotel detail into a medical field.
 *
 * Two steps, deliberately short: this is a demo intake, and anything the guest
 * does not want to type is still collected by the AI extractor during the
 * conversation (see src/components/ConversationView.tsx).
 */

import { useState } from "react";
import { AppDomain, GuestProfile } from "../../types";
import { useDomainIntake } from "./useDomainIntake";
import {
  IntakeField,
  IntakeSelect,
  IntakeShell,
  IntakeTextArea,
  type IntakeStep,
} from "./IntakeShell";

const STEPS: IntakeStep[] = [
  { label: "Taarifa ya Mishi (Stay Details)", description: "Who is staying, and for how long?" },
  { label: "Mapendeleo (Preferences)", description: "Room, budget and any requests" },
];

const DURATIONS = [
  { value: "1 night", label: "Usiku mmoja (One night)" },
  { value: "2-3 nights", label: "Usiku 2-3 (Two to three nights)" },
  { value: "1 week", label: "Wiki moja (One week)" },
  { value: "2+ weeks", label: "Wiki 2+ (Two weeks or more)" },
  { value: "Day visit", label: "Mchana tu (Day visit)" },
];

const ROOMS = [
  { value: "Quiet, high floor", label: "Tulivu, ghorofa ya juu (Quiet, high floor)" },
  { value: "Near the lift", label: "Karibu na lifti (Near the lift)" },
  { value: "Ground floor", label: "Ghorofa ya chini (Ground floor)" },
  { value: "Twin beds", label: "Mili miwili (Twin beds)" },
  { value: "No preference", label: "Hakuna mapendeleo (No preference)" },
];

const BUDGETS = [
  { value: "Standard", label: "Standard" },
  { value: "Premium", label: "Premium" },
  { value: "Luxury suite", label: "Luxury suite" },
  { value: "Group / conference", label: "Kundi / mkutano (Group / conference)" },
];

export default function GuestIntakeForm({ onComplete }: { onComplete: (data: GuestProfile) => void }) {
  const [step, setStep] = useState(0);
  const { profile, update } = useDomainIntake(AppDomain.HOTEL);

  const isLast = step === STEPS.length - 1;
  const next = () => (isLast ? onComplete(profile as GuestProfile) : setStep(step + 1));

  return (
    <IntakeShell
      steps={STEPS}
      step={step}
      onNext={next}
      onBack={() => setStep(step - 1)}
      nextDisabled={step === 0 && !profile.guestName.trim()}
    >
      {step === 0 && (
        <div className="space-y-6">
          <IntakeField
            label="Jina la Mgeni (Guest Name)"
            value={profile.guestName}
            onChange={(guestName) => update({ guestName })}
            placeholder="e.g. Peter Otieno"
          />
          <div className="grid grid-cols-2 gap-6">
            <IntakeSelect
              label="Muda wa Kuka (Stay Duration)"
              value={profile.duration}
              onChange={(duration) => update({ duration })}
              options={DURATIONS}
            />
            <IntakeSelect
              label="Chumba (Room Preference)"
              value={profile.roomPreference}
              onChange={(roomPreference) => update({ roomPreference })}
              options={ROOMS}
            />
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-6">
            <IntakeSelect
              label="Kitengo cha Bajeti (Budget Category)"
              value={profile.budgetCategory}
              onChange={(budgetCategory) => update({ budgetCategory })}
              options={BUDGETS}
            />
          </div>
          <IntakeTextArea
            label="Maombi Maalum (Special Requests)"
            value={profile.specialRequests}
            onChange={(specialRequests) => update({ specialRequests })}
            rows={4}
            placeholder="e.g. Late check-out, airport transfer"
          />
        </div>
      )}
    </IntakeShell>
  );
}
