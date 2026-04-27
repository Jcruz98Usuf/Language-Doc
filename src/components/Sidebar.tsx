/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { AppMode } from "../types";

interface SidebarProps {
  mode: AppMode;
  intakeStep?: number;
}

export default function Sidebar({ mode, intakeStep = 0 }: SidebarProps) {
  return (
    <aside className="w-64 flex-shrink-0 bg-white border-r border-slate-200 flex flex-col justify-between py-6 px-4 hidden md:flex h-screen">
      <div className="space-y-8">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-6 h-6 bg-blue-600 rounded flex items-center justify-center relative">
               <div className="w-3 h-0.5 bg-white"></div>
               <div className="w-0.5 h-3 bg-white absolute"></div>
            </div>
            <span className="font-bold text-lg tracking-tight">LANGUAGE DR.</span>
          </div>
          <p className="text-[10px] text-slate-500 uppercase tracking-widest font-semibold px-0.5">
            Clinical Intake Assistant
          </p>
        </div>

        <nav className="space-y-1">
          <div className={`flex items-center gap-3 px-3 py-2 rounded-md font-medium transition-colors cursor-default ${
            mode === AppMode.CONVERSATION ? "bg-blue-50 text-blue-700" : "text-slate-500"
          }`}>
            <span className={`w-2 h-2 rounded-full ${mode === AppMode.CONVERSATION ? "bg-blue-600" : "bg-slate-200"}`}></span>
            Live Interaction
          </div>
          <div className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-default ${
            mode === AppMode.INTAKE ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-500"
          }`}>
            <span className={`w-2 h-2 rounded-full ${mode === AppMode.INTAKE ? "bg-blue-600" : "bg-slate-200"}`}></span>
            Patient Intake
          </div>
          <div className={`flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-default ${
            mode === AppMode.SUMMARY ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-500"
          }`}>
            <span className={`w-2 h-2 rounded-full ${mode === AppMode.SUMMARY ? "bg-blue-600" : "bg-slate-200"}`}></span>
            System Export
          </div>
        </nav>

        {mode === AppMode.INTAKE && (
          <div className="pt-4 space-y-4">
            <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider px-3">
              Active Intake Progress
            </p>
            <ul className="space-y-4 px-3">
              <li className="relative flex gap-3 pb-1">
                <div className="absolute left-[7px] top-4 bottom-0 w-0.5 bg-slate-100"></div>
                <div className={`w-4 h-4 rounded-full flex items-center justify-center text-white text-[10px] z-10 ${
                  intakeStep > 0 ? "bg-green-500" : "bg-blue-600"
                }`}>
                  {intakeStep > 0 ? "✓" : "1"}
                </div>
                <span className={`text-xs ${intakeStep === 0 ? "text-slate-900 font-semibold" : "text-slate-600 font-medium"}`}>
                  Identification
                </span>
              </li>
              <li className="relative flex gap-3 pb-1">
                <div className="absolute left-[7px] top-4 bottom-0 w-0.5 bg-slate-100"></div>
                <div className={`w-4 h-4 rounded-full text-white text-[10px] flex items-center justify-center z-10 ${
                  intakeStep > 1 ? "bg-green-500" : (intakeStep === 1 ? "bg-blue-600" : "bg-slate-200")
                }`}>
                  {intakeStep > 1 ? "✓" : "2"}
                </div>
                <span className={`text-xs ${intakeStep === 1 ? "text-slate-900 font-semibold" : "text-slate-400"}`}>
                  Chief Complaint
                </span>
              </li>
              <li className="relative flex gap-3">
                <div className={`w-4 h-4 rounded-full border-2 z-10 flex items-center justify-center text-[10px] text-white ${
                  intakeStep === 2 ? "bg-blue-600 border-blue-600" : "border-slate-200 bg-white"
                }`}>
                  {intakeStep === 2 ? "3" : ""}
                </div>
                <span className={`text-xs ${intakeStep === 2 ? "text-slate-900 font-semibold" : "text-slate-400"}`}>
                  Structured History
                </span>
              </li>
            </ul>
          </div>
        )}
      </div>

      <div className="px-3 py-4 bg-slate-50 rounded-xl border border-slate-100">
        <p className="text-[10px] text-slate-400 uppercase mb-2">Backend Connectivity</p>
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-700">Gemini 2.0 Flash</span>
          <span className="w-2 h-2 rounded-full bg-green-500"></span>
        </div>
      </div>
    </aside>
  );
}
