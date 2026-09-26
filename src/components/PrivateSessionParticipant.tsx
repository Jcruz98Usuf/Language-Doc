/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Private device mode - participant (mobile) client (Phases 5-6).
 *
 * Reached by scanning the host's QR code. The pairing credential arrives in the
 * URL fragment, is held in this tab's memory only, and is scrubbed from the
 * address bar before this component mounts (see App.tsx). Translation happens
 * entirely on the host laptop: this device sends raw text and renders the
 * canonical message the server returns, so it never selects a provider, model,
 * prompt or target language, and shows no server diagnostics.
 *
 * Typed messaging is the guaranteed path. Voice input and playback are best
 * effort: if either is unavailable the socket stays connected, text still
 * works, and a helpful message is shown.
 */

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { Mic, MicOff, Send, ShieldCheck, Volume2, Wifi } from "lucide-react";
import { AppDomain, Language, Message } from "../types";
import { fetchCapabilities } from "../services/api";

interface Props {
  sessionId: string;
  token: string;
  onClosed: () => void;
}

/** Messages arrive as JSON: timestamps need rehydrating and fields validating. */
function asMessage(value: unknown): Message | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Partial<Message>;
  if (typeof message.id !== "string" || typeof message.text !== "string") return null;
  if (typeof message.translation !== "string") return null;
  return {
    id: message.id,
    text: message.text,
    translation: message.translation,
    sender: message.sender === "doctor" ? "doctor" : "patient",
    originalText: typeof message.originalText === "string" ? message.originalText : message.text,
    timestamp: new Date(message.timestamp ?? Date.now()),
  };
}

/** Server-side rejection codes, rendered as plain sentences. */
const SEND_ERRORS: Record<string, string> = {
  empty: "Type a message before sending.",
  "too-long": "That message is too long to translate in one go.",
  "invalid-language": "The session language cannot be changed from this device.",
  "invalid-payload": "That message could not be sent.",
  "translation-failed": "The host could not translate that message.",
  "session-ended": "This private session has ended.",
};

/** Browser speech codes for the languages the registry can serve. */
const SPEECH_CODES: Record<string, string> = {
  English: "en-US",
  Swahili: "sw-KE",
  French: "fr-FR",
  Luganda: "en-US",
  Kinyarwanda: "rw-RW",
  Somali: "so-SO",
  Luo: "en-US",
  Kikuyu: "ki-KE",
  Kalenjin: "kln-KE",
};

