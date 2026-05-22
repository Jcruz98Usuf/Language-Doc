import { useState, useRef, useEffect } from "react";
import { Send, Languages, Mic, MicOff, Volume2 } from "lucide-react";
import { PatientData, Message, Language } from "../types";
import { translateText } from "../services/api";

interface ConversationViewProps {
  patientData: PatientData | null;
  messages: Message[];
  onUpdateMessages: (messages: Message[]) => void;
  onEndSession: () => void;
}

export default function ConversationView({
  patientData,
  messages,
  onUpdateMessages,
  onEndSession,
}: ConversationViewProps) {
  const [inputText, setInputText] = useState("");
  const [isTranslating, setIsTranslating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<"doctor" | "patient">("doctor");
  const scrollRefEn = useRef<HTMLDivElement>(null);
  const scrollRefSw = useRef<HTMLDivElement>(null);

  // Speech and Voice Interaction States
  const [isListeningEn, setIsListeningEn] = useState(false);
  const [isListeningSw, setIsListeningSw] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [currentlySpeakingId, setCurrentlySpeakingId] = useState<string | null>(null);
  const [isAutoTtsEnabled, setIsAutoTtsEnabled] = useState(true);

  const recognitionRef = useRef<any>(null);
  const currentListeningUserRef = useRef<"doctor" | "patient" | null>(null);

  const isRecognitionActiveRef = useRef(false);
  const pendingStartUserRef = useRef<"doctor" | "patient" | null>(null);
  const ignoreNextSubmitRef = useRef<boolean>(false);

  // Latest Ref Pattern bindings to completely avoid event handler staleness
  const messagesRef = useRef(messages);
  const isTranslatingRef = useRef(isTranslating);
  const isAutoTtsEnabledRef = useRef(isAutoTtsEnabled);
  const translateAndSendMessageRef = useRef<any>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    isTranslatingRef.current = isTranslating;
  }, [isTranslating]);

  useEffect(() => {
    isAutoTtsEnabledRef.current = isAutoTtsEnabled;
  }, [isAutoTtsEnabled]);

  useEffect(() => {
    if (scrollRefEn.current) scrollRefEn.current.scrollTop = scrollRefEn.current.scrollHeight;
    if (scrollRefSw.current) scrollRefSw.current.scrollTop = scrollRefSw.current.scrollHeight;
  }, [messages]);

  // Handle Speech Recognition Setup (Runs exactly once on mount, fully isolated and leak-free)
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      const rec = new SpeechRecognition();
      rec.continuous = false; // Stops recording when user pauses speaking for automatic translation
      rec.interimResults = true; // Provides dynamic in-progress translations

      rec.onstart = () => {
        isRecognitionActiveRef.current = true;
        setInterimTranscript("");
      };

      rec.onresult = (event: any) => {
        let final = "";
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            final += event.results[i][0].transcript;
          } else {
            interim += event.results[i][0].transcript;
          }
        }
        
        if (final) {
          setInputText(final);
          setInterimTranscript("");
        } else if (interim) {
          setInterimTranscript(interim);
        }
      };

      rec.onerror = (event: any) => {
        const errType = event.error;
        console.warn("Speech Recognition Info:", errType);
        
        if (errType === "not-allowed") {
          setError("Microphone permission denied. Please verify microphone access in browser settings.");
        } else if (errType === "network") {
          // Graceful handling for Web Speech API cloud network drops
          console.warn("Speech recognition network interruption detected. Continuing consultation...");
        } else if (errType === "aborted") {
          // Expected when we intentionally reset / switch voices
          console.log("Speech recognition successfully stopped/aborted.");
        } else {
          setError(`Speech input error: ${errType}`);
        }
        
        isRecognitionActiveRef.current = false;
        setIsListeningEn(false);
        setIsListeningSw(false);
        setInterimTranscript("");
      };

      rec.onend = () => {
        isRecognitionActiveRef.current = false;
        setIsListeningEn(false);
        setIsListeningSw(false);
        setInterimTranscript("");

        const shouldIgnore = ignoreNextSubmitRef.current;
        ignoreNextSubmitRef.current = false;

        // Auto-submit recognized speech text with zero-tap convenience after speech ends
        setInputText((latestText) => {
          if (!shouldIgnore && latestText.trim()) {
            const sender = currentListeningUserRef.current;
            if (sender) {
              setTimeout(() => {
                translateAndSendMessageRef.current?.(latestText, sender);
              }, 150); // Fast translation start delay (under 200ms)
            }
          }
          return "";
        });

        // Safe delayed start execution to completely prevent concurrent browser start errors
        if (pendingStartUserRef.current) {
          const nextUser = pendingStartUserRef.current;
          pendingStartUserRef.current = null;
          setTimeout(() => {
            startListening(nextUser);
          }, 60);
        }
      };

      recognitionRef.current = rec;
    }

    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch (e) {
          console.error("Cleanup error on speech recognition:", e);
        }
      }
    };
  }, []); // Run ONLY once on mount!

  // Voice output (TTS) with native engine
  const speakText = (text: string, lang: "en" | "sw", messageId: string) => {
    if (!window.speechSynthesis) return;

    if (currentlySpeakingId === messageId) {
      window.speechSynthesis.cancel();
      setCurrentlySpeakingId(null);
      return;
    }

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    const voices = window.speechSynthesis.getVoices();
    let targetVoice = null;

    if (lang === "sw") {
      // Swahili localized reader voice
      targetVoice = voices.find(v => v.lang.startsWith("sw")) || null;
      utterance.lang = "sw-KE";
    } else {
      // English reading voice
      targetVoice = voices.find(v => v.lang.startsWith("en")) || null;
      utterance.lang = "en-US";
    }

    if (targetVoice) {
      utterance.voice = targetVoice;
    }

    utterance.onend = () => setCurrentlySpeakingId(null);
    utterance.onerror = () => setCurrentlySpeakingId(null);

    setCurrentlySpeakingId(messageId);
    window.speechSynthesis.speak(utterance);
  };

  const startListening = (user: "doctor" | "patient") => {
    if (!recognitionRef.current) {
      setError("Speech recognition is not fully supported in this iframe. Try opening the preview in a new tab.");
      return;
    }

    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
      setCurrentlySpeakingId(null);
    }

    currentListeningUserRef.current = user;
    setCurrentUser(user);
    setInputText("");
    setInterimTranscript("");

    // If already active, schedule deferred startup via pendingStartUserRef and abort current
    if (isRecognitionActiveRef.current) {
      pendingStartUserRef.current = user;
      ignoreNextSubmitRef.current = true;
      try {
        recognitionRef.current.abort();
      } catch (e) {
        console.error("Failed to abort speech recognition:", e);
      }
      return;
    }

    if (user === "doctor") {
      recognitionRef.current.lang = "en-US";
      setIsListeningEn(true);
      setIsListeningSw(false);
    } else {
      recognitionRef.current.lang = "sw-TZ";
      setIsListeningSw(true);
      setIsListeningEn(false);
    }

    try {
      recognitionRef.current.start();
    } catch (e: any) {
      console.error("Failed to start speech recognition:", e);
      // Emergency recovery flow: If the browser was active behind the scenes, abort and defer 
      if (e?.message && e.message.includes("already started")) {
        pendingStartUserRef.current = user;
        ignoreNextSubmitRef.current = true;
        try {
          recognitionRef.current.abort();
        } catch (abortErr) {
          console.error("Emergency abort failed:", abortErr);
        }
      }
    }
  };

  const stopListening = () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch (e) {
        console.error("Failed to stop speech recognition:", e);
      }
    }
    setIsListeningEn(false);
    setIsListeningSw(false);
    setInterimTranscript("");
  };

  const translateAndSendMessage = async (textToSend: string, sender: "doctor" | "patient") => {
    if (!textToSend.trim() || isTranslating) return;

    setError(null);
    const sourceLang = sender === "doctor" ? Language.ENGLISH : Language.SWAHILI;
    const targetLang = sender === "doctor" ? Language.SWAHILI : Language.ENGLISH;
    
    setIsTranslating(true);
    try {
      const translation = await translateText(
        textToSend,
        sourceLang,
        targetLang,
        `Communication from ${sender} to ${sender === "doctor" ? "patient" : "doctor"}.`
      );

      const newMessage: Message = {
        id: crypto.randomUUID(),
        text: textToSend,
        sender: sender,
        originalText: textToSend,
        translation: translation,
        timestamp: new Date(),
      };

      onUpdateMessages([...messages, newMessage]);

      // Speak translation out loud automatically on the target side for maximum life
      if (isAutoTtsEnabled) {
        if (sender === "doctor") {
          speakText(translation, "sw", newMessage.id);
        } else {
          speakText(translation, "en", newMessage.id);
        }
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "An unexpected error occurred during translation.");
    } finally {
      setIsTranslating(false);
    }
  };

  // Synchronize the ref with the latest render closure of translateAndSendMessage
  useEffect(() => {
    translateAndSendMessageRef.current = translateAndSendMessage;
  });

  const handleSendMessage = async (e: any) => {
    e.preventDefault();
    if (!inputText.trim() || isTranslating) return;
    const currentText = inputText;
    setInputText("");
    await translateAndSendMessage(currentText, currentUser);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Top Bar real-time parameters */}
      <div className="bg-slate-50 border-b border-slate-200 px-8 py-3.5 flex items-center justify-between text-xs font-semibold text-slate-500 shrink-0">
        <div className="flex items-center gap-2">
          <Languages className="h-4 w-4 text-blue-600 animate-pulse" />
          <span className="tracking-wider text-[11px] uppercase font-bold text-slate-600">Speech & Language Engine Active</span>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer select-none text-[11px] font-bold uppercase tracking-wider text-slate-500">
            <input 
              type="checkbox" 
              checked={isAutoTtsEnabled} 
              onChange={(e) => {
                setIsAutoTtsEnabled(e.target.checked);
                if (!e.target.checked && window.speechSynthesis) {
                  window.speechSynthesis.cancel();
                  setCurrentlySpeakingId(null);
                }
              }} 
              className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 h-4 w-4 cursor-pointer"
            />
            <span>Auto-Speak Translations (TTS)</span>
          </label>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border-b border-red-100 p-3 flex items-center justify-between animate-in slide-in-from-top duration-300 shrink-0">
          <div className="flex items-center gap-2 text-red-600 text-xs font-bold uppercase tracking-wider">
            <span className="h-2 w-2 rounded-full bg-red-600 animate-pulse" />
            Error: {(error.toLowerCase().includes("api key") || error.includes("GEMINI_API_KEY")) 
              ? "API Key Configuration Required (Check Secrets Panel)" 
              : error}
          </div>
          <button onClick={() => setError(null)} className="text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded font-black hover:bg-red-200 transition-colors">DISMISS</button>
        </div>
      )}

      <div className="flex-grow grid grid-cols-2 gap-px bg-slate-200 overflow-hidden">
        {/* Doctor Interface (English) */}
        <section className="bg-white flex flex-col p-8 overflow-hidden">
          <div className="flex items-center justify-between mb-6 shrink-0">
            <h2 className="text-xs font-bold text-blue-600 uppercase tracking-widest px-1">
              Doctor Interface (English)
            </h2>
            <div className="flex items-center gap-2">
              {isListeningEn && (
                <div className="flex items-center gap-1.5 bg-red-50 text-red-600 text-[10px] px-2 py-1 rounded-full font-bold uppercase tracking-wider animate-pulse">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-600" />
                  Listening
                  <div className="flex gap-0.5 items-end h-2 ml-1">
                    <div className="w-0.5 bg-red-500 h-2 animate-bounce" style={{ animationDelay: '0.1s' }} />
                    <div className="w-0.5 bg-red-500 h-3 animate-bounce" style={{ animationDelay: '0.2s' }} />
                    <div className="w-0.5 bg-red-500 h-1.5 animate-bounce" style={{ animationDelay: '0.3s' }} />
                  </div>
                </div>
              )}
              <span className={`text-[10px] px-2 py-1 rounded font-bold transition-all ${
                currentUser === "doctor" ? "bg-blue-100 text-blue-600 shadow-sm" : "bg-slate-100 text-slate-500"
              }`}>
                {currentUser === "doctor" ? (isListeningEn ? "SPEAKING" : "ACTIVE") : "IDLE"}
              </span>
            </div>
          </div>

          <div 
            ref={scrollRefEn}
            className="flex-grow space-y-6 overflow-y-auto mb-8 pr-4 scrollbar-hide"
          >
            {messages.map((msg) => {
              const speakTargetText = msg.sender === "doctor" ? msg.text : msg.translation;
              const isSpeaking = currentlySpeakingId === msg.id;

              return (
                <div key={msg.id} className="flex flex-col items-end group/msg">
                  <div className="flex items-center gap-2.5 max-w-[90%] justify-end">
                    <button 
                      onClick={() => speakText(speakTargetText, "en", msg.id)}
                      className={`p-2 rounded-full transition-all border shrink-0 ${
                        isSpeaking 
                          ? "bg-blue-500 text-white border-blue-400 shadow-sm scale-105" 
                          : "text-slate-400 hover:text-blue-600 bg-white border-slate-100 hover:border-blue-100 hover:shadow-sm opacity-100 lg:opacity-0 group-hover/msg:opacity-100 focus:opacity-100"
                      }`}
                      title={isSpeaking ? "Mute Speech" : "Speak translated dialogue (English)"}
                    >
                      <Volume2 className={`h-3.5 w-3.5 ${isSpeaking ? "animate-pulse" : ""}`} />
                    </button>
                    <div className={`p-4 rounded-2xl rounded-tr-none text-sm leading-relaxed shadow-sm transition-all ${
                      msg.sender === "doctor" 
                        ? "bg-slate-100 text-slate-700 rounded-2xl rounded-tr-none border border-slate-200/50" 
                        : "bg-blue-50 text-blue-800 border border-blue-100"
                    }`}>
                      {speakTargetText}
                    </div>
                  </div>
                  <span className="text-[10px] text-slate-400 mt-1 uppercase font-bold pr-1 select-none">
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              );
            })}
            {isTranslating && currentUser === "doctor" && (
              <div className="flex justify-end pr-2 animate-pulse">
                <span className="text-[10px] text-blue-500 font-bold uppercase tracking-wider">Processing Swahili Translation...</span>
              </div>
            )}
          </div>

          <div className="relative shrink-0">
            <textarea
              className={`w-full p-4 pb-14 border rounded-xl text-sm focus:outline-none transition-all bg-slate-50 resize-none ${
                currentUser === "doctor" ? "border-blue-400 ring-2 ring-blue-50 bg-white" : "border-slate-300"
              }`}
              rows={3}
              value={isListeningEn ? (inputText || interimTranscript) : (currentUser === "doctor" ? inputText : "")}
              onChange={(e) => {
                if (currentUser === "doctor") {
                  setInputText(e.target.value);
                  setInterimTranscript("");
                }
              }}
              onFocus={() => setCurrentUser("doctor")}
              placeholder={isListeningEn ? "🎙️ Listening... keep speaking" : "Type instructions here or tap Voice to speak..."}
              disabled={isListeningEn}
            />
            
            {/* Real-time word feedback line when speaking */}
            {isListeningEn && interimTranscript && (
              <div className="absolute left-4 bottom-14 right-4 text-xs italic text-blue-500 font-medium truncate pointer-events-none">
                Capturing: "{interimTranscript}"
              </div>
            )}

            <div className="absolute bottom-3 right-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => isListeningEn ? stopListening() : startListening("doctor")}
                className={`p-2.5 rounded-lg shadow-sm transition-all flex items-center justify-center border ${
                  isListeningEn 
                    ? "bg-red-500 border-red-400 text-white animate-pulse hover:bg-red-600" 
                    : "bg-white text-slate-600 hover:text-blue-600 hover:bg-blue-50 border-slate-200"
                }`}
                title={isListeningEn ? "Stop speaking" : "Speak English voice input"}
              >
                {isListeningEn ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </button>
              <button 
                onClick={handleSendMessage}
                disabled={currentUser !== "doctor" || !inputText.trim() || isTranslating || isListeningEn}
                className="p-2.5 bg-blue-600 text-white border border-blue-500 rounded-lg shadow-sm hover:bg-blue-700 disabled:opacity-40 transition-all flex items-center justify-center"
                title="Send translating message"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </div>
        </section>

        {/* Patient Interface (Swahili) */}
        <section className="bg-slate-50 flex flex-col p-8 overflow-hidden border-l border-slate-200">
          <div className="flex items-center justify-between mb-6 shrink-0">
            <h2 className="text-xs font-bold text-emerald-600 uppercase tracking-widest">
              Patient Interface (Swahili)
            </h2>
            <div className="flex items-center gap-2.5">
              {isListeningSw && (
                <div className="flex items-center gap-1.5 bg-red-50 text-red-600 text-[10px] px-2 py-1 rounded-full font-bold uppercase tracking-wider animate-pulse">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-600" />
                  Inasikiliza
                  <div className="flex gap-0.5 items-end h-2 ml-1">
                    <div className="w-0.5 bg-red-500 h-2 animate-bounce" style={{ animationDelay: '0.1s' }} />
                    <div className="w-0.5 bg-red-500 h-3 animate-bounce" style={{ animationDelay: '0.2s' }} />
                    <div className="w-0.5 bg-red-500 h-1.5 animate-bounce" style={{ animationDelay: '0.3s' }} />
                  </div>
                </div>
              )}
              <span className={`text-[10px] px-2 py-1 rounded font-bold transition-all ${
                currentUser === "patient" ? "bg-emerald-100 text-emerald-600 shadow-sm" : "bg-slate-100 text-slate-500"
              }`}>
                {currentUser === "patient" ? (isListeningSw ? "MGONJWA ANAONGEA" : "ACTIVE") : "IDLE"}
              </span>
            </div>
          </div>

          <div 
             ref={scrollRefSw}
             className="flex-grow space-y-6 overflow-y-auto mb-8 pr-4"
          >
            {messages.map((msg) => {
              const speakTargetText = msg.sender === "doctor" ? msg.translation : msg.text;
              const isSpeaking = currentlySpeakingId === msg.id;

              return (
                <div key={msg.id} className="flex flex-col items-start group/msg">
                  <div className="flex items-center gap-2.5 max-w-[90%]">
                    <div className={`p-4 rounded-2xl rounded-tl-none border text-sm leading-relaxed shadow-sm transition-all ${
                      msg.sender === "doctor" 
                        ? "bg-white border-slate-200 text-slate-800" 
                        : "bg-emerald-600 text-white border-emerald-500"
                    }`}>
                      {speakTargetText}
                    </div>
                    <button 
                      onClick={() => speakText(speakTargetText, "sw", msg.id)}
                      className={`p-2 rounded-full transition-all border shrink-0 ${
                        isSpeaking 
                          ? "bg-emerald-500 text-white border-emerald-400 shadow-sm scale-105" 
                          : "text-slate-400 hover:text-emerald-600 bg-white border-slate-100 hover:border-emerald-100 hover:shadow-sm opacity-100 lg:opacity-0 group-hover/msg:opacity-100 focus:opacity-100"
                      }`}
                      title={isSpeaking ? "Nyamaza" : "Soma kwa sauti (Swahili)"}
                    >
                      <Volume2 className={`h-3.5 w-3.5 ${isSpeaking ? "animate-pulse" : ""}`} />
                    </button>
                  </div>
                  <span className="text-[10px] text-slate-400 mt-1 uppercase font-bold pl-1 select-none">
                    {msg.sender === "patient" ? "Imetambuliwa: Kiswahili" : "Msaada wa Tafsiri"}
                  </span>
                </div>
              );
            })}
            {isTranslating && currentUser === "patient" && (
              <div className="flex justify-start pl-2 animate-pulse">
                <span className="text-[10px] text-emerald-600 font-bold uppercase tracking-wider">Inatafsiri kwa Kiingereza...</span>
              </div>
            )}
          </div>

          <div className="relative shrink-0">
            <textarea
              className={`w-full p-4 pb-14 border rounded-xl text-sm focus:outline-none transition-all bg-white resize-none ${
                currentUser === "patient" ? "border-emerald-500 ring-2 ring-emerald-50 bg-white" : "border-slate-300"
              }`}
              rows={3}
              value={isListeningSw ? (inputText || interimTranscript) : (currentUser === "patient" ? inputText : "")}
              onChange={(e) => {
                if (currentUser === "patient") {
                  setInputText(e.target.value);
                  setInterimTranscript("");
                }
              }}
              onFocus={() => setCurrentUser("patient")}
              placeholder={isListeningSw ? "🎙️ Inasikiliza... endelea kuongea" : "Andika hapa au bonyeza kipaza sauti..."}
              disabled={isListeningSw}
            />

            {/* Real-time Swahili word feedback line when speaking */}
            {isListeningSw && interimTranscript && (
              <div className="absolute left-4 bottom-14 right-4 text-xs italic text-emerald-600 font-medium truncate pointer-events-none">
                Inasoma: "{interimTranscript}"
              </div>
            )}

            <div className="absolute bottom-3 right-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => isListeningSw ? stopListening() : startListening("patient")}
                className={`p-2.5 rounded-lg shadow-sm transition-all flex items-center justify-center border ${
                  isListeningSw 
                    ? "bg-red-500 border-red-400 text-white animate-pulse hover:bg-red-600" 
                    : "bg-white text-slate-600 hover:text-emerald-600 hover:bg-emerald-50 border-slate-200"
                }`}
                title={isListeningSw ? "Acha kusikiliza" : "Sema kwa Kiswahili"}
              >
                {isListeningSw ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </button>
              <button 
                onClick={handleSendMessage}
                disabled={currentUser !== "patient" || !inputText.trim() || isTranslating || isListeningSw}
                className="p-2.5 bg-emerald-600 text-white border border-emerald-500 rounded-lg shadow-sm hover:bg-emerald-700 disabled:opacity-40 transition-all flex items-center justify-center"
                title="Tuma Ujumbe wa Tafsiri"
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
