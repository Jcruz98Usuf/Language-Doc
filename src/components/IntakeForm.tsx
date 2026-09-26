import { useState } from "react";
import { ArrowRight, ClipboardList, CheckCircle2 } from "lucide-react";
import { AppDomain, PatientProfile } from "../types";

interface IntakeFormProps {
  onComplete: (data: PatientProfile) => void;
  onStepChange?: (step: number) => void;
}

const STEPS = [
  { id: "personal", label: "Taarifa Binafsi", description: "Who is being treated?" },
  { id: "complaint", label: "Malalamiko Makuu", description: "Primary reason for visit" },
  { id: "symptoms", label: "Clinical Review", description: "Review of systems" },
];

export default function IntakeForm({ onComplete, onStepChange }: IntakeFormProps) {
  const [step, setStep] = useState(0);
  const [formData, setFormData] = useState<PatientProfile>({
    // NOTE (Phase 2): this wizard is still clinic-only and therefore submits a
    // PatientProfile. Hotel/office structured intake would need its own steps;
    // the conversation extractor fills those profiles instead.
    domain: AppDomain.CLINIC,
    name: "",
    age: "",
    gender: "",
    complaint: "",
    symptoms: [],
  });

  const nextStep = () => {
    if (step < STEPS.length - 1) {
      const newStep = step + 1;
      setStep(newStep);
      onStepChange?.(newStep);
    } else {
      onComplete(formData);
    }
  };

  const prevStep = () => {
    if (step > 0) {
      const newStep = step - 1;
      setStep(newStep);
      onStepChange?.(newStep);
    }
  };

  return (
    <div className="bg-white p-10 rounded-[2rem] shadow-sm ring-1 ring-slate-200">
      <div className="mb-10">
        <h2 className="text-3xl font-black tracking-tight text-slate-900 border-b-4 border-blue-600 inline-block pb-1 mb-2">
          {STEPS[step].label}
        </h2>
        <p className="text-slate-400 text-sm font-bold uppercase tracking-widest leading-none">
          {STEPS[step].description}
        </p>
      </div>

      <div className="space-y-8">
        {step === 0 && (
          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Jina Kamili (Full Name)</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="e.g. John Mwangi"
                className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-4 text-sm focus:outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-50/50 transition-all"
              />
            </div>
            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Umri (Age)</label>
                <input
                  type="number"
                  value={formData.age}
                  onChange={(e) => setFormData({ ...formData, age: e.target.value })}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-4 text-sm focus:outline-none focus:border-blue-500 transition-all font-mono"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Jinsia (Gender)</label>
                <select
                  value={formData.gender}
                  onChange={(e) => setFormData({ ...formData, gender: e.target.value })}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-4 text-sm focus:outline-none focus:border-blue-500 transition-all cursor-pointer"
                >
                  <option value="">Chagua (Select)</option>
                  <option value="male">Mwanaume (Male)</option>
                  <option value="female">Mwanamke (Female)</option>
                  <option value="other">Nyingine (Other)</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Kuna shida gani leo? (What brings you in today?)</label>
            <textarea
              value={formData.complaint}
              onChange={(e) => setFormData({ ...formData, complaint: e.target.value })}
              rows={6}
              placeholder="Elezea kwa kifupi..."
              className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-4 text-sm focus:outline-none focus:border-blue-500 transition-all resize-none leading-relaxed"
            />
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <p className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Chagua dalili zote unazohisi (Select all that apply):</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {["Homa (Fever)", "Kikohozi (Cough)", "Kuumwa na kichwa (Headache)", "Maumivu ya tumbo (Stomach pain)", "Kukosa pumzi (Shortness of breath)", "Uchovu (Fatigue)"].map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    const newSymptoms = formData.symptoms.includes(s)
                      ? formData.symptoms.filter((item) => item !== s)
                      : [...formData.symptoms, s];
                    setFormData({ ...formData, symptoms: newSymptoms });
                  }}
                  className={`flex items-center justify-between rounded-xl p-4 text-left text-sm font-semibold transition-all shadow-sm ring-1 ${
                    formData.symptoms.includes(s)
                      ? "bg-blue-600 text-white ring-blue-600"
                      : "bg-white text-slate-600 ring-slate-200 hover:ring-blue-300 hover:bg-slate-50"
                  }`}
                >
                  {s}
                  {formData.symptoms.includes(s) && <CheckCircle2 className="h-4 w-4" />}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mt-12 flex justify-between items-center">
        {step > 0 ? (
          <button
            onClick={prevStep}
            className="text-[11px] font-bold text-slate-400 uppercase tracking-widest hover:text-slate-900 transition-colors"
          >
            Back
          </button>
        ) : <div />}
        
        <button
          onClick={nextStep}
          disabled={step === 0 && !formData.name}
          className="flex items-center gap-2 rounded-xl bg-slate-900 px-10 py-4 font-bold text-white text-sm uppercase tracking-widest shadow-xl shadow-slate-200 transition-all hover:bg-slate-800 disabled:opacity-30 disabled:shadow-none"
        >
          {step === STEPS.length - 1 ? "Finish Intake" : "Next Step"}
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
