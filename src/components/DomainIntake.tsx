/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Domain-aware intake entry point (Phase 7D).
 *
 * Intake is optional: the welcome screen's "Voice First Chat" and "Shared Device"
 * buttons still go straight to the conversation, and nothing in this file is on
 * that path. Choosing "Structured Intake" lands here, and this component is the
 * only place that decides which wizard the active domain gets.
 *
 * The clinic wizard is the pre-existing `IntakeForm`, unmodified - its fields,
 * its three steps and its behaviour are exactly what they were before this phase.
 * Hotel and office get the two new wizards, which share IntakeForm's styling.
 *
 * Domain switching: the child is `key`ed on the domain, so React unmounts the old
 * wizard and mounts the new one. That is what stops half-typed hotel fields from
 * surviving a switch to office - the step index and every field value live in the
 * unmounted component's state, not in this one.
 */

import { AppDomain, DomainProfile } from "../types";
import IntakeForm from "./IntakeForm";
import GuestIntakeForm from "./intake/GuestIntakeForm";
import OfficeIntakeForm from "./intake/OfficeIntakeForm";

interface DomainIntakeProps {
  domain: AppDomain;
  onComplete: (data: DomainProfile) => void;
  onStepChange?: (step: number) => void;
}

export default function DomainIntake({ domain, onComplete, onStepChange }: DomainIntakeProps) {
  switch (domain) {
    case AppDomain.HOTEL:
      return (
        <GuestIntakeForm
          key={domain}
          // The wizard's callback is the app's, widened to the union. Narrowing
          // happens here, once, in the only place that knows the domain.
          onComplete={(data) => onComplete(data)}
        />
      );
    case AppDomain.OFFICE:
      return <OfficeIntakeForm key={domain} onComplete={(data) => onComplete(data)} />;
    default:
      return <IntakeForm onComplete={onComplete} onStepChange={onStepChange} />;
  }
}
