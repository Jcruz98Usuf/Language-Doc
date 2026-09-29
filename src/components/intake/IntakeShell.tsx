/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared intake chrome (Phase 7D).
 *
 * These are the styles of `IntakeForm.tsx` factored out, not a new visual
 * language: the card, the step heading, the input/select/textarea classes and the
 * Back/Next footer are copied from the clinic wizard so the three wizards are
 * indistinguishable. The clinic wizard itself is left untouched (requirement:
 * preserve its behaviour and fields exactly), which is why this file exists next
 * to it instead of replacing it.
 */

import type { ReactNode } from "react";
import { ArrowRight, CheckCircle2 } from "lucide-react";

export interface IntakeStep {
  label: string;
  description: string;
}

interface IntakeShellProps {
  steps: IntakeStep[];
  step: number;
  onNext: () => void;
  onBack: () => void;
  /** Disables Next, e.g. while the first required field is blank. */
  nextDisabled?: boolean;
  children: ReactNode;
}

/** The wizard frame: card, step heading, body, and the Back/Next footer. */
export function IntakeShell({
  steps,
  step,
  onNext,
  onBack,
  nextDisabled = false,
  children,
}: IntakeShellProps) {
  const isLast = step === steps.length - 1;

  return (
    <div className="bg-white p-10 rounded-[2rem] shadow-sm ring-1 ring-slate-200">
      <div className="mb-10">
        <h2 className="text-3xl font-black tracking-tight text-slate-900 border-b-4 border-blue-600 inline-block pb-1 mb-2">
          {steps[step].label}
        </h2>
        <p className="text-slate-400 text-sm font-bold uppercase tracking-widest leading-none">
          {steps[step].description}
        </p>
      </div>

      <div className="space-y-8">{children}</div>

      <div className="mt-12 flex justify-between items-center">
        {step > 0 ? (
          <button
            onClick={onBack}
            className="text-[11px] font-bold text-slate-400 uppercase tracking-widest hover:text-slate-900 transition-colors"
          >
            Back
          </button>
        ) : (

          <div />
        )}

        <button
          onClick={onNext}
          disabled={nextDisabled}
          className="flex items-center gap-2 rounded-xl bg-slate-900 px-10 py-4 font-bold text-white text-sm uppercase tracking-widest shadow-xl shadow-slate-200 transition-all hover:bg-slate-800 disabled:opacity-30 disabled:shadow-none"
        >
          {isLast ? "Finish Intake" : "Next Step"}
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

const INPUT_CLASS =
  "w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-4 text-sm focus:outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-50/50 transition-all";

/** Label + text input, matching the clinic wizard's markup and spacing. */
export function IntakeField({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "number";
  mono?: boolean;
}) {
  return (
    <div className="space-y-2">
      <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${INPUT_CLASS} ${mono ? "font-mono" : ""}`}
      />
    </div>
  );
}

/** Label + select, using the clinic wizard's option-list styling. */
export function IntakeSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <div className="space-y-2">
      <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-4 text-sm focus:outline-none focus:border-blue-500 transition-all cursor-pointer"
      >
        <option value="">Chagua (Select)</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Label + free-text area, matching the complaint step's textarea. */
export function IntakeTextArea({
  label,
  value,
  onChange,
  rows = 6,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <div className="space-y-4">
      <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-4 text-sm focus:outline-none focus:border-blue-500 transition-all resize-none leading-relaxed"
      />
    </div>
  );
}

/**
 * Multi-select chips, matching the clinic symptom picker exactly - including the
 * selected/unselected classes and the trailing check icon.
 */
export function IntakeChoiceGrid({
  options,
  selected,
  onToggle,
}: {
  options: readonly string[];
  selected: readonly string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {options.map((option) => {
        const isSelected = selected.includes(option);
        return (
          <button
            key={option}
            type="button"
            onClick={() => onToggle(option)}
            className={`flex items-center justify-between rounded-xl p-4 text-left text-sm font-semibold transition-all shadow-sm ring-1 ${
              isSelected
                ? "bg-blue-600 text-white ring-blue-600"
                : "bg-white text-slate-600 ring-slate-200 hover:ring-blue-300 hover:bg-slate-50"
            }`}
          >
            {option}
            {isSelected && <CheckCircle2 className="h-4 w-4" />}
          </button>
        );
      })}
    </div>
  );
}

