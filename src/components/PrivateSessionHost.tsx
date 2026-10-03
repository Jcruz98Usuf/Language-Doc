/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Private device mode - host waiting room (Phase 4).
 *
 * The host creates a temporary session, shows a QR code and the short session
 * id, and waits for the participant. The session TOKEN is never rendered as
 * text. It is encoded only in the QR fragment for the authenticated pairing
 * handshake; URL fragments are not sent to the server.
 *
 * Connection status is driven by the real-time pairing transport, with REST
 * polling retained to detect server-side expiry.
 */

import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Check, Clock, Copy, LogOut, ShieldCheck, UserCheck, Wifi } from "lucide-react";
import { AppDomain, Language } from "../types";
import { endSession, fetchCapabilities, fetchSession, type LanguageCapability, type SessionHandle } from "../services/api";

interface PrivateSessionHostProps {
  session: SessionHandle;
  domain: AppDomain;
  language: Language;
  /** Participant is connected: reveal the host conversation controls. */
  onOpenConversation: () => void;
  /** Session ended or expired: leave private mode entirely. */
  onSessionClosed: () => void;
  participantConnected?: boolean;
}

const POLL_INTERVAL_MS = 2000;

/**
 * QR payload.
 *
 * A fragment is intentionally used for the secret: browsers do not include it
 * in HTTP requests. The participant consumes and removes it before connecting.
 */
export function buildJoinPayload(joinUrl: string, token?: string): string {
  // The optional parameter retains compatibility with the removed Phase 4
  // validation harness, which asserted the non-secret id-only payload.
  return token ? `${joinUrl}#token=${encodeURIComponent(token)}` : joinUrl;
}

function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return "expired";
  const totalSeconds = Math.floor(msRemaining / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
}

