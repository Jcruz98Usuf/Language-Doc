/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { io, type Socket } from "socket.io-client";
import { ArrowRight, Stethoscope, ChevronRight, Hotel, Briefcase, Sparkles } from "lucide-react";
import { AppMode, DomainProfile, Language, Message, AppDomain } from "./types";
import { activeProfileFor, mergeDomainProfile } from "./profile";
import { createSession, endSession, type SessionHandle } from "./services/api";
import DomainIntake from "./components/DomainIntake";
import ConversationView from "./components/ConversationView";
import SummaryView from "./components/SummaryView";
import Header from "./components/Header";
import Sidebar from "./components/Sidebar";
import PrivateSessionHost from "./components/PrivateSessionHost";
import PrivateSessionParticipant from "./components/PrivateSessionParticipant";

/** Normalises a Message that arrived over the wire (JSON turns dates into strings). */
function asWireMessage(value: unknown): Message | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Partial<Message>;
  if (typeof message.id !== "string" || typeof message.text !== "string") return null;
  if (typeof message.translation !== "string") return null;
  return {
    id: message.id,
    text: message.text,
    sender: message.sender === "doctor" ? "doctor" : "patient",
    originalText: typeof message.originalText === "string" ? message.originalText : message.text,
    translation: message.translation,
    timestamp: new Date(message.timestamp ?? Date.now()),
  };
}

/** Server-side message rejections, rendered in the existing conversation banner. */
const SESSION_SEND_ERRORS: Record<string, string> = {
  empty: "Type a message before sending.",
  "too-long": "That message is too long to translate in one go.",
  "invalid-language": "This session's language cannot be changed from a paired device.",
  "invalid-payload": "That message could not be sent.",
  "translation-failed": "The local translation engine could not translate that message.",
  "session-ended": "This private session has ended.",
};

