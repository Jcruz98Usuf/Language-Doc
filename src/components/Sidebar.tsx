/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AppMode, PatientData, AppDomain } from "../types";
import { Stethoscope, Hotel, Briefcase, Activity, CheckCircle2 } from "lucide-react";

interface SidebarProps {
  mode: AppMode;
  intakeStep?: number;
  domain: AppDomain;
  setDomain: (domain: AppDomain) => void;
  patientData: PatientData | null;
}

export default function Sidebar({ mode, intakeStep = 0, domain, setDomain, patientData }: SidebarProps) {
  const getDomainIcon = (d: AppDomain) => {
    switch (d) {
      case AppDomain.HOTEL:
        return <Hotel className="w-5 h-5" />;
      case AppDomain.OFFICE:
        return <Briefcase className="w-5 h-5" />;
      default:
        return <Stethoscope className="w-5 h-5" />;
    }
  };

  const currentTheme = () => {
    switch (domain) {
      case AppDomain.HOTEL:
        return {
          primary: "bg-emerald-600",
          ring: "focus:ring-emerald-200",
          text: "text-emerald-700",
          lightBg: "bg-emerald-50",
          accentBorder: "border-emerald-200",
          accentText: "text-emerald-600",
          dot: "bg-emerald-600",
          brand: "LODGE CONCIERGE"
        };
      case AppDomain.OFFICE:
        return {
          primary: "bg-violet-600",
          ring: "focus:ring-violet-200",
          text: "text-violet-700",
          lightBg: "bg-violet-50",
          accentBorder: "border-violet-200",
          accentText: "text-violet-600",
          dot: "bg-violet-600",
          brand: "WORKSPACE SYNC"
        };
      default:
        return {
          primary: "bg-blue-600",
          ring: "focus:ring-blue-200",
          text: "text-blue-700",
          lightBg: "bg-blue-50",
          accentBorder: "border-blue-200",
          accentText: "text-blue-600",
          dot: "bg-blue-600",
          brand: "CLINIC INTAKE"
        };
    }
  };

  const theme = currentTheme();

  return (
    <aside className="w-72 flex-shrink-0 bg-white border-r border-slate-200 flex flex-col justify-between py-6 px-4 hidden md:flex h-screen overflow-y-auto">
      <div className="space-y-6">
        {/* Brand identity */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className={`w-8 h-8 ${theme.primary} text-white rounded-lg flex items-center justify-center relative shadow-sm`}>
              {getDomainIcon(domain)}
            </div>
            <span className="font-extrabold text-md tracking-tight">DUALBRIDGE</span>
          </div>
          <p className={`text-[10px] uppercase tracking-wider font-extrabold px-0.5 ${theme.text}`}>
            {theme.brand}
          </p>
        </div>

        {/* Domain Segment Switcher (Can pivot on-the-fly) */}
        <div className="p-1.5 bg-slate-100 rounded-xl">
          <p className="text-[10px] text-slate-400 font-extrabold uppercase tracking-wider px-2 mb-1">Select Domain</p>
          <div className="grid grid-cols-3 gap-1">
            <button
              onClick={() => setDomain(AppDomain.CLINIC)}
              className={`py-2 rounded-lg text-xs font-bold transition-all flex flex-col items-center gap-1 ${
                domain === AppDomain.CLINIC 
                  ? "bg-white text-blue-700 shadow-xs" 
                  : "text-slate-500 hover:text-slate-900"
              }`}
            >
              <Stethoscope className="w-3.5 h-3.5" />
              <span>Clinic</span>
            </button>
            <button
              onClick={() => setDomain(AppDomain.HOTEL)}
              className={`py-2 rounded-lg text-xs font-bold transition-all flex flex-col items-center gap-1 ${
                domain === AppDomain.HOTEL 
                  ? "bg-white text-emerald-700 shadow-xs" 
                  : "text-slate-500 hover:text-slate-900"
              }`}
            >
              <Hotel className="w-3.5 h-3.5" />
              <span>Hotel</span>
            </button>
            <button
              onClick={() => setDomain(AppDomain.OFFICE)}
              className={`py-2 rounded-lg text-xs font-bold transition-all flex flex-col items-center gap-1 ${
                domain === AppDomain.OFFICE 
                  ? "bg-white text-violet-700 shadow-xs" 
                  : "text-slate-500 hover:text-slate-900"
              }`}
            >
              <Briefcase className="w-3.5 h-3.5" />
              <span>Office</span>
            </button>
          </div>
        </div>

        {/* Main active mode selector */}
        <nav className="space-y-1">
          <div className={`flex items-center gap-3 px-3 py-2 rounded-md font-medium transition-colors cursor-default ${
            mode === AppMode.CONVERSATION ? `${theme.lightBg} ${theme.text}` : "text-slate-500"
          }`}>
            <span className={`w-2 h-2 rounded-full ${mode === AppMode.CONVERSATION ? theme.dot : "bg-slate-200"}`}></span>
            Live Conversation
          </div>
          <div className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-default ${
            mode === AppMode.INTAKE ? `${theme.lightBg} ${theme.text} font-medium` : "text-slate-500"
          }`}>
            <span className={`w-2 h-2 rounded-full ${mode === AppMode.INTAKE ? theme.dot : "bg-slate-200"}`}></span>
            Profiling Intake
          </div>
          <div className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-default ${
            mode === AppMode.SUMMARY ? `${theme.lightBg} ${theme.text} font-medium` : "text-slate-500"
          }`}>
            <span className={`w-2 h-2 rounded-full ${mode === AppMode.SUMMARY ? theme.dot : "bg-slate-200"}`}></span>
            Review Summary
          </div>
        </nav>

        {/* Dynamic Intake progress or live metadata extraction indicators */}
        {mode === AppMode.CONVERSATION && (
          <div className="pt-2 space-y-3">
            <div className="flex items-center justify-between px-3">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Extracted Card Data
              </p>
              <span className="flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
              </span>
            </div>

            <div className={`mx-3 p-3.5 rounded-xl border ${theme.accentBorder} bg-slate-50/50 space-y-3 text-xs`}>
              {domain === AppDomain.CLINIC && (
                <>
                  <div className="flex justify-between border-b border-dashed border-slate-200 pb-1.5">
                    <span className="text-slate-400">Name:</span>
                    <span className={`font-semibold ${patientData?.name ? "text-slate-800" : "text-slate-300 italic"}`}>
                      {patientData?.name || "Pending..."}
                    </span>
                  </div>
                  <div className="flex justify-between border-b border-dashed border-slate-200 pb-1.5">
                    <span className="text-slate-400">Age:</span>
                    <span className={`font-semibold ${patientData?.age ? "text-slate-800" : "text-slate-300 italic"}`}>
                      {patientData?.age || "Pending..."}
                    </span>
                  </div>
                  <div className="flex justify-between border-b border-dashed border-slate-200 pb-1.5">
                    <span className="text-slate-400">Gender:</span>
                    <span className={`font-semibold uppercase tracking-wider ${patientData?.gender ? "text-slate-800" : "text-slate-300 italic"}`}>
                      {patientData?.gender || "Pending..."}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-slate-400">Symptoms:</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {patientData?.symptoms && patientData.symptoms.length > 0 ? (
                        patientData.symptoms.map((s, idx) => (
                          <span key={idx} className="bg-blue-50 text-blue-700 text-[10px] px-1.5 py-0.5 rounded-md font-semibold font-mono">
                            {s}
                          </span>
                        ))
                      ) : (
                        <span className="text-slate-300 italic text-[11px]">None identified yet</span>
                      )}
                    </div>
                  </div>
                </>
              )}

              {domain === AppDomain.HOTEL && (
                <>
                  <div className="flex justify-between border-b border-dashed border-slate-200 pb-1.5">
                    <span className="text-slate-400">Guest:</span>
                    <span className={`font-semibold ${patientData?.guestName || patientData?.name ? "text-slate-800" : "text-slate-300 italic"}`}>
                      {patientData?.guestName || patientData?.name || "Pending..."}
                    </span>
                  </div>
                  <div className="flex justify-between border-b border-dashed border-slate-200 pb-1.5">
                    <span className="text-slate-400">Nights:</span>
                    <span className={`font-semibold ${patientData?.duration || patientData?.age ? "text-slate-800" : "text-slate-300 italic"}`}>
                      {patientData?.duration || patientData?.age || "Pending..."}
                    </span>
                  </div>
                  <div className="flex justify-between border-b border-dashed border-slate-200 pb-1.5">
                    <span className="text-slate-400">Room Pref:</span>
                    <span className={`font-semibold ${patientData?.roomPreference ? "text-slate-800" : "text-slate-300 italic"}`}>
                      {patientData?.roomPreference || "Pending..."}
                    </span>
                  </div>
                  <div className="flex justify-between border-b border-dashed border-slate-200 pb-1.5">
                    <span className="text-slate-400">Tier:</span>
                    <span className={`font-semibold uppercase tracking-wider ${patientData?.budgetCategory ? "text-slate-800" : "text-slate-300 italic"}`}>
                      {patientData?.budgetCategory || "Pending..."}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-slate-400">Diet/Special requests:</span>
                    <span className={`font-semibold ${patientData?.specialRequests || patientData?.complaint ? "text-slate-800" : "text-slate-300 italic"}`}>
                      {patientData?.specialRequests || patientData?.complaint || "None"}
                    </span>
                  </div>
                </>
              )}

              {domain === AppDomain.OFFICE && (
                <>
                  <div className="flex justify-between border-b border-dashed border-slate-200 pb-1.5">
                    <span className="text-slate-400">Presenter:</span>
                    <span className={`font-semibold ${patientData?.employeeName || patientData?.name ? "text-slate-800" : "text-slate-300 italic"}`}>
                      {patientData?.employeeName || patientData?.name || "Pending..."}
                    </span>
                  </div>
                  <div className="flex justify-between border-b border-dashed border-slate-200 pb-1.5">
                    <span className="text-slate-400">Team/Dept:</span>
                    <span className={`font-semibold ${patientData?.department || patientData?.age ? "text-slate-800" : "text-slate-300 italic"}`}>
                      {patientData?.department || patientData?.age || "Pending..."}
                    </span>
                  </div>
                  <div className="flex justify-between border-b border-dashed border-slate-200 pb-1.5">
                    <span className="text-slate-400">Topic:</span>
                    <span className={`font-semibold truncate max-w-[130px] ${patientData?.meetingSubject || patientData?.complaint ? "text-slate-800" : "text-slate-300 italic"}`}>
                      {patientData?.meetingSubject || patientData?.complaint || "Pending..."}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-slate-400">Action Items:</span>
                    <div className="flex flex-col gap-1 mt-1.5">
                      {patientData?.actionItems && patientData.actionItems.length > 0 ? (
                        patientData.actionItems.map((act, idx) => (
                          <div key={idx} className="flex items-start gap-1 text-[10px] text-violet-700 bg-violet-50 p-1 rounded-md font-medium">
                            <span className="font-bold shrink-0">•</span>
                            <span>{act}</span>
                          </div>
                        ))
                      ) : (
                        <span className="text-slate-300 italic text-[11px]">No actions recorded yet</span>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="px-3 py-4 bg-slate-50 rounded-xl border border-slate-100 shrink-0">
        <p className="text-[10px] text-slate-400 uppercase mb-2">DualBridge Engine</p>
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-semibold text-slate-700 flex items-center gap-1">
            <Activity className="w-3.5 h-3.5 text-green-500 animate-pulse" />
            Active Listening
          </span>
          <span className="w-2 h-2 rounded-full bg-green-500"></span>
        </div>
        <div className="text-[10px] text-slate-400 leading-tight">
          Translating Swahili/English conversational threads real-time under 200ms.
        </div>
      </div>
    </aside>
  );
}
