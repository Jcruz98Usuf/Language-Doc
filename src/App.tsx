/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { ArrowRight, Stethoscope, ChevronRight } from "lucide-react";
import { AppMode, PatientData, Message } from "./types";
import IntakeForm from "./components/IntakeForm";
import ConversationView from "./components/ConversationView";
import SummaryView from "./components/SummaryView";
import Header from "./components/Header";
import Sidebar from "./components/Sidebar";

export default function App() {
  const [mode, setMode] = useState<AppMode>(AppMode.WELCOME);
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

  return (
    <div className="flex h-screen w-full bg-slate-50 font-sans text-slate-900 overflow-hidden">
      {mode !== AppMode.WELCOME && (
        <Sidebar mode={mode} intakeStep={intakeStep} />
      )}

      <div className="flex-grow flex flex-col overflow-hidden">
        {mode !== AppMode.WELCOME && (
          <Header 
            mode={mode} 
            patientData={patientData} 
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
                className="flex h-full flex-col items-center justify-center space-y-12 text-center"
              >
                <div className="relative">
                  <div className="absolute -inset-8 rounded-full bg-blue-100 blur-3xl opacity-40 animate-pulse" />
                  <div className="relative flex h-28 w-28 items-center justify-center rounded-[2rem] bg-blue-600 shadow-2xl shadow-blue-200">
                    <Stethoscope className="h-14 w-14 text-white" />
                  </div>
                </div>

                <div className="space-y-4">
                  <h1 className="text-6xl font-black tracking-tighter text-slate-900 md:text-7xl">
                    LANGUAGE <span className="text-blue-600">DR.</span>
                  </h1>
                  <p className="mx-auto max-w-xl text-xl text-slate-500 font-medium leading-relaxed">
                    A professional clinical communication system for seamless medical translation between English and Swahili.
                  </p>
                </div>

                <div className="flex flex-col sm:flex-row gap-6 w-full max-w-2xl px-6">
                  <button
                    onClick={() => setMode(AppMode.INTAKE)}
                    className="group flex-1 flex flex-col items-start rounded-3xl bg-white p-8 text-left shadow-sm ring-1 ring-slate-200 transition-all hover:shadow-xl hover:ring-blue-400 hover:-translate-y-1"
                  >
                    <div className="mb-6 h-12 w-12 rounded-2xl bg-blue-50 flex items-center justify-center text-blue-600 group-hover:bg-blue-600 group-hover:text-white transition-all">
                      <ChevronRight className="h-6 w-6" />
                    </div>
                    <h3 className="text-2xl font-bold tracking-tight">Patient Intake</h3>
                    <p className="mt-2 text-slate-500 text-sm font-medium leading-relaxed">Guided multilingual screening with AI-assisted symptom analysis.</p>
                    <div className="mt-6 flex items-center text-sm font-bold text-blue-600 uppercase tracking-widest gap-1 group-hover:gap-2 transition-all">
                      Start Session <ArrowRight className="h-4 w-4" />
                    </div>
                  </button>

                  <button
                    onClick={() => setMode(AppMode.CONVERSATION)}
                    className="group flex-1 flex flex-col items-start rounded-3xl bg-slate-900 p-8 text-left shadow-2xl shadow-slate-200 transition-all hover:shadow-slate-300 hover:-translate-y-1"
                  >
                    <div className="mb-6 h-12 w-12 rounded-2xl bg-slate-800 flex items-center justify-center text-white">
                      <div className="flex items-end gap-0.5 h-4">
                        <div className="w-1 bg-blue-400 h-1"></div>
                        <div className="w-1 bg-blue-400 h-3"></div>
                        <div className="w-1 bg-blue-400 h-4"></div>
                        <div className="w-1 bg-blue-400 h-2"></div>
                      </div>
                    </div>
                    <h3 className="text-2xl font-bold tracking-tight text-white">Live Interaction</h3>
                    <p className="mt-2 text-slate-400 text-sm font-medium leading-relaxed">Direct bi-directional translation for medical consultations.</p>
                    <div className="mt-6 flex items-center text-sm font-bold text-blue-400 uppercase tracking-widest gap-1 group-hover:gap-2 transition-all">
                      Access Interface <ArrowRight className="h-4 w-4" />
                    </div>
                  </button>
                </div>

                <footer className="absolute bottom-12 text-[11px] text-slate-400 font-bold uppercase tracking-[0.2em]">
                  Secure Clinical Environment • HIPAA Compliant Infrastructure
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
                  messages={conversation}
                  onUpdateMessages={setConversation}
                  onEndSession={handleConsultationEnd}
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
                <SummaryView patientData={patientData} conversation={conversation} />
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {mode !== AppMode.WELCOME && (
          <footer className="h-12 bg-white border-t border-slate-200 px-8 flex items-center justify-between text-[11px] text-slate-400 font-bold uppercase tracking-widest shrink-0">
            <div>Session ID: LD-{(Math.random() * 1000).toFixed(0)}-X8</div>
            <div className="flex gap-6">
              <span>Cloud Ready</span>
              <span className="text-green-600 font-black">● HIPAA Secure Session</span>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
