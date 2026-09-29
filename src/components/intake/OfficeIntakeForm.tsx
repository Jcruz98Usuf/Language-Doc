/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Office intake wizard (Phase 7D).
 *
 * Builds an `OfficeProfile` and nothing else - the compiler rejects any attempt to
 * set a hotel or medical field here, because the patch type is
 * `Extract<DomainProfile, { domain: AppDomain.OFFICE }>`.
 *
 * Action items are a list field of the office profile, but they are intentionally
 * not collected in the wizard: they are the output of the conversation, and a
 * checkbox grid at intake would be asking the user to do the extractor's job. The
 * field still exists on the profile and the AI fills it (see src/profile.ts).
 */

import { useState } from "react";
import { AppDomain, OfficeProfile } from "../../types";
import { useDomainIntake } from "./useDomainIntake";
import {
  IntakeField,
  IntakeSelect,
  IntakeShell,
  IntakeTextArea,
  type IntakeStep,
} from "./IntakeShell";

const STEPS: IntakeStep[] = [
  { label: "Mhusika (Who Is Joining)", description: "Name and department" },
  { label: "Mada ya Mkutano (Meeting Agenda)", description: "Subject and work context" },
];

const DEPARTMENTS = [
  { value: "Engineering", label: "Engineering" },
  { value: "Sales / Marketing", label: "Sales / Marketing" },
  { value: "Finance", label: "Finance" },
  { value: "Human Resources", label: "Human Resources" },
  { value: "Support", label: "Support" },
  { value: "External visitor", label: "Mgeni wa nje (External visitor)" },
];

export default function OfficeIntakeForm({ onComplete }: { onComplete: (data: OfficeProfile) => void }) {
  const [step, setStep] = useState(0);
  const { profile, update } = useDomainIntake(AppDomain.OFFICE);

  const isLast = step === STEPS.length - 1;
  const next = () => (isLast ? onComplete(profile as OfficeProfile) : setStep(step + 1));

  return (
    <IntakeShell
      steps={STEPS}
      step={step}
      onNext={next}
      onBack={() => setStep(step - 1)}
      nextDisabled={step === 0 && !profile.employeeName.trim()}
    >
      {step === 0 && (
        <div className="space-y-6">
          <IntakeField
            label="Jina (Employee / Visitor Name)"
            value={profile.employeeName}
            onChange={(employeeName) => update({ employeeName })}
            placeholder="e.g. Grace Wanjiku"
          />
          <div className="grid grid-cols-2 gap-6">
            <IntakeSelect
              label="Idara (Department)"
              value={profile.department}
              onChange={(department) => update({ department })}
              options={DEPARTMENTS}
            />
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-6">
          <IntakeField
            label="Mada ya Mkutano (Meeting Subject)"
            value={profile.meetingSubject}
            onChange={(meetingSubject) => update({ meetingSubject })}
            placeholder="e.g. Q3 roadmap review"
          />
          <IntakeTextArea
            label="Muktadha wa Kazi (Work Context)"
            value={profile.workContext}
            onChange={(workContext) => update({ workContext })}
            rows={4}
            placeholder="e.g. Agreed the Nairobi launch moves to September"
          />
        </div>
      )}
    </IntakeShell>
  );
}