export default function PrivateSessionHost({
  session,
  domain,
  language,
  onOpenConversation,
  onSessionClosed,
  participantConnected: connectedFromSocket = false,
}: PrivateSessionHostProps) {
  const [participantConnected, setParticipantConnected] = useState(connectedFromSocket);
  const [serverExpired, setServerExpired] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const closedRef = useRef(false);

  /**
   * A laptop usually has several usable addresses, and only the one on the same
   * network as the phone will work. The server lists them (HOST_URL override
   * first, then detected LAN IPv4s) so the operator can pick the right one.
   */
  const joinCandidates = session.joinUrls?.length
    ? session.joinUrls
    : session.joinUrl
      ? [session.joinUrl]
      : [];
  const [activeJoinUrl, setActiveJoinUrl] = useState<string | null>(joinCandidates[0] ?? null);

  /** Demo capability state (CORE / DEMO READY / EXPERIMENTAL) for the language. */
  const [capability, setCapability] = useState<LanguageCapability | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await fetchCapabilities();
      if (cancelled || !result) return;
      setCapability(
        result.languages.find((entry) => entry.language.toLowerCase() === String(language).toLowerCase()) ?? null
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [language]);

  // One-second tick for the expiry countdown.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Poll for liveness (expiry) and participant presence.
  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      if (closedRef.current) return;
      const state = await fetchSession(session.sessionId, session.token);
      if (cancelled || closedRef.current) return;
      if (!state) {
        setServerExpired(true);
        return;
      }
      if (state.clientConnected) setParticipantConnected(true);
      if (state.expiresAt <= Date.now()) setServerExpired(true);
    };

    void poll();
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [session.sessionId, session.token]);

  useEffect(() => setParticipantConnected(connectedFromSocket), [connectedFromSocket]);

  /**
   * Phase 7E: open the conversation as soon as the participant is here.
   *
   * The host used to have to notice the "Participant connected" badge and press
   * "Open conversation controls", which added a dead beat to every private
   * session - the two devices were already paired and talking, but the host
   * screen was still showing a QR code.
   *
   * The ref makes this fire exactly once, on the false -> true edge, so a later
   * disconnect/reconnect does not yank the host out of an in-progress
   * conversation. The manual button stays as a fallback: if auto-advance is
   * ever unwanted, the host is never trapped here.
   */
  const advancedRef = useRef(false);
  useEffect(() => {
    if (!participantConnected || serverExpired || closedRef.current || advancedRef.current) return;
    advancedRef.current = true;
    onOpenConversation();
  }, [participantConnected, serverExpired, onOpenConversation]);

  const handleEndSession = async () => {
    if (closedRef.current) return;
    closedRef.current = true;
    // Ends it server side too: token invalidated, messages and profile dropped.
    await endSession(session.sessionId, session.token);
    onSessionClosed();
  };

  const handleCopyId = async () => {
    // Only the visible id is copied - never the token.
    try {
      await navigator.clipboard.writeText(session.sessionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (permissions/insecure context): ignore.
    }
  };

  const theme =
    domain === AppDomain.HOTEL
      ? { ring: "ring-emerald-100", text: "text-emerald-700", bg: "bg-emerald-50", solid: "bg-emerald-600", dot: "bg-emerald-500" }
      : domain === AppDomain.OFFICE
        ? { ring: "ring-violet-100", text: "text-violet-700", bg: "bg-violet-50", solid: "bg-violet-600", dot: "bg-violet-500" }
        : { ring: "ring-blue-100", text: "text-blue-700", bg: "bg-blue-50", solid: "bg-blue-600", dot: "bg-blue-500" };

  const msRemaining = Math.max(0, session.expiresAt - now);
  const isExpired = serverExpired || msRemaining <= 0;

  // A language is only ever shown as demo-ready when the server registry says
  // its dedicated local MT is validated; Kiswahili stays EXPERIMENTAL.
  const capabilityLabel = capability
    ? capability.state !== "supported"
      ? capability.state === "experimental"
        ? "EXPERIMENTAL"
        : "UNAVAILABLE"
      : capability.role === "pivot"
        ? "CORE"
        : "DEMO READY"
    : null;
  const capabilityTone =
    capabilityLabel === "DEMO READY" || capabilityLabel === "CORE"
      ? "bg-emerald-50 text-emerald-700"
      : capabilityLabel === "EXPERIMENTAL"
        ? "bg-amber-50 text-amber-700"
        : "bg-slate-100 text-slate-500";

  return (
    <div className="min-h-full flex items-start justify-center py-10 px-6">
      <div className="w-full max-w-2xl bg-white rounded-[2rem] shadow-sm ring-1 ring-slate-200 overflow-hidden">
        <div className="px-8 pt-8 pb-6 border-b border-slate-100">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">Language Doctor</p>
          <h1 className="text-3xl font-black tracking-tight mt-1">Private Session</h1>
          <p className="text-sm text-slate-500 mt-2">
            One device each. Translation and profile extraction stay on this laptop.
          </p>
        </div>

        <div className="px-8 py-7 grid gap-8 sm:grid-cols-[auto_1fr] items-start">
          <div className="flex flex-col items-center gap-3">
            <div className={`rounded-2xl bg-white p-3 ring-1 ${theme.ring}`}>
              {activeJoinUrl ? (
                <QRCodeSVG value={buildJoinPayload(activeJoinUrl, session.token)} size={168} level="M" />
              ) : (
                <div className="flex h-[168px] w-[168px] items-center justify-center rounded-lg bg-slate-50 p-4 text-center text-xs font-semibold text-slate-500">
                  No LAN address detected
                </div>
              )}
            </div>
            <p className="max-w-[172px] text-center text-[10px] font-medium leading-snug text-slate-400">
              {activeJoinUrl
                ? "Scan to join this private session."
                : "Connect this laptop to the same Wi-Fi as the phone, or set HOST_URL in .env."}
            </p>
            {joinCandidates.length > 1 && (
              <div className="w-[172px]">
                <label className="sr-only" htmlFor="join-candidate">
                  Network address
                </label>
                <select
                  id="join-candidate"
                  value={activeJoinUrl ?? ""}
                  onChange={(event) => setActiveJoinUrl(event.target.value)}
                  className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[10px] font-semibold text-slate-600"
                >
                  {joinCandidates.map((candidate) => (
                    <option key={candidate} value={candidate}>
                      {candidate.replace(/^https?:\/\//, "")}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-center text-[9px] font-medium leading-snug text-slate-400">
                  Pick the address on the phone&apos;s network.
                </p>
              </div>
            )}
          </div>

          <div className="space-y-5">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Session ID</p>
              <div className="mt-1 flex items-center gap-2">
                <span className="font-mono text-2xl font-bold tracking-[0.15em] text-slate-900">
                  {session.sessionId}
                </span>
                <button
                  onClick={handleCopyId}
                  title="Copy session ID"
                  className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                >
                  {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2 text-sm font-semibold">
              {isExpired ? (
                <>
                  <Clock className="h-4 w-4 text-slate-400" />
                  <span className="text-slate-500">Session expired</span>
                </>
              ) : participantConnected ? (
                <>
                  <UserCheck className={`h-4 w-4 ${theme.text}`} />
                  <span className={theme.text}>Participant connected</span>
                  <span className={`h-2 w-2 animate-pulse rounded-full ${theme.dot}`} />
                </>
              ) : (
                <>
                  <Wifi className="h-4 w-4 animate-pulse text-slate-400" />
                  <span className="text-slate-600">Waiting for participant...</span>
                </>
              )}
            </div>

            <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-xs">
              <dt className="pt-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">Language</dt>
              <dd className="font-semibold text-slate-800">
                {language} <span className="font-normal text-slate-400">&#8596; English</span>
                {capabilityLabel && (
                  <span className={`ml-2 rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider ${capabilityTone}`}>
                    {capabilityLabel}
                  </span>
                )}
              </dd>
              <dt className="pt-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">Expires</dt>
              <dd className="font-semibold text-slate-800">
                {isExpired ? "expired" : formatCountdown(msRemaining)}
                <span className="font-normal text-slate-400"> ({new Date(session.expiresAt).toLocaleTimeString()})</span>
              </dd>
            </dl>

            <div className={`flex items-start gap-2 rounded-xl ${theme.bg} px-3 py-2.5 text-[11px] font-medium ${theme.text}`}>
              <ShieldCheck className="h-4 w-4 shrink-0" />
              <span>
                The session token stays in memory on this device. It is never shown or printed; the QR carries it only
                in a browser fragment, which is not sent to the server.
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              {isExpired ? (
                <button
                  onClick={onSessionClosed}
                  className="rounded-xl bg-slate-900 px-5 py-3 text-xs font-bold uppercase tracking-widest text-white transition-colors hover:bg-slate-800"
                >
                  Back to start
                </button>
              ) : (
                <>
                  {participantConnected && (
                    <button
                      onClick={onOpenConversation}
                      className={`rounded-xl ${theme.solid} px-5 py-3 text-xs font-bold uppercase tracking-widest text-white shadow-sm transition-opacity hover:opacity-90`}
                    >
                      Open conversation controls
                    </button>
                  )}
                  <button
                    onClick={() => void handleEndSession()}
                    className="flex items-center gap-2 rounded-xl border border-slate-200 px-5 py-3 text-xs font-bold uppercase tracking-widest text-slate-500 transition-colors hover:border-slate-300 hover:text-slate-900"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    End Session
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
