import { useState, useRef, useEffect } from "react";
import { Send, Languages } from "lucide-react";
import { PatientData, Message, Language } from "../types";
import { translateText } from "../services/api";

interface ConversationViewProps {
  patientData: PatientData | null;
  messages: Message[];
  onUpdateMessages: (messages: Message[]) => void;
  onEndSession: () => void;
}

export default function ConversationView({
  messages,
  onUpdateMessages,
}: ConversationViewProps) {
  const [inputText, setInputText] = useState("");
  const [isTranslating, setIsTranslating] = useState(false);
  const [currentUser, setCurrentUser] = useState<"doctor" | "patient">("doctor");
  const scrollRefEn = useRef<HTMLDivElement>(null);
  const scrollRefSw = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRefEn.current) scrollRefEn.current.scrollTop = scrollRefEn.current.scrollHeight;
    if (scrollRefSw.current) scrollRefSw.current.scrollTop = scrollRefSw.current.scrollHeight;
  }, [messages]);

  const handleSendMessage = async (e: any) => {
    e.preventDefault();
    if (!inputText.trim() || isTranslating) return;

    const sourceLang = currentUser === "doctor" ? Language.ENGLISH : Language.SWAHILI;
    const targetLang = currentUser === "doctor" ? Language.SWAHILI : Language.ENGLISH;
    
    setIsTranslating(true);
    try {
      const translation = await translateText(
        inputText,
        sourceLang,
        targetLang,
        `Communication from ${currentUser} to ${currentUser === "doctor" ? "patient" : "doctor"}.`
      );

      const newMessage: Message = {
        id: crypto.randomUUID(),
        text: inputText,
        sender: currentUser,
        originalText: inputText,
        translation: translation,
        timestamp: new Date(),
      };

      onUpdateMessages([...messages, newMessage]);
      setInputText("");
    } catch (err) {
      console.error(err);
    } finally {
      setIsTranslating(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-grow grid grid-cols-2 gap-px bg-slate-200 overflow-hidden">
        {/* Doctor Interface (English) */}
        <section className="bg-white flex flex-col p-8 overflow-hidden">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xs font-bold text-blue-600 uppercase tracking-widest px-1">
              Doctor Interface (English)
            </h2>
            <span className={`text-[10px] px-2 py-1 rounded font-bold transition-colors ${
              currentUser === "doctor" ? "bg-blue-100 text-blue-600" : "bg-slate-100 text-slate-500"
            }`}>
              {currentUser === "doctor" ? "ACTIVE" : "IDLE"}
            </span>
          </div>

          <div 
            ref={scrollRefEn}
            className="flex-grow space-y-6 overflow-y-auto mb-8 pr-4 scrollbar-hide"
          >
            {messages.map((msg) => (
              <div key={msg.id} className="flex flex-col items-end">
                <div className={`p-4 rounded-2xl rounded-tr-none text-sm leading-relaxed max-w-[90%] ${
                  msg.sender === "doctor" ? "bg-slate-100 text-slate-700" : "bg-blue-50 text-blue-800 border border-blue-100"
                }`}>
                  {msg.sender === "doctor" ? msg.text : msg.translation}
                </div>
                <span className="text-[10px] text-slate-400 mt-1 uppercase font-bold">
                  {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
            {isTranslating && currentUser === "doctor" && (
              <div className="flex justify-end pr-2 animate-pulse">
                <span className="text-[10px] text-blue-400 font-bold uppercase">Processing...</span>
              </div>
            )}
          </div>

          <div className="relative">
            <textarea
              className={`w-full p-4 border rounded-xl text-sm focus:outline-none transition-colors bg-slate-50 resize-none ${
                currentUser === "doctor" ? "border-blue-400 ring-2 ring-blue-50" : "border-slate-300"
              }`}
              rows={3}
              value={currentUser === "doctor" ? inputText : ""}
              onChange={(e) => currentUser === "doctor" && setInputText(e.target.value)}
              onFocus={() => setCurrentUser("doctor")}
              placeholder="Doctor's English instructions..."
            />
            <div className="absolute bottom-3 right-3 flex gap-2">
              <button 
                onClick={handleSendMessage}
                disabled={currentUser !== "doctor" || !inputText.trim() || isTranslating}
                className="p-2 bg-blue-600 text-white rounded-lg shadow-sm hover:bg-blue-700 disabled:opacity-50 transition-all"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </div>
        </section>

        {/* Patient Interface (Swahili) */}
        <section className="bg-slate-50 flex flex-col p-8 overflow-hidden">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xs font-bold text-emerald-600 uppercase tracking-widest">
              Patient Interface (Swahili)
            </h2>
            <div className="flex items-center gap-2">
              <span className={`text-[10px] font-bold uppercase tracking-tighter ${
                currentUser === "patient" ? "text-emerald-600" : "text-slate-400"
              }`}>
                Input Zone
              </span>
              <div className="flex items-end gap-0.5 h-3">
                <div className={`w-0.5 bg-emerald-500 ${currentUser === "patient" ? "h-3" : "h-1"}`}></div>
                <div className={`w-0.5 bg-emerald-500 ${currentUser === "patient" ? "h-2" : "h-1"}`}></div>
                <div className={`w-0.5 bg-emerald-500 ${currentUser === "patient" ? "h-1" : "h-1"}`}></div>
              </div>
            </div>
          </div>

          <div 
             ref={scrollRefSw}
             className="flex-grow space-y-6 overflow-y-auto mb-8 pr-4"
          >
            {messages.map((msg) => (
              <div key={msg.id} className="flex flex-col items-start">
                <div className={`p-4 rounded-2xl rounded-tl-none border text-sm leading-relaxed max-w-[90%] shadow-sm ${
                  msg.sender === "doctor" 
                    ? "bg-white border-slate-200 text-slate-800" 
                    : "bg-emerald-600 text-white border-emerald-500"
                }`}>
                  {msg.sender === "doctor" ? msg.translation : msg.text}
                </div>
                <span className="text-[10px] text-slate-400 mt-1 uppercase font-bold">
                  {msg.sender === "patient" ? "Detected: Swahili" : "Assisted Translation"}
                </span>
              </div>
            ))}
            {isTranslating && currentUser === "patient" && (
              <div className="flex justify-start pl-2 animate-pulse">
                <span className="text-[10px] text-emerald-600 font-bold uppercase">Processing...</span>
              </div>
            )}
          </div>

          <div className="relative">
            <textarea
              className={`w-full p-4 border rounded-xl text-sm focus:outline-none transition-colors bg-white resize-none ${
                currentUser === "patient" ? "border-emerald-500 ring-2 ring-emerald-50" : "border-slate-300"
              }`}
              rows={3}
              value={currentUser === "patient" ? inputText : ""}
              onChange={(e) => currentUser === "patient" && setInputText(e.target.value)}
              onFocus={() => setCurrentUser("patient")}
              placeholder="Mgonjwa aandike hapa..."
            />
            <div className="absolute bottom-3 right-3 flex gap-2">
              <button 
                onClick={handleSendMessage}
                disabled={currentUser !== "patient" || !inputText.trim() || isTranslating}
                className="p-2 bg-emerald-600 text-white rounded-lg shadow-sm hover:bg-emerald-700 disabled:opacity-50 transition-all"
              >
                <Languages className="h-4 w-4" />
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
