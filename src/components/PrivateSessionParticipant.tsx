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
 * works, and a helpful message is shown. Voice input is local: the clip goes to
 * the host laptop's Whisper engine and never to a speech service (Phase 7C).
 *
 * The client role is bound to a device: the link carries the session, and a locally
 * stored device identifier carries the device (services/deviceIdentity), so a phone
 * that vanished without leaving keeps its place until the session itself ends. The
 * phone's back button therefore asks before it leaves - end the session for both
 * devices, or disconnect and leave it running for a later rejoin - and never slides
 * past this view on its own.
 */

import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { Loader2, Mic, MicOff, Send, ShieldCheck, Volume2, Wifi } from "lucide-react";
import { AppDomain, Language, Message } from "../types";
import { endSession, fetchCapabilities, fetchSession, transcribeAudio } from "../services/api";
import { participantDeviceId } from "../services/deviceIdentity";
import {
  LocalAudioRecorder,
  captureDiagnostics,
  captureFailureReason,
  describeCaptureFailure,
  queryMicrophonePermission,
  type CaptureDiagnostics,
  type RecordedClip,
} from "../services/audioCapture";
import {
  LocalSpeechError,
  playLocalSpeech,
  releasePlaybackCache,
  stopLocalPlayback,
} from "../services/speechPlayback";

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

/**
 * Why a session view is over, so the closed screen can say which one happened.
 *
 * "expired" also covers a join link that no longer resolves at all: from this device
 * the two are indistinguishable, and "has ended or expired" is the honest sentence.
 */
type EndReason = "host" | "self" | "expired";

/**
 * How long the microphone is given to start before the button is handed back.
 *
 * Generous, because there is a person deciding in the middle of it, and finite,
 * because a permission prompt that is never answered must not become a button that
 * waits for the rest of the session. Nothing else on this page is blocked by it.
 */
const START_WATCHDOG_MS = 30_000;

