import { RefreshCw } from "lucide-react";
import { AppMode, PatientData } from "../types";

interface HeaderProps {
  mode: AppMode;
  patientData: PatientData | null;
  onReset: () => void;
  onEndSession?: () => void;
}

export default function Header({ mode, patientData, onReset, onEndSession }: HeaderProps) {
  return (
    <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-8 sticky top-0 z-50">
      <div className="flex items-center gap-6">
        {patientData ? (
          <>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase text-slate-400 font-bold tracking-wider leading-none mb-1">Patient Name</span>
              <span className="text-sm font-semibold text-slate-900">
                {patientData.name} ({patientData.gender === 'male' ? 'M' : 'F'}, {patientData.age})
              </span>
            </div>
            <div className="h-8 w-px bg-slate-200 hidden sm:block"></div>
            <div className="flex flex-col">
              <span className="text-[10px] uppercase text-slate-400 font-bold tracking-wider leading-none mb-1">Target Language</span>
              <span className="text-sm font-semibold text-slate-900">Kiswahili (Kenya)</span>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-slate-900 tracking-tight">LANGUAGE DOCTOR</span>
            <span className="text-[10px] bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full font-bold">READY</span>
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
