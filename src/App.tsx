/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ArrowRight, Stethoscope, ChevronRight, Hotel, Briefcase, Sparkles } from "lucide-react";
import { AppMode, PatientData, Message, AppDomain } from "./types";
import IntakeForm from "./components/IntakeForm";
import ConversationView from "./components/ConversationView";
import SummaryView from "./components/SummaryView";
import Header from "./components/Header";
import Sidebar from "./components/Sidebar";

export default function App() {
  const [mode, setMode] = useState<AppMode>(AppMode.WELCOME);
  const [domain, setDomain] = useState<AppDomain>(AppDomain.CLINIC);
  const [patientData, setPatientData] = useState<PatientData | null>(null);
  const [conversation, setConversation] = useState<Message[]>([]);
  const [intakeStep, setIntakeStep] = useState(0);

  const handleIntakeComplete = (data: PatientData) => {
    setPatientData(data);
    setMode(AppMode.CONVERSATION);
  };

  const handleConsultationEnd = () => {
    setMode(AppMode.SUMMARY);
  };

  const resetApp = () => {
    setMode(AppMode.WELCOME);
    setPatientData(null);
    setConversation([]);
    setIntakeStep(0);
  };

  const getDomainStyle = () => {
    switch (domain) {
      case AppDomain.HOTEL:
        return {
          glowColor: "bg-emerald-100",
          iconColor: "text-emerald-600",
          bgColor: "bg-emerald-600",
          shadowColor: "shadow-emerald-200",
          textColor: "text-emerald-600",
          hoverRing: "hover:ring-emerald-400",
          btnBg: "bg-emerald-50",
          btnColor: "text-emerald-600",
          badge: "bg-emerald-500",
          footerText: "Premium Lodging Sync • Tourism Enabled Secure Mode"
        };
      case AppDomain.OFFICE:
        return {
          glowColor: "bg-violet-100",
          iconColor: "text-violet-600",
          bgColor: "bg-violet-600",
          shadowColor: "shadow-violet-200",
          textColor: "text-violet-600",
          hoverRing: "hover:ring-violet-400",
          btnBg: "bg-violet-50",
          btnColor: "text-violet-600",
          badge: "bg-violet-500",
          footerText: "Enterprise Translation Mode • Corporate Secure Channel"
        };
      default:
        return {
          glowColor: "bg-blue-100",
          iconColor: "text-blue-600",
          bgColor: "bg-blue-600",
          shadowColor: "shadow-blue-200",
          textColor: "text-blue-600",
          hoverRing: "hover:ring-blue-400",
          btnBg: "bg-blue-50",
          btnColor: "text-blue-600",
          badge: "bg-blue-500",
          footerText: "Clinical Communication Screen • HIPAA Secure Sync"
        };
    }
  };

  const style = getDomainStyle();

  return (
    <div className="flex h-screen w-full bg-slate-50 font-sans text-slate-900 overflow-hidden">
      {mode !== AppMode.WELCOME && (
        <Sidebar 
          mode={mode} 
          intakeStep={intakeStep} 
          domain={domain} 
          setDomain={setDomain} 
          patientData={patientData} 
        />
      )}

      <div className="flex-grow flex flex-col overflow-hidden">
        {mode !== AppMode.WELCOME && (
          <Header 
            mode={mode} 
            patientData={patientData} 
            domain={domain}
            onReset={resetApp} 
            onEndSession={handleConsultationEnd} 
          />
        )}

        <main className={`flex-grow overflow-y-auto ${mode === AppMode.CONVERSATION ? 'p-0' : 'p-8'}`}>
          <AnimatePresence mode="wait">
            {mode === AppMode.WELCOME && (
              <motion.div
                key="welcome"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.02 }}
                className="flex h-full flex-col items-center justify-center space-y-10 text-center py-6 overflow-y-auto"
              >
                {/* Dynamic Domain Identity Launcher Icon */}
                <div className="relative shrink-0">
                  <div className={`absolute -inset-8 rounded-full ${style.glowColor} blur-3xl opacity-40 animate-pulse`} />
                  <div className={`relative flex h-24 w-24 items-center justify-center rounded-[2rem] ${style.bgColor} shadow-2xl ${style.shadowColor} transition-all duration-300`}>
                    {domain === AppDomain.HOTEL && <Hotel className="h-12 w-12 text-white" />}
                    {domain === AppDomain.OFFICE && <Briefcase className="h-12 w-12 text-white" />}
                    {domain === AppDomain.CLINIC && <Stethoscope className="h-12 w-12 text-white" />}
                  </div>
                </div>

                <div className="space-y-4 px-4">
                  <h1 className="text-5.5-xl md:text-6xl font-black tracking-tighter text-slate-900">
                    DUALBRIDGE <span className={style.textColor}>{domain.toUpperCase()}</span>
                  </h1>
                  <p className="mx-auto max-w-xl text-base text-slate-500 font-medium leading-relaxed">
                    {domain === AppDomain.CLINIC && "Professional Swahili-English clinic communication and smart medical intake diagnostics."}
                    {domain === AppDomain.HOTEL && "Interactive Swahili-English resort booking, tourism alignment, and front desk hospitality concierge."}
                    {domain === AppDomain.OFFICE && "Bilingual Swahili-English office alignments, team syncing, and executive agenda managers."}
                  </p>
                </div>

                {/* Horizontal Domain Context Picker Cards */}
                <div className="w-full max-w-2xl px-6 grid grid-cols-3 gap-3 shrink-0">
                  <button
                    onClick={() => setDomain(AppDomain.CLINIC)}
                    className={`flex flex-col items-center justify-center p-3 rounded-2xl border transition-all ${
                      domain === AppDomain.CLINIC 
                        ? "bg-blue-600 border-blue-500 text-white shadow-md shadow-blue-50" 
                        : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50"
                    }`}
                  >
                    <Stethoscope className="h-5 w-5 mb-1.5" />
                    <span className="text-[11px] font-extrabold uppercase tracking-wider">Clinics</span>
                  </button>
                  <button
                    onClick={() => setDomain(AppDomain.HOTEL)}
                    className={`flex flex-col items-center justify-center p-3 rounded-2xl border transition-all ${
                      domain === AppDomain.HOTEL 
                        ? "bg-emerald-600 border-emerald-500 text-white shadow-md shadow-emerald-50" 
                        : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50"
                    }`}
                  >
                    <Hotel className="h-5 w-5 mb-1.5" />
                    <span className="text-[11px] font-extrabold uppercase tracking-wider">Lodges</span>
                  </button>
                  <button
                    onClick={() => setDomain(AppDomain.OFFICE)}
                    className={`flex flex-col items-center justify-center p-3 rounded-2xl border transition-all ${
                      domain === AppDomain.OFFICE 
                        ? "bg-violet-600 border-violet-500 text-white shadow-md shadow-violet-50" 
                        : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50"
                    }`}
                  >
                    <Briefcase className="h-5 w-5 mb-1.5" />
                    <span className="text-[11px] font-extrabold uppercase tracking-wider">Corporate</span>
                  </button>
                </div>

                {/* Core Onboarding Decision Grid */}
                <div className="flex flex-col sm:flex-row gap-6 w-full max-w-2xl px-6 shrink-0">
                  <button
                    onClick={() => setMode(AppMode.INTAKE)}
                    className={`group flex-1 flex flex-col items-start rounded-3xl bg-white p-8 text-left shadow-sm ring-1 ring-slate-200 transition-all hover:shadow-xl ${style.hoverRing} hover:-translate-y-1`}
                  >
                    <div className={`mb-6 h-12 w-12 rounded-2xl ${style.btnBg} flex items-center justify-center ${style.btnColor} group-hover:bg-opacity-80 transition-all`}>
                      <ChevronRight className="h-6 w-6" />
                    </div>
                    {domain === AppDomain.CLINIC && (
                      <>
                        <h3 className="text-2xl font-bold tracking-tight">Structured Intake</h3>
                        <p className="mt-2 text-slate-500 text-sm font-medium leading-relaxed">Fill medical credentials and symptoms prior to beginning consultation.</p>
                      </>
                    )}
                    {domain === AppDomain.HOTEL && (
                      <>
                        <h3 className="text-2xl font-bold tracking-tight">Booking Form</h3>
                        <p className="mt-2 text-slate-500 text-sm font-medium leading-relaxed">Register guest identifiers, budget, and stay duration parameters first.</p>
                      </>
                    )}
                    {domain === AppDomain.OFFICE && (
                      <>
                        <h3 className="text-2xl font-bold tracking-tight">Agenda Profiler</h3>
                        <p className="mt-2 text-slate-500 text-sm font-medium leading-relaxed">Profile meeting coordinates, departmental lines, and target subject topics.</p>
                      </>
                    )}
                    <div className={`mt-6 flex items-center text-sm font-bold ${style.btnColor} uppercase tracking-widest gap-1 group-hover:gap-2 transition-all`}>
                      Get Started <ArrowRight className="h-4 w-4" />
                    </div>
                  </button>

                  <button
                    onClick={() => setMode(AppMode.CONVERSATION)}
                    className="group flex-1 flex flex-col items-start rounded-3xl bg-slate-900 p-8 text-left shadow-2xl shadow-slate-200 transition-all hover:shadow-slate-300 hover:-translate-y-1"
                  >
                    <div className="mb-6 h-12 w-12 rounded-2xl bg-slate-800 flex items-center justify-center text-white">
                      <div className="flex items-end gap-0.5 h-4">
                        <div className={`w-1 h-2 rounded-xs bg-amber-400 animate-pulse`} />
                        <div className={`w-1 h-3 rounded-xs bg-amber-400`} />
                        <div className={`w-1 h-4 rounded-xs bg-amber-400 animate-pulse`} />
                        <div className={`w-1 h-1 rounded-xs bg-amber-400`} />
                      </div>
                    </div>
                    <h3 className="text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                      Voice First Chat <Sparkles className="h-4 w-4 text-amber-400 animate-spin" />
                    </h3>
                    <p className="mt-2 text-slate-400 text-sm font-medium leading-relaxed">
                      Skip registrations and open live translations! AI auto-fills profiles on-the-fly.
                    </p>
                    <div className="mt-6 flex items-center text-sm font-bold text-amber-400 uppercase tracking-widest gap-1 group-hover:gap-2 transition-all">
                      Open Dashboard <ArrowRight className="h-4 w-4" />
                    </div>
                  </button>
                </div>

                <footer className="text-[10px] text-slate-400 font-bold uppercase tracking-[0.2em] px-4">
                  {style.footerText}
                </footer>
              </motion.div>
            )}

            {mode === AppMode.INTAKE && (
              <motion.div
                key="intake"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="max-w-3xl mx-auto"
              >
                <IntakeForm onComplete={handleIntakeComplete} onStepChange={setIntakeStep} />
              </motion.div>
            )}

            {mode === AppMode.CONVERSATION && (
              <motion.div
                key="conversation"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-full"
              >
                <ConversationView 
                  patientData={patientData} 
                  onUpdatePatientData={setPatientData}
                  messages={conversation}
                  onUpdateMessages={setConversation}
                  onEndSession={handleConsultationEnd}
                  domain={domain}
                />
              </motion.div>
            )}

            {mode === AppMode.SUMMARY && (
              <motion.div
                key="summary"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.02 }}
                className="max-w-4xl mx-auto"
              >
                <SummaryView patientData={patientData} conversation={conversation} domain={domain} />
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {mode !== AppMode.WELCOME && (
          <footer className="h-12 bg-white border-t border-slate-200 px-8 flex items-center justify-between text-[11px] text-slate-400 font-bold uppercase tracking-widest shrink-0">
            <div>Session ID: LD-{(Math.random() * 1000).toFixed(0)}-X8</div>
            <div className="flex gap-6">
              <span>Cloud Ready</span>
              <span className="text-green-600 font-black">● Smart Extractors Connected</span>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
