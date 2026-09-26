import { useState, useEffect } from "react";
import { Copy, FileText, Check, Download, AlertCircle } from "lucide-react";
import { DomainProfile, Message, AppDomain } from "../types";
import { generateSummary } from "../services/api";

interface SummaryViewProps {
  profile: DomainProfile | null;
  conversation: Message[];
  domain: AppDomain;
}

export default function SummaryView({ profile, conversation, domain }: SummaryViewProps) {
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    async function loadSummary() {
      try {
        // The domain profile (Phase 2) is sent as "profile"; the server also
        // accepts the legacy "patientData" key.
        const text = await generateSummary(profile, conversation, domain);
        setSummary(text);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    loadSummary();
  }, [profile, conversation, domain]);

  const handleCopy = () => {
    if (summary) {
      navigator.clipboard.writeText(summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const getTheme = () => {
    switch (domain) {
      case AppDomain.HOTEL:
        return {
          title: "Lodging Booking Card",
          primaryBtn: "bg-emerald-600 hover:bg-emerald-700",
          ring: "ring-emerald-200",
          text: "text-emerald-700",
          lightBg: "bg-emerald-50",
          border: "border-emerald-100",
          alertText: "This guest preference review was drafted dynamically. Confirm all reservation parameters prior to submitting payment."
        };
      case AppDomain.OFFICE:
        return {
          title: "Sync Alignment Minutes",
          primaryBtn: "bg-violet-600 hover:bg-violet-700",
          ring: "ring-violet-200",
          text: "text-violet-700",
          lightBg: "bg-violet-50",
          border: "border-violet-100",
          alertText: "This action alignment list was automatically summarized. Verify task owners and timelines in your PM board."
        };
      default:
        return {
          title: "Clinical Visit Summary",
          primaryBtn: "bg-blue-600 hover:bg-blue-700",
          ring: "ring-blue-200",
          text: "text-blue-700",
          lightBg: "bg-blue-50",
          border: "border-blue-100",
          alertText: "This summary was generated with certified accuracy. Review for clinical details before entering into official EMR."
        };
    }
  };

  const theme = getTheme();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-3xl font-black tracking-tight">{theme.title}</h2>
        <div className="flex gap-2">
          <button
            onClick={handleCopy}
            disabled={!summary}
            className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors shadow-sm text-sm font-semibold"
          >
            {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
            {copied ? "Copied" : "Copy to Clipboard"}
          </button>
          <button
            className={`flex items-center gap-2 px-4 py-2 text-white rounded-xl transition-colors shadow-sm text-sm font-semibold ${theme.primaryBtn}`}
          >
            <Download className="h-4 w-4" />
            Save Draft
          </button>
        </div>
      </div>

      {loading ? (
         <div className="bg-white rounded-3xl p-12 shadow-sm ring-1 ring-slate-200 flex flex-col items-center justify-center space-y-4">
           <div className="relative font-semibold flex flex-col items-center">
             <div className="h-12 w-12 border-4 border-slate-100 border-t-slate-800 rounded-full animate-spin mb-4" />
             <p className="text-slate-500 text-sm">Synchronizing audio and drafting document...</p>
           </div>
         </div>
      ) : summary ? (
        <div className="bg-white rounded-3xl p-8 shadow-sm ring-1 ring-slate-200">
          <div className="prose prose-slate max-w-none">
            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-slate-755 bg-slate-55 p-6 rounded-2xl border border-slate-100">
              {summary}
            </pre>
          </div>
          
          <div className={`mt-8 p-4 ${theme.lightBg} rounded-2xl border ${theme.border} flex gap-3 text-sm ${theme.text}`}>
            <AlertCircle className="h-5 w-5 shrink-0" />
            <p>
              {theme.alertText}
            </p>
          </div>
        </div>
      ) : (
        <div className="bg-red-50 text-red-600 p-6 rounded-2xl border border-red-100 font-medium">
          Failed to compile summary. Please try again.
        </div>
      )}
    </div>
  );
}