export default function PrivateSessionParticipant({ sessionId, token, onClosed }: Props) {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  /**
   * How this session finished, or null while it is still going. A reason rather than
   * a bare flag, because the closed screen has to say what actually happened:
   * "ended by host" is wrong when this device ended it, and alarming when the link
   * simply expired.
   */
  const [sessionClosed, setSessionClosed] = useState<EndReason | null>(null);
  /** Back button pressed: the question this page always asks before leaving. */
  const [leavePrompt, setLeavePrompt] = useState(false);
  /** Refused the client role: another device joined this session first. */
  const [rejected, setRejected] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);
  /** This device ended the session, so the broadcast must not relabel the reason. */
  const endedHereRef = useRef(false);
  const ended = sessionClosed !== null;
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const [hostTranslating, setHostTranslating] = useState(false);
  const [language, setLanguage] = useState<Language>(Language.SWAHILI);
  const [domain, setDomain] = useState<AppDomain>(AppDomain.CLINIC);
  const [capabilityLabel, setCapabilityLabel] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  /** True while the host's local voice engine is still producing the clip. */
  const [speechLoading, setSpeechLoading] = useState(false);
  const recorderRef = useRef<LocalAudioRecorder | null>(null);
  /** The in-flight `start()`, so a second tap can stop what the first one began. */
  const startRef = useRef<Promise<void> | null>(null);
  /** Set on unmount: a permission prompt answered afterwards must not open the mic. */
  const goneRef = useRef(false);

  /**
   * Leaving this page releases the clips cached in this browser and closes the
   * microphone. `goneRef` also covers the window where the stream has not been
   * granted yet: the recorder checks it once the permission prompt is answered, so
   * a prompt dismissed after navigation cannot leave a live microphone behind.
   */
  useEffect(() => {
    // Reset, not merely arm. React runs a setup/cleanup pair twice in StrictMode, on
    // the same instance with the same refs, so a `goneRef` left true by the first
    // cleanup would silently cancel every capture this page ever started.
    goneRef.current = false;
    return () => {
      goneRef.current = true;
      recorderRef.current?.cancel();
      recorderRef.current = null;
      releasePlaybackCache();
    };
  }, []);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const socket = io({
      path: "/socket.io",
      auth: {
        sessionId,
        token,
        role: "participant",
        // The device that owns this session's client role: the same value every time
        // this browser joins, so a reconnect or a deliberate rejoin counts as the same
        // device while a different phone is refused. See services/deviceIdentity.
        clientId: participantDeviceId(),
      },
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      setError(null);
      // A refusal is not sticky: on a later successful connect (this device does own
      // the binding) the rejection screen is gone.
      setRejected(null);
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
    socket.on("connect_error", (failure: Error & { data?: { code?: string } }) => {
      setConnected(false);
      const code = failure?.data?.code;

      if (code === "client-bound") {
        // Another device owns this session's client role. The session is still
        // running - this link is simply not the one that joined first - so it says
        // exactly that, in the server's own words, instead of implying the link is
        // broken. Retrying would only repeat the refusal.
        setRejected(
          typeof failure.message === "string" && failure.message.length > 0
            ? failure.message
            : "This session already has a connected participant."
        );
        socket.disconnect();
        return;
      }

      if (code === "unauthorized") {
        // The credential or the session itself no longer resolves. Ask the session,
        // rather than guessing: a participant coming back late must be told it ended
        // or expired instead of being shown a generic network complaint.
        void (async () => {
          const live = await fetchSession(sessionId, token);
          if (live) {
            setError("This private session could not be joined. Open the link again.");
            return;
          }
          setSessionClosed("expired");
          setError(null);
          socket.disconnect();
        })();
        return;
      }

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
      // The host ended it, this device ended it, or the expiry sweep did. The
      // broadcast is identical in all three cases, so the reason comes from whether
      // this device was the one that asked.
      setSessionClosed(endedHereRef.current ? "self" : "host");
      setConnected(false);
      setHostTranslating(false);
      setLeavePrompt(false);
      socket.disconnect();
    });

    return () => {
      socket.disconnect();
    };
  }, [sessionId, token]);

  /**
   * The phone's back button (Issue 2).
   *
   * Leaving a paired session is a decision, not an accident, so back does not
   * navigate away from it. A sentinel history entry is pushed on entry to the view
   * and pushed again the moment back is pressed: the page stays exactly where it is,
   * and the gesture becomes the one question that has to be asked - end the session,
   * or leave it running.
   *
   * There is deliberately no third path. The entry is restored *before* the question
   * appears, so back can never slide past this view into the welcome screen while the
   * session quietly carries on, and the only way out is one of the two answers.
   */
  useEffect(() => {
    // Nothing to protect once the session is over - or when this device was refused
    // the role in the first place. A rejected device is not a participant of anything,
    // and offering it "End session" would let a stranger end a session that belongs to
    // the phone that joined. Here back simply leaves.
    if (sessionClosed || rejected) return;

    const sentinel = { privateSession: sessionId };
    const url = `${window.location.pathname}#session`;
    window.history.pushState(sentinel, "", url);

    const onPopState = () => {
      window.history.pushState(sentinel, "", url);
      setLeavePrompt(true);
    };

    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      // Hand the extra entry back, or "back" would appear to do nothing once this
      // view is gone.
      if ((window.history.state as { privateSession?: string } | null)?.privateSession === sessionId) {
        window.history.back();
      }
    };
  }, [sessionId, sessionClosed, rejected]);

  /**
   * "End session": exactly the request the host's own End Session button makes, so
   * the messages and profile are purged once, `session:ended` is broadcast once, and
   * both devices reach the closed screen from that one event. Ending from the phone
   * is not a special case on the server.
   */
  const endSessionFromThisDevice = async () => {
    if (ending) return;
    setEnding(true);
    setLeavePrompt(false);
    // Set before the request: the broadcast can arrive first, and this device is the
    // one that decided - the screen must not say "ended by host".
    endedHereRef.current = true;
    await endSession(sessionId, token);
    setSessionClosed((previous) => previous ?? "self");
    setEnding(false);
  };

  /**
   * "Not now": this device leaves, the session does not.
   *
   * `disconnect()` is a clean close, so the host is told the participant
   * disconnected exactly as it would be for any other clean leave. Nothing is
   * purged, the token stays valid, and the device binding stays claimed - which is
   * what lets this same device come back with the same link and resume the
   * conversation, and what keeps a different phone out in the meantime.
   */
  const leaveWithoutEnding = () => {
    setLeavePrompt(false);
    // Deliberately a clean close rather than an abandoned socket: the server's own
    // disconnect handling is what tells the host, on this path as on every other.
    socketRef.current?.disconnect();
    onClosed();
  };

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
   * Voice input on this phone is LOCAL (Phase 7C): the same recorder, the same
   * `/api/transcribe` endpoint and the same Whisper engine the host laptop has
   * used since Phase 7A. The browser's own speech recognition is not used and not
   * referenced anywhere in this file - on Chrome it streams the speaker's voice to
   * a remote recognition service, which is exactly what a private clinic session
   * cannot accept. One mechanism, one destination: this laptop.
   *
   * Two conditions have to hold, and both are said out loud rather than hidden:
   *   - the page must be a secure context. A browser refuses `getUserMedia` on
   *     plain `http://<lan-ip>` before any of this code runs, which is why the LAN
   *     address is served over TLS with a certificate the phone was told to trust
   *     (`npm run cert:lan`, docs/phone-voice-demo.md). No insecure-origin flag, no
   *     tunnel, no click-through is offered as a substitute;
   *   - the browser must expose `getUserMedia` and Web Audio.
   *
   * Capture is the laptop's raw-PCM recorder rather than MediaRecorder: a webm or
   * mp4 clip has to be demuxed and decoded before Whisper can read it, which would
   * mean a second audio pipeline for no gain. PCM is the one format this endpoint
   * already speaks, so a phone and a laptop are the same code path.
   *
   * Voice stays optional. A session that cannot record is a session that types.
   */
  const [voiceBlocked, setVoiceBlocked] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<CaptureDiagnostics | null>(null);
  const [permission, setPermission] = useState("not queried");

  /**
   * Readiness is answered from what this device exposes, and then re-answered
   * whenever the page comes back to the front - not once, when it is opened.
   *
   * The order people actually do things in is what forces this: the page is opened,
   * the microphone is refused, it is granted in the browser's site settings, and the
   * page is brought back. A verdict taken at mount and never retaken would keep the
   * button grey for a permission that has since been granted, which is a state on
   * screen that cannot change when the fact behind it changes.
   *
   * The verdict itself is capability only: secure context plus the APIs being
   * present. Permission is deliberately not pre-checked - `permissions.query` is
   * unusable for this on several mobile browsers - so the tap is what asks, and what
   * settles, whether this device may record.
   */
  useEffect(() => {
    const evaluate = () => {
      const snapshot = captureDiagnostics();
      setVoiceBlocked(snapshot.blockedBy);
      setDiagnostics(snapshot);
      // Also on the console, for a laptop with remote inspection attached: the same
      // facts next to whatever else the browser reports.
      console.debug("[voice] capture readiness", snapshot);
      void queryMicrophonePermission().then(setPermission);
    };

    evaluate();
    const onReturn = () => {
      if (document.visibilityState === "visible") evaluate();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, []);

  /** What the microphone button is worth right now, or why it is not. */
  const voiceNotice = voiceBlocked ?? voiceError;

  /** The one label the diagnostic readout shows for what the button is doing. */
  const voicePhase = voiceBlocked
    ? "unavailable"
    : recording
      ? "recording"
      : starting
        ? "starting"
        : transcribing
          ? "transcribing"
          : "ready";

  const flag = (value: boolean | undefined) => (value === undefined ? "?" : value ? "yes" : "no");

  /** What the closed screen says, in the words of what actually happened. */
  const closedHeadline =
    sessionClosed === "self"
      ? "You ended this session."
      : sessionClosed === "host"
        ? "Session ended by host."
        : "This session has ended or expired.";
  const closedDetail =
    sessionClosed === "expired"
      ? "Nothing was saved. Ask the host for a new pairing code to start again."
      : "This pairing code can no longer be used.";

  const voiceTitle = recording
    ? "Stop and transcribe on the host laptop"
    : starting
      ? "Waiting for the microphone..."
      : transcribing
        ? "Transcribing locally..."
        : `Speak in ${language}`;

  /**
   * Finishes a recording and asks the host laptop to transcribe it.
   *
   * The clip is the same raw PCM the laptop sends, and the request carries the
   * session's own token: a recording from another device is only accepted for the
   * session it belongs to, and nothing is stored either side. The transcript lands
   * in the text box instead of being sent straight away, so a mis-heard symptom can
   * be corrected before a clinician reads it - and so that speaking and typing
   * share one identical send path.
   */
  const stopAndTranscribe = async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    setRecording(false);
    if (!recorder || !recorder.isRecording) return;

    let clip: RecordedClip;
    try {
      clip = await recorder.stop();
    } catch (captureError) {
      setVoiceError(describeCaptureFailure(captureError));
      setDiagnostics(captureDiagnostics());
      void queryMicrophonePermission().then(setPermission);
      return;
    }

    // The microphone is released by stop(); the clip now exists only in this tab.
    setTranscribing(true);
    try {
      const text = await transcribeAudio(clip, String(language), domain, { sessionId, token });
      setVoiceError(null);
      if (text.trim()) {
        setInput((previous) => (previous.trim() ? `${previous.trim()} ${text.trim()}` : text.trim()));
      }
    } catch (transcriptionError) {
      setVoiceError(
        transcriptionError instanceof Error
          ? transcriptionError.message
          : "Local transcription failed. Please type the message - it is translated the same way."
      );
    } finally {
      setTranscribing(false);
    }
  };

  /**
   * Push to talk: tap once to start, tap again to stop (Phase 7C).
   *
   * Hold-to-record was the other candidate and was rejected: a phone locks its
   * screen, a notification takes focus, and a browser that loses the gesture can
   * end the capture silently, so a control that depends on a finger staying down
   * can lose a sentence without anyone noticing. Two taps always have a definite
   * end, and the second tap also submits the clip, which is one gesture fewer on a
   * small screen.
   *
   * Nothing here can stop a message being typed: `send` below never looks at the
   * recorder, and every failure on this path only sets a banner.
   *
   * The awkward case is the second tap arriving *while the browser is still asking
   * for permission*. That tap cancels: nothing has been captured yet, so there is no
   * clip to stop and no microphone to hold open. Ignoring it would leave a live
   * microphone behind a button that looks idle.
   */
  const toggleVoice = async () => {
    if (transcribing) return;

    if (starting || startRef.current) {
      // Nothing has been captured while the browser is still asking for permission, so
      // this tap cancels. The start's own continuation closes the microphone once the
      // prompt is finally answered, because `recorderRef` no longer points at it. The
      // ref is checked as well as the state because React batches state updates, so a
      // double tap inside one frame would otherwise begin two starts.
      recorderRef.current = null;
      startRef.current = null;
      setVoiceError(null);
      setStarting(false);
      return;
    }

    if (recording) {
      await stopAndTranscribe();
      return;
    }

    const reason = captureFailureReason();
    if (reason) {
      // Say why instead of leaving a button that appears to do nothing.
      setVoiceBlocked(reason);
      return;
    }

    setVoiceError(null);
    const recorder = new LocalAudioRecorder();
    recorderRef.current = recorder;
    setStarting(true);
    const start = recorder.start();
    startRef.current = start;
    // A start may wait on a permission prompt, which is a person's decision and can
    // take a while - so it is given time, but a finite amount of it. Whatever happens,
    // the button comes back and the fallback is named; a spinner nobody can clear is
    // not an option on a phone in a consultation.
    let watchdog: number | undefined;
    const expired = new Promise<"expired">((resolve) => {
      watchdog = window.setTimeout(() => resolve("expired"), START_WATCHDOG_MS);
    });
    try {
      // The permission prompt happens here, on the tap - which is what a mobile
      // browser requires of a microphone gesture.
      const outcome = await Promise.race([start.then(() => "started" as const), expired]);
      // Only clear the slot if it is still this start: a cancel followed by a new tap
      // may already have put a newer one there.
      if (startRef.current === start) startRef.current = null;

      if (outcome === "expired") {
        // `cancel()` is what releases a microphone granted after this point, and
        // nothing is recorded while it is unclear whether this page may record at all.
        recorder.cancel();
        if (recorderRef.current === recorder) recorderRef.current = null;
        setVoiceError(
          "The microphone did not start. If the browser is still asking for permission, answer it and tap again - or type the message, which is translated the same way."
        );
        setDiagnostics(captureDiagnostics());
        void queryMicrophonePermission().then(setPermission);
        return;
      }

      // The page can be left, or a newer recorder created, while that prompt is up.
      // Either way this recorder owns an open microphone and has to give it back -
      // and a recorder cancelled while it was starting is not recording, so a resolved
      // start is not on its own a reason to show the recording state.
      if (!recorder.isRecording || goneRef.current || recorderRef.current !== recorder) {
        recorder.cancel();
        if (recorderRef.current === recorder) recorderRef.current = null;
        return;
      }

      setVoiceBlocked(null);
      setRecording(true);
    } catch (captureError) {
      if (startRef.current === start) startRef.current = null;
      recorder.cancel();
      if (recorderRef.current === recorder) recorderRef.current = null;
      setRecording(false);
      // A refusal is a sentence naming the fallback, not a DOMException name.
      setVoiceError(describeCaptureFailure(captureError));
      setDiagnostics(captureDiagnostics());
      void queryMicrophonePermission().then(setPermission);
    } finally {
      if (watchdog !== undefined) window.clearTimeout(watchdog);
      setStarting(false);
    }
  };

  /**
   * Replay a translated line with the LOCAL voice engine (Phase 7B).
   *
   * The clip is produced on the host laptop and returned as audio; this device
   * only plays it. The browser's own speech synthesis is deliberately not used:
   * on several platforms it is a remote service, and this line is a translation
   * of a private conversation. When playback is unavailable the session stays
   * connected and typed messages keep working.
   */
  const speak = async (text: string, id: string) => {
    if (speakingId === id) {
      stopLocalPlayback();
      setSpeakingId(null);
      setSpeechLoading(false);
      return;
    }

    stopLocalPlayback();
    setError(null);
    setSpeakingId(id);
    setSpeechLoading(true);

    try {
      await playLocalSpeech(text, language);
    } catch (playbackError) {
      setError(
        playbackError instanceof LocalSpeechError && playbackError.inputProblem
          ? playbackError.message
          : "Local voice playback unavailable."
      );
    } finally {
      setSpeakingId(null);
      setSpeechLoading(false);
    }
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
                      disabled={speechLoading && speakingId === message.id}
                      title={
                        speechLoading && speakingId === message.id
                          ? "Producing the clip with the host's local voice engine..."
                          : "Replay this line with the host's local voice engine"
                      }
                      className={`shrink-0 rounded-full p-1.5 ${
                        speakingId === message.id ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {speechLoading && speakingId === message.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Volume2 className="h-3.5 w-3.5" />
                      )}
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
        {rejected ? (
          /*
            Case C: the session is alive, this device is simply not its participant.
            Worded so nobody thinks the link is broken or the server is down.
          */
          <div className="rounded-2xl bg-slate-900 p-5 text-center text-white shadow-sm">
            <p className="text-sm font-bold">{rejected}</p>
            <p className="mt-1 text-xs text-slate-300">
              Only the device that joined first can use this link. The session is still running without this device.
            </p>
            <button
              onClick={onClosed}
              className="mt-3 rounded-xl bg-white/10 px-4 py-2 text-[11px] font-bold uppercase tracking-widest"
            >
              Close
            </button>
          </div>
        ) : ended ? (
          <div className="rounded-2xl bg-slate-900 p-5 text-center text-white shadow-sm">
            <p className="text-sm font-bold">{closedHeadline}</p>
            <p className="mt-1 text-xs text-slate-300">{closedDetail}</p>
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
                  onClick={toggleVoice}
                  disabled={transcribing}
                  aria-pressed={recording}
                  title={voiceTitle}
                  className={`shrink-0 rounded-xl p-3 ${
                    recording
                      ? "bg-red-600 text-white"
                      : starting || transcribing || voiceBlocked
                        ? "bg-slate-50 text-slate-400"
                        : "bg-slate-100 text-slate-600"
                  }`}
                >
                  {starting || transcribing ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : recording ? (
                    <MicOff className="h-5 w-5" />
                  ) : (
                    <Mic className="h-5 w-5" />
                  )}
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
              {starting && (
                <p className="mt-2 text-[10px] font-semibold text-slate-500">
                  Waiting for the microphone - allow it when the browser asks. Tap again to cancel.
                </p>
              )}
              {recording && (
                <p className="mt-2 text-[10px] font-semibold text-red-600">
                  Listening - tap the microphone again when you have finished speaking.
                </p>
              )}
              {transcribing && (
                <p className="mt-2 text-[10px] font-semibold text-amber-600">
                  Transcribing on the host laptop...
                </p>
              )}
              {voiceNotice && (
                <p className="mt-2 text-[10px] font-medium leading-snug text-slate-500">{voiceNotice}</p>
              )}
              {/*
                Device diagnostics, rendered on the phone, because the phone is the only
                machine that can answer "why is the microphone button grey?". It reports
                what this device says about itself and nothing about the host: no
                provider, no model, no prompt. Collapsed by default so the session looks
                the same; one tap to read out what is actually true on the failing device.
              */}
              <details className="mt-2">
                <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-widest text-slate-400">
                  Voice diagnostics
                </summary>
                <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 font-mono text-[10px] leading-relaxed text-slate-500">
                  <dt>phase</dt>
                  <dd>{voicePhase}</dd>
                  <dt>secure-context</dt>
                  <dd>{flag(diagnostics?.secureContext)}</dd>
                  <dt>mediaDevices</dt>
                  <dd>{flag(diagnostics?.mediaDevices)}</dd>
                  <dt>getUserMedia</dt>
                  <dd>{flag(diagnostics?.getUserMedia)}</dd>
                  <dt>audioContext</dt>
                  <dd>{flag(diagnostics?.audioContext)}</dd>
                  <dt>permission</dt>
                  <dd>{permission} (reported, never trusted)</dd>
                  <dt>blocked-by</dt>
                  <dd>{voiceBlocked ?? "nothing"}</dd>
                  <dt>last-error</dt>
                  <dd>{voiceError ?? "none"}</dd>
                </dl>
              </details>
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
      {/*
        The back button's question (Issue 2). Exactly two answers, no third: it is not
        dismissable by tapping outside, so the gesture cannot resolve itself by
        accident, and it is not an OS dialog so the wording is the wording the phone
        needs ("End session" against "Not now", not "OK" against "Cancel").
      */}
      {leavePrompt && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 p-4 sm:items-center">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="leave-session-title"
            className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl"
          >
            <p id="leave-session-title" className="text-sm font-bold text-slate-900">
              Leave this session?
            </p>
            <p className="mt-1 text-xs leading-snug text-slate-500">
              Ending it closes the session for both devices and cannot be undone. "Not now" leaves the conversation but
              keeps the session open for this device until it expires, so this link can be opened again here.
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                onClick={() => void endSessionFromThisDevice()}
                disabled={ending}
                className="rounded-xl bg-red-600 px-4 py-3 text-xs font-bold uppercase tracking-widest text-white transition-colors hover:bg-red-700 disabled:opacity-50"
              >
                {ending ? "Ending..." : "End session"}
              </button>
              <button
                onClick={leaveWithoutEnding}
                className="rounded-xl bg-slate-100 px-4 py-3 text-xs font-bold uppercase tracking-widest text-slate-600 transition-colors hover:bg-slate-200"
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