export default function PrivateSessionParticipant({ sessionId, token, onClosed }: Props) {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const [hostTranslating, setHostTranslating] = useState(false);
  const [language, setLanguage] = useState<Language>(Language.SWAHILI);
  const [domain, setDomain] = useState<AppDomain>(AppDomain.CLINIC);
  const [capabilityLabel, setCapabilityLabel] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const socket = io({
      path: "/socket.io",
      auth: { sessionId, token, role: "participant" },
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setError(null);
    });
    socket.on(
      "session:ready",
      (value: { localLanguage?: Language; domain?: AppDomain; messages?: unknown[] }) => {
        if (value.localLanguage) setLanguage(value.localLanguage);
        if (value.domain) setDomain(value.domain);
        // Server-authoritative transcript, so a reload resumes the conversation.
        const restored = (value.messages ?? [])
          .map(asMessage)
          .filter((message): message is Message => message !== null);
        if (restored.length) setMessages(restored);
      }
    );
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", () => {
      setConnected(false);
      setError("This private session is unavailable, already paired, or has expired.");
    });
    socket.on("message:processing", () => setHostTranslating(true));
    socket.on("message:translated", (value: { message?: unknown }) => {
      setHostTranslating(false);
      const message = asMessage(value?.message);
      if (!message) return;
      setMessages((previous) =>
        previous.some((item) => item.id === message.id) ? previous : [...previous, message]
      );
    });
    socket.on("message:error", (value: { code?: string }) => {
      setHostTranslating(false);
      setError(SEND_ERRORS[value?.code ?? ""] ?? "The message could not be translated.");
    });
    socket.on("session:ended", () => {
      // The host ended it (or the expiry sweep did): show a clean state.
      setEnded(true);
      setConnected(false);
      setHostTranslating(false);
      socket.disconnect();
    });

    return () => {
      socket.disconnect();
    };
  }, [sessionId, token]);

  // Capability badge, from the same server registry the host screen reads.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchCapabilities();
      if (cancelled || !result) return;
      const entry = result.languages.find(
        (item) => item.language.toLowerCase() === String(language).toLowerCase()
      );
      if (!entry) return;
      setCapabilityLabel(
        entry.state !== "supported"
          ? entry.state === "experimental"
            ? "EXPERIMENTAL"
            : "UNAVAILABLE"
          : entry.role === "pivot"
            ? "CORE"
            : "DEMO READY"
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [language]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, hostTranslating]);

  /**
   * Voice input needs the Web Speech API *and* a secure context (HTTPS or
   * localhost). A phone that opened this page over plain http://<lan-ip> is not
   * a secure context, so the browser refuses the microphone before any of our
   * code runs. Detect it up front and explain, rather than leaving a button that
   * appears to do nothing.
   *
   * It is also deliberately optional: browser support is only partial, and on
   * Chrome speech recognition is server-based (audio is sent to a web service),
   * so a session must never depend on the microphone to work.
   */
  const [voiceState, setVoiceState] = useState<"ready" | "insecure" | "unsupported">("ready");

  useEffect(() => {
    const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Recognition) setVoiceState("unsupported");
    else if (!window.isSecureContext) setVoiceState("insecure");
    else setVoiceState("ready");
  }, []);

  const voiceHint =
    voiceState === "insecure"
      ? "Voice needs a secure (HTTPS) connection on this device. Type your message instead - it is still translated on the host laptop."
      : voiceState === "unsupported"
        ? "This browser has no speech recognition. Type your message instead - it is still translated on the host laptop."
        : null;

  const speechCode = SPEECH_CODES[String(language)] ?? "en-US";

  /** Best-effort voice input; a failure never breaks the session or typing. */
  const toggleListening = () => {
    if (listening) {
      try {
        recognitionRef.current?.stop();
      } catch {
        // The recogniser had already stopped.
      }
      setListening(false);
      return;
    }

    const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Recognition) {
      setError("Voice input is not available in this browser. You can still type.");
      return;
    }

    const recognition = new Recognition();
    recognition.lang = speechCode;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = (event: any) => {
      const transcript = Array.from(event.results)
        .map((result: any) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (transcript) setInput(transcript);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => {
      setListening(false);
      setError("Voice input failed. Typing still works and the session stays connected.");
    };

    recognitionRef.current = recognition;
    setError(null);
    try {
      recognition.start();
      setListening(true);
    } catch {
      setListening(false);
      setError("Voice input could not start. You can still type.");
    }
  };

  /** Replay a translated line with the browser voice, when one is available. */
  const speak = (text: string, id: string) => {
    if (!window.speechSynthesis) {
      setError("Playback is not available in this browser.");
      return;
    }
    if (speakingId === id) {
      window.speechSynthesis.cancel();
      setSpeakingId(null);
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = speechCode;
    const voice = window.speechSynthesis
      .getVoices()
      .find((candidate) => candidate.lang.startsWith(speechCode.split("-")[0]));
    if (voice) utterance.voice = voice;
    utterance.onend = () => setSpeakingId(null);
    utterance.onerror = () => {
      setSpeakingId(null);
      setError("Playback failed. Typed messages still work.");
    };
    setSpeakingId(id);
    window.speechSynthesis.speak(utterance);
  };

  /**
   * Sends raw text and waits for the acknowledgement, which carries the
   * canonical translated message. Nothing is translated in this browser.
   */
  const send = () => {
    const text = input.trim();
    if (!text || !connected || sending) return;

    setSending(true);
    setError(null);
    socketRef.current?.timeout(60000).emit(
      "message:send",
      { text },
      (timeoutError: unknown, reply?: { ok?: boolean; error?: string; message?: unknown }) => {
        setSending(false);
        if (timeoutError) {
          setError("The host's translation engine did not answer in time.");
          return;
        }
        if (!reply?.ok) {
          setError(SEND_ERRORS[reply?.error ?? ""] ?? "The message could not be translated.");
          return;
        }
        const message = asMessage(reply.message);
        if (message) {
          setMessages((previous) =>
            previous.some((item) => item.id === message.id) ? previous : [...previous, message]
          );
        }
        setInput("");
      }
    );
  };

  return (
    <main className="min-h-screen bg-slate-100 p-4">
      <div className="mx-auto flex max-w-xl flex-col gap-4">
        {/* Identity only: language and capability. No token, no server diagnostics. */}
        <header className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">Language Doctor</p>
          <h1 className="mt-1 text-lg font-black tracking-tight text-slate-900">Private Translation Session</h1>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-600">
            <span className="rounded-lg bg-slate-100 px-2 py-1 font-mono text-[11px] font-bold tracking-wider text-slate-700">
              {sessionId}
            </span>
            <span>
              {language} <span className="font-normal text-slate-400">&#8596; English</span>
            </span>
            {capabilityLabel && (
              <span
                className={`rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider ${
                  capabilityLabel === "DEMO READY" || capabilityLabel === "CORE"
                    ? "bg-emerald-50 text-emerald-700"
                    : capabilityLabel === "EXPERIMENTAL"
                      ? "bg-amber-50 text-amber-700"
                      : "bg-slate-100 text-slate-500"
                }`}
              >
                {capabilityLabel}
              </span>
            )}
          </div>
          <div className="mt-3 flex items-center gap-2 text-xs font-bold">
            {ended ? (
              <span className="text-slate-500">Session ended</span>
            ) : connected ? (
              <>
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                <span className="text-emerald-700">Connected</span>
              </>
            ) : (
              <>
                <Wifi className="h-3.5 w-3.5 animate-pulse text-slate-400" />
                <span className="text-slate-500">Connecting...</span>
              </>
            )}
          </div>
        </header>

        {/* Conversation. The host's lines arrive already translated. */}
        <div
          ref={scrollRef}
          className="min-h-64 space-y-3 overflow-y-auto rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200"
        >
          {messages.map((message) => {
            const isMine = message.sender === "patient";
            const shown = isMine ? message.text : message.translation;
            const secondary = isMine ? message.translation : message.text;
            return (
              <div key={message.id} className={`flex flex-col ${isMine ? "items-end" : "items-start"}`}>
                <div className={`flex items-center gap-2 ${isMine ? "flex-row-reverse" : ""}`}>
                  {!isMine && (
                    <button
                      onClick={() => speak(shown, message.id)}
                      title="Replay translation"
                      className={`shrink-0 rounded-full p-1.5 ${
                        speakingId === message.id ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      <Volume2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <p
                    className={`inline-block max-w-[80%] rounded-xl px-3 py-2 text-sm ${
                      isMine ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-800"
                    }`}
                  >
                    {shown}
                  </p>
                </div>
                {secondary && <p className="mt-1 max-w-[80%] text-[10px] font-medium text-slate-400">{secondary}</p>}
              </div>
            );
          })}
          {!messages.length && !ended && (
            <p className="text-sm text-slate-400">Messages will appear here in {language}.</p>
          )}
          {hostTranslating && <p className="text-xs font-semibold text-amber-600">Translating...</p>}
        </div>
        {ended ? (
          <div className="rounded-2xl bg-slate-900 p-5 text-center text-white shadow-sm">
            <p className="text-sm font-bold">Session ended by host.</p>
            <p className="mt-1 text-xs text-slate-300">This pairing code can no longer be used.</p>
            <button
              onClick={onClosed}
              className="mt-3 rounded-xl bg-white/10 px-4 py-2 text-[11px] font-bold uppercase tracking-widest"
            >
              Close
            </button>
          </div>
        ) : (
          <>
            {error && <p className="text-sm font-semibold text-red-600">{error}</p>}
            <div className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
              <div className="flex items-end gap-2">
                <button
                  onClick={toggleListening}
                  disabled={voiceState !== "ready"}
                  title={
                    voiceState !== "ready"
                      ? voiceHint ?? "Voice input unavailable"
                      : listening
                        ? "Stop voice input"
                        : "Speak"
                  }
                  className={`shrink-0 rounded-xl p-3 ${
                    voiceState !== "ready"
                      ? "cursor-not-allowed bg-slate-50 text-slate-300"
                      : listening
                        ? "bg-red-600 text-white"
                        : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {listening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                </button>
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  rows={2}
                  className="min-h-11 w-full resize-none rounded-xl border border-slate-200 p-3 text-sm"
                  placeholder={`Type in ${language}...`}
                />
              </div>
              <button
                onClick={send}
                disabled={!connected || sending || !input.trim()}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-xs font-bold uppercase tracking-widest text-white disabled:opacity-40"
              >
                <Send className="h-4 w-4" />
                {sending ? "Translating..." : "Send"}
              </button>
              {voiceHint && (
                <p className="mt-2 text-[10px] font-medium leading-snug text-slate-400">{voiceHint}</p>
              )}
            </div>
            <button
              onClick={onClosed}
              className="flex items-center justify-center gap-2 text-xs font-bold text-slate-500"
            >
              <ShieldCheck className="h-4 w-4" />
              Close private session
            </button>
          </>
        )}
      </div>
    </main>
  );
}

