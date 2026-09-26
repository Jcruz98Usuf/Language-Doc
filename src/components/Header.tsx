import { RefreshCw, GraduationCap, Sparkles } from "lucide-react";
import { AppMode, DomainProfile, AppDomain } from "../types";

interface HeaderProps {
  mode: AppMode;
  profile: DomainProfile | null;
  domain: AppDomain;
  onReset: () => void;
  onEndSession?: () => void;
}

export default function Header({ mode, profile, domain, onReset, onEndSession }: HeaderProps) {
  const getDomainTheme = () => {
    switch (domain) {
      case AppDomain.HOTEL:
        return {
          title: "Safari Lodging Concierge",
          badgeColor: "bg-emerald-50 text-emerald-700",
          accentColor: "text-emerald-600",
          lblPrimary: "Guest name",
          lblSecondary: "Nights"
        };
      case AppDomain.OFFICE:
        return {
          title: "Bilingual Workspace Sync",
          badgeColor: "bg-violet-50 text-violet-700",
          accentColor: "text-violet-600",
          lblPrimary: "Lead member",
          lblSecondary: "Team"
        };
      default:
        return {
          title: "Swahili Clinic Assistant",
          badgeColor: "bg-blue-50 text-blue-700",
          accentColor: "text-blue-600",
          lblPrimary: "Patient Name",
          lblSecondary: "Age"
        };
    }
  };

  const theme = getDomainTheme();

  // Phase 2: narrow the discriminated union instead of guessing which field
  // holds what (no more `guestName || name`, no more `duration || age`).
  const patient = profile?.domain === AppDomain.CLINIC ? profile : null;
  const guest = profile?.domain === AppDomain.HOTEL ? profile : null;
  const office = profile?.domain === AppDomain.OFFICE ? profile : null;

  const primaryVal = guest?.guestName || patient?.name || office?.employeeName || null;
  const secondaryVal = patient
    ? patient.age
      ? `${patient.age} yrs`
      : "Not specified"
    : guest
      ? guest.duration || "Not specified"
      : office
        ? office.department || "General Team"
        : null;

  return (
    <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-8 sticky top-0 z-40 shrink-0">
      <div className="flex items-center gap-6">
        {primaryVal ? (
          <>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase text-slate-400 font-bold tracking-wider leading-none mb-1">{theme.lblPrimary}</span>
              <span className="text-sm font-semibold text-slate-900 truncate max-w-[150px] sm:max-w-none">
                {primaryVal}
              </span>
            </div>
            <div className="h-8 w-px bg-slate-200 hidden sm:block"></div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase text-slate-400 font-bold tracking-wider leading-none mb-1">{theme.lblSecondary}</span>
              <span className="text-sm font-semibold text-slate-800">
                {secondaryVal}
              </span>
            </div>
            <div className="h-8 w-px bg-slate-200 hidden sm:block"></div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase text-slate-400 font-bold tracking-wider leading-none mb-1">Target Language</span>
              <span className="text-sm font-semibold text-slate-900 flex items-center gap-1">Kiswahili <Sparkles className="h-3 w-3 text-amber-500" /></span>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-slate-900 tracking-tight uppercase">{theme.title}</span>
            <span className={`text-[10px] ${theme.badgeColor} px-2 py-0.5 rounded-full font-bold uppercase tracking-wider`}>Live Bridge</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        {mode === AppMode.CONVERSATION ? (
          <button 
            onClick={onEndSession}
            className="px-4 py-2 bg-slate-900 text-white text-sm font-semibold rounded-lg flex items-center gap-2 shadow-sm hover:bg-slate-800 transition-colors"
          >
            Finish & Export Summary
          </button>
        ) : mode !== AppMode.WELCOME && (
          <button
            onClick={onReset}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-bold text-slate-400 uppercase tracking-widest hover:text-slate-900 transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            Reset
          </button>
        )}
      </div>
    </header>
  );
}