export default function App() {
  const [mode, setMode] = useState<AppMode>(AppMode.WELCOME);
  const [domain, setDomain] = useState<AppDomain>(AppDomain.CLINIC);
  const [profile, setProfile] = useState<DomainProfile | null>(null);
  const [conversation, setConversation] = useState<Message[]>([]);
  const [intakeStep, setIntakeStep] = useState(0);

  /**
   * Temporary private session (Phase 3). The id is issued once by the server and
   * held in state, so it stays stable for the whole session - it is never
   * generated during render. Shared-device mode needs no network session.
   */
  const [privateSession, setPrivateSession] = useState<SessionHandle | null>(null);
  /** Participant language chosen for the private session (Phase 4). */
  const [privateLanguage, setPrivateLanguage] = useState<Language>(Language.SWAHILI);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [participantConnected, setParticipantConnected] = useState(false);
  const [participantJoin, setParticipantJoin] = useState<{ sessionId: string; token: string } | null>(null);
  const hostSocketRef = useRef<Socket | null>(null);
  /** The paired device is translating right now (private mode only). */
  const [peerTranslating, setPeerTranslating] = useState(false);
  /**
   * Set while this device deliberately ends the session, so the server's own
   * `session:ended` broadcast does not fight the local navigation flow.
   */
  const endingSessionRef = useRef(false);

  /**
   * Fields the operator typed into the intake form. They outrank uncertain AI
   * extraction inside mergeDomainProfile().
   */
  const lockedFormFields = useRef<string[]>([]);

  // A QR pairing link is `<origin>/join/LD-XXXXXX#token=<secret>`. The secret
  // arrives in the URL fragment, which browsers never send in an HTTP request;
  // it is consumed once, kept in memory only, and scrubbed from the visible
  // address bar (and history) before the socket connects.
  useEffect(() => {
    const pathMatch = /\/join\/([^/?#]+)/.exec(window.location.pathname);
    const legacyId = new URLSearchParams(window.location.search).get("join");
    const sessionId = pathMatch ? decodeURIComponent(pathMatch[1]) : legacyId;
    const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
    if (!sessionId || !token) return;

    setParticipantJoin({ sessionId, token });
    setMode(AppMode.PRIVATE_PARTICIPANT);
    // Removes `/join/<id>` and the #token fragment from the address bar.
    window.history.replaceState(null, "", "/");
  }, []);

  useEffect(() => {
    if (!privateSession || (mode !== AppMode.PRIVATE_HOST && mode !== AppMode.CONVERSATION)) return;
    const socket = io({
      path: "/socket.io",
      auth: { sessionId: privateSession.sessionId, token: privateSession.token, role: "host" },
    });
    hostSocketRef.current = socket;

    socket.on(
      "session:ready",
      (value: { localLanguage?: Language; participantConnected?: boolean; messages?: unknown[] }) => {
        if (value.localLanguage) setPrivateLanguage(value.localLanguage);
        setParticipantConnected(Boolean(value.participantConnected));
        // A reconnect resumes the canonical server transcript instead of losing it.
        const restored = (value.messages ?? [])
          .map(asWireMessage)
          .filter((message): message is Message => message !== null);
        if (restored.length) setConversation(restored);
      }
    );
    socket.on("participant-connected", () => setParticipantConnected(true));
    socket.on("participant-disconnected", () => setParticipantConnected(false));
    socket.on("message:processing", () => setPeerTranslating(true));
    socket.on("message:translated", (value: { message?: unknown }) => {
      setPeerTranslating(false);
      const message = asWireMessage(value?.message);
      if (!message) return;
      setConversation((previous) =>
        previous.some((item) => item.id === message.id) ? previous : [...previous, message]
      );
    });
    socket.on("message:error", () => setPeerTranslating(false));
    socket.on("session:ended", () => {
      // Reached only when the session died elsewhere (expiry sweep, another
      // device) - a deliberate end here sets endingSessionRef first.
      if (endingSessionRef.current) return;
      setPeerTranslating(false);
      setSessionError("This private session has ended.");
      setPrivateSession(null);
      setParticipantConnected(false);
      setMode(AppMode.WELCOME);
    });
    socket.on("connect_error", () => {
      if (endingSessionRef.current) return;
      setSessionError("Could not join the private session channel. Is the local server running?");
    });

    return () => {
      socket.disconnect();
      hostSocketRef.current = null;
    };
  }, [privateSession, mode]);

  /**
   * Private-mode send: raw text only. The server owns direction, translation
   * provider, model and prompt, and returns the canonical message through the
   * acknowledgement, so both devices render identical content.
   */
  const sendViaSession = (text: string, sender: "doctor" | "patient") =>
    new Promise<Message>((resolve, reject) => {
      const socket = hostSocketRef.current;
      if (!socket?.connected) {
        reject(new Error("The private session channel is not connected."));
        return;
      }
      socket.timeout(60000).emit(
        "message:send",
        { text, sender },
        (timeoutError: unknown, reply?: { ok?: boolean; error?: string; message?: unknown }) => {
          if (timeoutError) {
            reject(new Error("The local translation engine did not answer in time."));
            return;
          }
          if (!reply?.ok) {
            reject(new Error(SESSION_SEND_ERRORS[reply?.error ?? ""] ?? "The message could not be translated."));
            return;
          }
          const message = asWireMessage(reply.message);
          if (!message) {
            reject(new Error("The server returned an unreadable message."));
            return;
          }
          resolve(message);
        }
      );
    });

  /**
   * Manual intake, from any of the three wizards (Phase 7D).
   *
   * The wizard's result goes through the *same* merge as an AI extraction, so
   * there is one merge path in the app, not two: the stored profile is always the
   * complete normalised shape for the active domain, and a wizard that sent a
   * foreign field could not get it into state even if the compiler were not
   * watching (mergeDomainProfile only copies the active domain's field list).
   *
   * Only fields the operator actually filled in are locked, so the extractor is
   * still free to complete the blanks afterwards. `domain` itself is excluded:
   * it is the discriminant, not a value, and mergeDomainProfile always sets it.
   */
  const handleIntakeComplete = (data: DomainProfile) => {
    const merged = mergeDomainProfile(domain, null, data);
    setProfile(merged);
    lockedFormFields.current = Object.entries(merged)
      .filter(
        ([field, value]) =>
          field !== "domain" &&
          (typeof value === "string" ? value.trim().length > 0 : Array.isArray(value) && value.length > 0)
      )
      .map(([field]) => field);
    setMode(AppMode.CONVERSATION);
  };

  /**
   * Switching domain drops the previous domain's profile outright.
   *
   * `activeProfileFor` (display) and `mergeDomainProfile` (update) already refuse
   * to show or merge a foreign profile, so this is belt and braces: the stale
   * profile leaves app state at the moment the domain changes instead of sitting
   * in memory one render away from another domain, and the locked-field list can
   * never carry a clinic field name into a hotel session. Switching back does not
   * resurrect the old profile - the new session starts clean.
   */
  const handleDomainChange = (next: AppDomain) => {
    if (next === domain) return;
    setDomain(next);
    setProfile(null);
    setIntakeStep(0);
    lockedFormFields.current = [];
  };

  /**
   * Single merge point for extracted profiles: an empty extraction never erases
   * confirmed information, and the profile is always relabelled with the active
   * domain (see src/profile.ts).
   */
  const handleProfileUpdate = (incoming: unknown) => {
    setProfile((previous) =>
      mergeDomainProfile(domain, previous, incoming, { lockedFields: lockedFormFields.current })
    );
  };

  /**
   * Host "End private session": the server invalidates the token, drops the
   * messages and profile from memory, broadcasts `session:ended` (which the
   * paired device shows as "Session ended by host") and disconnects both
   * sockets. `endingSessionRef` keeps that broadcast from fighting this flow.
   */
  const endPrivateSession = async () => {
    if (!privateSession) return;
    endingSessionRef.current = true;
    await endSession(privateSession.sessionId, privateSession.token);
    setPrivateSession(null);
    setParticipantConnected(false);
    setPeerTranslating(false);
  };

  const handleConsultationEnd = () => {
    // In private mode the paired session is torn down too, otherwise the client
    // would keep waiting for a host that has already moved on.
    if (privateSession) void endPrivateSession();
    setMode(AppMode.SUMMARY);
  };

  /** The host view already ended the session server side; clean up and return. */
  const handlePrivateSessionClosed = () => {
    endingSessionRef.current = true;
    setPrivateSession(null);
    setParticipantConnected(false);
    setPeerTranslating(false);
    setMode(AppMode.WELCOME);
  };

  /**
   * Private device mode (Phase 4): creates the temporary server session through
   * the existing POST /api/sessions and opens the host waiting room.
   *
   * Shared Device Mode never calls this, so an ordinary single-screen session
   * creates no server session at all.
   */
  const startPrivateSession = async (language: Language) => {
    setSessionError(null);
    // A fresh session is not being torn down by this device.
    endingSessionRef.current = false;
    const handle = await createSession(domain, language);
    if (!handle) {
      setSessionError("Could not create a private session. Is the local server still running?");
      return;
    }

    // A new session supersedes any previous one.
    if (privateSession) void endSession(privateSession.sessionId, privateSession.token);

    setPrivateSession(handle);
    setPrivateLanguage(language);
    setParticipantConnected(false);
    setMode(AppMode.PRIVATE_HOST);
  };

  /** Participant connected: hand the host the normal conversation controls. */
  const handleOpenHostConversation = () => {
    setMode(AppMode.CONVERSATION);
  };

  const resetApp = () => {
    setMode(AppMode.WELCOME);
    setProfile(null);
    setConversation([]);
    setIntakeStep(0);
    lockedFormFields.current = [];
    // Ending a session invalidates its token and drops its data server side.
    if (privateSession) {
      endingSessionRef.current = true;
      void endSession(privateSession.sessionId, privateSession.token);
      setPrivateSession(null);
    }
    setParticipantConnected(false);
    setPeerTranslating(false);
  };

  // A profile belonging to another domain is never displayed.
  const activeProfile = activeProfileFor(domain, profile);

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

  // Welcome and private-host screens have their own focused shell: no shared
  // sidebar, header or footer.
  const showAppChrome = mode !== AppMode.WELCOME && mode !== AppMode.PRIVATE_HOST && mode !== AppMode.PRIVATE_PARTICIPANT;

  return (
    <div className="flex h-screen w-full bg-slate-50 font-sans text-slate-900 overflow-hidden">
      {showAppChrome && (
        <Sidebar 
          mode={mode} 
          intakeStep={intakeStep} 
          domain={domain} 
          setDomain={handleDomainChange} 
          profile={activeProfile} 
        />
      )}

      <div className="flex-grow flex flex-col overflow-hidden">
        {showAppChrome && (
          <Header 
            mode={mode} 
            profile={activeProfile} 
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
                    onClick={() => handleDomainChange(AppDomain.CLINIC)}
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
                    onClick={() => handleDomainChange(AppDomain.HOTEL)}
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
                    onClick={() => handleDomainChange(AppDomain.OFFICE)}
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

                {/* Session mode: Shared Device (this screen) or Private Session (device each) */}
                <div className="w-full max-w-2xl px-6 shrink-0">
                  <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-4 text-left sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Session mode</p>
                      <p className="text-xs font-medium text-slate-500">
                        Shared Device keeps both speakers on this screen. Private Session creates a temporary
                        LD-XXXXXX session for a second device.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        onClick={() => setMode(AppMode.CONVERSATION)}
                        className="rounded-xl border border-slate-200 px-4 py-2.5 text-[11px] font-bold uppercase tracking-widest text-slate-600 transition-colors hover:border-slate-300 hover:text-slate-900"
                      >
                        Shared Device
                      </button>
                      <label className="sr-only" htmlFor="private-language">
                        Participant language
                      </label>
                      <select
                        id="private-language"
                        value={privateLanguage}
                        onChange={(event) => setPrivateLanguage(event.target.value as Language)}
                        className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-[11px] font-semibold text-slate-600"
                      >
                        {Object.values(Language)
                          .filter((value) => value !== Language.ENGLISH)
                          .map((value) => (
                            <option key={value} value={value}>
                              {value}
                            </option>
                          ))}
                      </select>
                      <button
                        onClick={() => void startPrivateSession(privateLanguage)}
                        className={`rounded-xl ${style.bgColor} px-4 py-2.5 text-[11px] font-bold uppercase tracking-widest text-white shadow-sm transition-opacity hover:opacity-90`}
                      >
                        Private Session
                      </button>
                    </div>
                  </div>
                  {sessionError && (
                    <p className="mt-2 text-left text-xs font-semibold text-red-600">{sessionError}</p>
                  )}
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
                <DomainIntake domain={domain} onComplete={handleIntakeComplete} onStepChange={setIntakeStep} />
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
                  profile={activeProfile} 
                  onUpdateProfile={handleProfileUpdate}
                  initialLanguage={privateLanguage}
                  messages={conversation}
                  onUpdateMessages={setConversation}
                  sendViaSession={privateSession ? sendViaSession : undefined}
                  peerIsTranslating={peerTranslating}
                  onEndSession={handleConsultationEnd}
                  domain={domain}
                />
              </motion.div>
            )}

            {mode === AppMode.PRIVATE_HOST && privateSession && (
              <motion.div
                key="private-host"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="h-full"
              >
                <PrivateSessionHost
                  session={privateSession}
                  domain={domain}
                  language={privateLanguage}
                  onOpenConversation={handleOpenHostConversation}
                  onSessionClosed={handlePrivateSessionClosed}
                  participantConnected={participantConnected}
                />
              </motion.div>
            )}

            {mode === AppMode.PRIVATE_PARTICIPANT && participantJoin && (
              <motion.div key="private-participant" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full">
                <PrivateSessionParticipant
                  sessionId={participantJoin.sessionId}
                  token={participantJoin.token}
                  onClosed={() => { setParticipantJoin(null); setMode(AppMode.WELCOME); window.history.replaceState(null, "", window.location.pathname); }}
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
                <SummaryView profile={activeProfile} conversation={conversation} domain={domain} />
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {showAppChrome && (
          <footer className="h-12 bg-white border-t border-slate-200 px-8 flex items-center justify-between text-[11px] text-slate-400 font-bold uppercase tracking-widest shrink-0">
            {privateSession ? (
              <div className="flex items-center gap-2">
                <span>Session ID: {privateSession.sessionId}</span>
                <span className="normal-case font-semibold text-slate-300">
                  {privateLanguage} &#8596; English
                </span>
              </div>
            ) : (
              <span>Shared device mode</span>
            )}
            <div className="flex gap-6">
              <span>Local-first - no cloud AI</span>
              <span className="text-green-600 font-black">● Smart Extractors Connected</span>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
