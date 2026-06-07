import { useState, useRef, useEffect } from "react";
import { Send, Languages, Mic, MicOff, Volume2, Sparkles, Activity, AlertCircle, RefreshCw } from "lucide-react";
import { PatientData, Message, Language, AppDomain } from "../types";
import { translateText, parseDialogue } from "../services/api";

const LOCAL_LANGUAGES = [
  { value: Language.SWAHILI, label: "Kiswahili (Swahili)", code: "sw-TZ", ttsCode: "sw-KE" },
  { value: Language.LUGANDA, label: "Luganda (Uganda)", code: "lg-UG", ttsCode: "en-US" },
  { value: Language.KINYARWANDA, label: "Kinyarwanda (Rwanda)", code: "rw-RW", ttsCode: "rw-RW" },
  { value: Language.SOMALI, label: "Af-Soomaali (Somali)", code: "so-SO", ttsCode: "so-SO" },
  { value: Language.LUO, label: "Dholuo (Luo)", code: "luo-KE", ttsCode: "en-US" },
  { value: Language.GIKUYU, label: "Gĩkũyũ (Kikuyu)", code: "ki-KE", ttsCode: "ki-KE" },
  { value: Language.KALENJIN, label: "Kalenjin", code: "kln-KE", ttsCode: "kln-KE" },
];

interface ConversationViewProps {
  patientData: PatientData | null;
  onUpdatePatientData: (data: PatientData) => void;
  messages: Message[];
  onUpdateMessages: (messages: Message[]) => void;
  onEndSession: () => void;
  domain: AppDomain;
}

export default function ConversationView({
  patientData,
  onUpdatePatientData,
  messages,
  onUpdateMessages,
  onEndSession,
  domain,
}: ConversationViewProps) {
  const [selectedLocalLanguage, setSelectedLocalLanguage] = useState<Language>(Language.SWAHILI);
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
  }, [messages, isListeningEn, isListeningSw, interimTranscript]);

  // Handle Speech Recognition Setup
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      const rec = new SpeechRecognition();
      rec.continuous = true; // KEEP MIC ALIVE so user can speak multiple sentences without getting cut off!
      rec.interimResults = true; // Provides dynamic visual in-progress words

      rec.onstart = () => {
        isRecognitionActiveRef.current = true;
        setInterimTranscript("");
      };

      rec.onresult = (event: any) => {
        let finalTranscript = "";
        let interimTranscriptText = "";

        for (let i = 0; i < event.results.length; ++i) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            finalTranscript += transcript;
          } else {
            interimTranscriptText += transcript;
          }
        }

        setInputText(finalTranscript);
        setInterimTranscript(interimTranscriptText);
      };

      rec.onerror = (event: any) => {
        const errType = event.error;
        console.warn("Speech Recognition Error:", errType);
        
        if (errType === "not-allowed" || errType === "service-not-allowed") {
          setError("Microphone permission blocked. Click the top-right 'Open in New Tab' button to permit mic access outside of the secure iframe preview!");
        } else if (errType === "network") {
          setError("Speach connection error: Chrome blocks Web Speech inside nested frames. Click the top-right 'Open in New Tab' button to run correctly.");
        } else if (errType === "no-speech") {
          // Ignore no-speech error gracefully as it's common when waiting
          console.log("Speech Recognition: No speech detected.");
        } else if (errType === "aborted") {
          console.log("Speech recognition stopped.");
        } else {
          setError(`Speech capture check: ${errType}. Try opening the app in a new browser tab.`);
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

        if (!shouldIgnore) {
          setInputText((latestText) => {
            const trimmed = latestText.trim();
            if (trimmed) {
              const sender = currentListeningUserRef.current;
              if (sender) {
                // Auto-translate on stop/complete
                setTimeout(() => {
                  translateAndSendMessageRef.current?.(trimmed, sender);
                }, 100);
                return ""; // clear it because we are sending it
              }
            }
            return latestText; // preserve manually or interim text if no submit
          });
        }

        // Safe delayed startup recovery
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
  }, []);

  // Voice output (TTS) with native engine
  const speakText = (text: string, lang: Language, messageId: string) => {
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

    if (lang === Language.ENGLISH) {
      targetVoice = voices.find(v => v.lang.startsWith("en")) || null;
      utterance.lang = "en-US";
    } else {
      const config = LOCAL_LANGUAGES.find(l => l.value === lang);
      const ttsLang = config ? config.ttsCode : "sw-KE";
      targetVoice = voices.find(v => v.lang.startsWith(ttsLang.split("-")[0])) || null;
      utterance.lang = ttsLang;
    }

    if (targetVoice) utterance.voice = targetVoice;

    utterance.onend = () => setCurrentlySpeakingId(null);
    utterance.onerror = () => setCurrentlySpeakingId(null);

    setCurrentlySpeakingId(messageId);
    window.speechSynthesis.speak(utterance);
  };

  const startListening = (user: "doctor" | "patient") => {
    if (!recognitionRef.current) {
      setError("Speech recognition is not fully supported in this frame. Open the preview in a new tab.");
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

    // Schedule deferred startup if already active to prevent overlap errors
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
      const config = LOCAL_LANGUAGES.find(l => l.value === selectedLocalLanguage);
      recognitionRef.current.lang = config ? config.code : "sw-TZ";
      setIsListeningSw(true);
      setIsListeningEn(false);
    }

    try {
      recognitionRef.current.start();
    } catch (e: any) {
      console.error("Failed to start speech recognition:", e);
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
    const sourceLang = sender === "doctor" ? Language.ENGLISH : selectedLocalLanguage;
    const targetLang = sender === "doctor" ? selectedLocalLanguage : Language.ENGLISH;
    
    setIsTranslating(true);
    try {
      const translation = await translateText(
        textToSend,
        sourceLang,
        targetLang,
        `Communication from ${sender} in domain context ${domain}.`,
        domain
      );

      const newMessage: Message = {
        id: crypto.randomUUID(),
        text: textToSend,
        sender: sender,
        originalText: textToSend,
        translation: translation,
        timestamp: new Date(),
      };

      const revisedMessages = [...messages, newMessage];
      onUpdateMessages(revisedMessages);

      // Speak translation out loud automatically on target side
      if (isAutoTtsEnabled) {
        if (sender === "doctor") {
          speakText(translation, selectedLocalLanguage, newMessage.id);
        } else {
          speakText(translation, Language.ENGLISH, newMessage.id);
        }
      }

      // Background Dialogue Extractors synchronizer: Extract card details on-the-fly!
      try {
        const parsed = await parseDialogue(revisedMessages, domain);
        if (parsed && typeof parsed === "object") {
          onUpdatePatientData(parsed);
        }
      } catch (parseErr) {
        console.error("Dialogue extraction parse failed:", parseErr);
      }

    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Translation system interrupt.");
    } finally {
      setIsTranslating(false);
    }
  };

  useEffect(() => {
    translateAndSendMessageRef.current = translateAndSendMessage;
  });

  const handleSendMessage = async (e: any) => {
    e.preventDefault();
    const textToSend = inputText.trim() || interimTranscript.trim();
    if (!textToSend || isTranslating) return;
    
    // Stop recording if active and ignore subsequent end trigger to prevent double send
    if (isListeningEn || isListeningSw) {
      ignoreNextSubmitRef.current = true;
      stopListening();
    }

    setInputText("");
    setInterimTranscript("");
    await translateAndSendMessage(textToSend, currentUser);
  };

  const getParticipantStatusLabels = () => {
    switch (selectedLocalLanguage) {
      case Language.LUGANDA:
        return {
          listeningText: "Wuliriza sasa... Tafadhali speak",
          listeningStatus: "Omulwaddde / Omugenyi ayogera",
          speakingOverlay: "Inasoma eddoboozi",
          placeholder: "Wandiika ebyetaago byo wano...",
          btnTitle: "Sema Luganda",
          listeningBadge: "Omugenyi Ayogera",
          translatingBg: "Inasafirisha Taarifa...",
        };
      case Language.KINYARWANDA:
        return {
          listeningText: "Uyu munsi... Tafadhali bireranye",
          listeningStatus: "Umuvugizi uyu munsi",
          speakingOverlay: "Iri kumva ijwi",
          placeholder: "Andika ibyo ukeneye hano...",
          btnTitle: "Vuga Kinyarwanda",
          listeningBadge: "Umuvugizi Ari Kuvuga",
          translatingBg: "Ihindura amagambo...",
        };
      case Language.SOMALI:
        return {
          listeningText: "Waan ku dhageysaneynaa... Fadlan hadal",
          listeningStatus: "Qofka hadlaya",
          speakingOverlay: "Maqalka codka",
          placeholder: "Halkan ku qor waxaad u baahan tahay...",
          btnTitle: "Ku hadal Somali",
          listeningBadge: "Qofka weyn ee hadlaya",
          translatingBg: "Turjumaya codka...",
        };
      case Language.LUO:
        return {
          listeningText: "Iwinji sasa... Winjowa maber",
          listeningStatus: "Mawuono e romo",
          speakingOverlay: "Iwinjo duol",
          placeholder: "Ndik gigo maduong' ka...",
          btnTitle: "Wuo Dholuo",
          listeningBadge: "Jabed romo wuoyo",
          translatingBg: "Inasafirisha...",
        };
      case Language.GIKUYU:
        return {
          listeningText: "Ndetheerekera rĩu... Aria uhoro",
          listeningStatus: "Mũndũ nĩaraaria",
          speakingOverlay: "Iraguthia mũgambo",
          placeholder: "Andĩka mĩnyamaro yaku haha...",
          btnTitle: "Aria na Gĩkũyũ",
          listeningBadge: "Mũndũ nĩaraaria (AI)",
          translatingBg: "Iragarũra rũthiomi...",
        };
      case Language.KALENJIN:
        return {
          listeningText: "Kasen rani... Ng'alal ng'al",
          listeningStatus: "Chiito nee ng'alali",
          speakingOverlay: "Kasen tuiyet",
          placeholder: "Sir mwanzo koboto yu...",
          btnTitle: "Ng'alal Kalenjin",
          listeningBadge: "Chiito nee ng'alal (AI)",
          translatingBg: "Iwetyi kulelei...",
        };
      default: // Swahili (default)
        return {
          listeningText: "Inasikiliza sasa... Tafadhali ongea",
          listeningStatus: "Mshiriki anaongea",
          speakingOverlay: "Inasoma sauti",
          placeholder: "Andika dalili zako au bonyeza kipaza sauti hapa...",
          btnTitle: "Sema Kiswahili",
          listeningBadge: "Mshiriki Anaongea (Suala la AI)",
          translatingBg: "Inasafirisha Taarifa za Tafsiri...",
        };
    }
  };

  const statusLabels = getParticipantStatusLabels();

  // Domain labels mapper
  const getDomainLabel = () => {
    const getGreeting = () => {
      if (domain === AppDomain.HOTEL) {
        switch (selectedLocalLanguage) {
          case Language.LUGANDA:
            return "Otyanno! Tukusanyukidde mu kisulo kyaffe ekirungi. Otya erinnya lyo, era mwagala kusula naffe ennaku mmeka?";
          case Language.KINYARWANDA:
            return "Muraho! Murakaza neza mu nzu yacu y'ikiruhuko. Mwambwira izina ryanyu, kandi mwifuza kumara natwe iminsi ingahe?";
          case Language.SOMALI:
            return "Haye! Soo dhowow hudheelkayaga gaarka ah. Fadlan ii sheeg magacaaga iyo inta habeen ee aad nala joogi doonto?";
          case Language.LUO:
            return "Amosi! Karibu e hotela mwa mamit. Ndalo andiye nying'i kendo diher bet kodwa kuom ndalo adi?";
          case Language.GIKUYU:
            return "Wĩ mwega! Nĩ tũgũcookeria ngatho thĩinĩ wa nyũmba iitũ ya kĩĩmantha. Ndĩĩ kũũria rĩĩtwa rĩaku, na nĩ matukũ maigana ũngĩenda gũcooka na ithuĩ?";
          case Language.KALENJIN:
            return "Chomiet koret! Karibu bo jumba ne kibaa. Agoteran kainet neng'ung', ago moche ibete yu kebyisiek adĩ?";
          default:
            return "Hujambo! Karibu kwenye Jumba letu la kipekee. Tafadhali niambie jina lako na utapenda kukaa nasi kwa siku ngapi?";
        }
      } else if (domain === AppDomain.OFFICE) {
        switch (selectedLocalLanguage) {
          case Language.LUGANDA:
            return "Otyanno! Tukusanyukidde mu nkiiko yaffe yaleero. Erinnya lyo ggwe ani, okola mu kitongole ki, era mulamwa ki ogwaleero?";
          case Language.KINYARWANDA:
            return "Muraho! Murakaza neza mu biganiro byacu by'uyu munsi. Nabaza izina ryanyu, ishami mukoramo, n'insanganyamatsiko y'uyu munsi?";
          case Language.SOMALI:
            return "Haye! Soo dhowow kulankayaga maanta. Fadlan ii sheeg magacaaga, waaxdaada, iyo mawduuca ugu weyn maanta?";
          case Language.LUO:
            return "Amosi! Karibu e romo mwa kawuono. Ang'o nying'i, muofisi mane, kendo ang'o wach maduong' kawuono?";
          case Language.GIKUYU:
            return "Wĩ mwega! Nĩ tũgũcookeria ngatho thĩinĩ wa kĩũngano giitũ gĩa rũũmĩrĩ. Rĩĩtwa rĩaku nũũ, ũrutaga wĩra wabicĩ ĩrĩrĩ, na nĩ kĩĩ kĩwarĩgĩra gĩatũũgathi rũũmĩrĩ?";
          case Language.KALENJIN:
            return "Chomiet koret! Sanyu keti korok bo uungano yetu rani. Kainet neng'ung' ku ng'oo, ibei ofisĩ nee, ago nee nee madaet mawa rani?";
          default:
            return "Hujambo! Karibu kwenye majadiliano yetu ya leo. Ningependa kufahamu jina lako, kitengo chako, na mada kuu leo?";
        }
      } else { // Clinic / Default
        switch (selectedLocalLanguage) {
          case Language.LUGANDA:
            return "Otyanno! Tukusanyukidde mu ddwaliro lyaffe. Tafadhali naaba nkubuuza erinnya lyo, emyaka gyo, n'ekikuluma leero?";
          case Language.KINYARWANDA:
            return "Muraho! Murakaza neza mu ivuriro ryacu. Mwambwira izina ryanyu, imyaka yanyu, n'ikibazo mufite uyu munsi?";
          case Language.SOMALI:
            return "Haye! Soo dhowow rugta caafimaadkayaga. Fadlan ii sheeg magacaaga, da'daada, iyo waxa ku dhibaya maanta?";
          case Language.LUO:
            return "Amosi! Koyo kendo maber e kliniki mwa. Ndalo aniye nying'i, higni mari, kendo ang'o mamulo chunyi kawuono?";
          case Language.GIKUYU:
            return "Wĩ mwega! Nĩ tũgũcookeria ngatho tũrĩ thĩinĩ wa thibitarĩ. Ndĩĩ kũũria rĩĩtwa rĩaku, mĩaka yaku, na nĩ kĩĩ gĩgũthĩnyĩte rũũmĩrĩ?";
          case Language.KALENJIN:
            return "Chomiet koret! Sanyu keti korok bo kliniki. Nyoo abwa, agoteran kainet neng'ung', kebyisiek ku, ago nee nee name keti rani?";
          default:
            return "Hujambo! Karibu kwenye kliniki yetu. Tafadhali niambie jina lako, umri wako, na nini hasa kinakusumbua leo?";
        }
      }
    };

    switch (domain) {
      case AppDomain.HOTEL:
        return {
          title: "Premium Lodging Sync",
          agentTitle: "Desk Reception (English)",
          clientTitlePrefix: "Guest Panel",
          lblAutoGreet: `Greet Guest in ${selectedLocalLanguage} (Sauti ya AI)`,
          lblManualGreet: "Start Speak English (Manual)",
          welcomePrompt: getGreeting(),
          placeholderEn: "Type instructions here or hold Voice...",
          placeholderSw: "Andika mahitaji yako hapa..."
        };
      case AppDomain.OFFICE:
        return {
          title: "Bilingual Workspace Bridge",
          agentTitle: "Moderator Host (English)",
          clientTitlePrefix: "Participant Panel",
          lblAutoGreet: `Welcome Presenter in ${selectedLocalLanguage} (Sauti ya AI)`,
          lblManualGreet: "Host Workspace Brief (Manual)",
          welcomePrompt: getGreeting(),
          placeholderEn: "Type corporate agendas, task items here...",
          placeholderSw: "Andika masuala yako ya kitaalamu hapa..."
        };
      default:
        return {
          title: "Clinical Translation Dashboard",
          agentTitle: "Consulting Doctor (English)",
          clientTitlePrefix: "Patient Intake Panel",
          lblAutoGreet: `AI Patient ${selectedLocalLanguage} Greeting`,
          lblManualGreet: "Start Doctor Intake (Manual)",
          welcomePrompt: getGreeting(),
          placeholderEn: "Type medical checks or instructions here...",
          placeholderSw: "Andika dalili zako hapa au bonyeza kuongea..."
        };
    }
  };

  const labels = getDomainLabel();

  // AI onboarding voice-assist player
  const playVoiceFirstGreeting = () => {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();

    setError(`AI Voice Greeting in ${selectedLocalLanguage} is playing out loud. Listen...`);

    const utterance = new SpeechSynthesisUtterance(labels.welcomePrompt);
    const config = LOCAL_LANGUAGES.find(l => l.value === selectedLocalLanguage);
    const ttsLang = config ? config.ttsCode : "sw-KE";
    utterance.lang = ttsLang;
    
    const voices = window.speechSynthesis.getVoices();
    const matchingVoice = voices.find(v => v.lang.startsWith(ttsLang.split("-")[0])) || null;
    if (matchingVoice) utterance.voice = matchingVoice;

    utterance.onend = () => {
      setError(null);
      // Automatically trigger chosen mic listen block to make the interaction ultra smooth
      startListening("patient");
    };

    utterance.onerror = () => {
      setError(null);
      startListening("patient");
    };

    window.speechSynthesis.speak(utterance);
  };

  // Skip wizard back-door trigger
  const skipWizardIntake = () => {
    onUpdatePatientData({
      name: "Active Session Visitor",
      age: "Not specified",
      gender: "Not specified",
      complaint: "Consultation initiated directly",
      symptoms: [],
    });
  };

  const isProfileEmpty = !patientData || (!patientData.name && !patientData.guestName && !patientData.employeeName);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Dynamic Connectivity Bar */}
      <div className="bg-slate-50 border-b border-slate-200 px-8 py-3 flex flex-wrap gap-4 items-center justify-between text-xs font-semibold text-slate-500 shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Languages className="h-4 w-4 text-slate-600 animate-pulse" />
          <span className="tracking-wider text-[11px] uppercase font-bold text-slate-600">DualBridge AI Active • {labels.title}</span>
          <a
            href={window.location.href}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-2 bg-blue-600 hover:bg-blue-700 text-white font-extrabold uppercase text-[10px] tracking-wider px-3 py-1 rounded-lg shadow-sm transition-all flex items-center gap-1 shrink-0"
          >
            Launch in Full Tab ↗
          </a>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 cursor-pointer select-none text-[10px] font-bold uppercase tracking-wider text-slate-500">
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
              className="rounded border-slate-300 text-slate-700 h-4 w-4 cursor-pointer"
            />
            <span>Auto-Speak Translations (TTS)</span>
          </label>
        </div>
      </div>

      {error && (
        <div className="bg-amber-50 border-b border-amber-100 px-8 py-3 text-xs font-bold text-amber-700 flex flex-wrap justify-between items-center gap-3 shrink-0">
          <span className="flex items-center gap-2">
            <Activity className="w-3.5 h-3.5 animate-pulse" />
            {error}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <a 
              href={window.location.href} 
              target="_blank" 
              rel="noopener noreferrer" 
              className="bg-amber-600 hover:bg-amber-700 text-white px-3 py-1.5 rounded-xl text-[10px] font-extrabold uppercase tracking-widest transition-all"
            >
              Open In New Tab ↗
            </a>
            <button onClick={() => setError(null)} className="text-[10px] bg-amber-100 hover:bg-amber-200 px-2.5 py-1.5 rounded-xl uppercase font-black">Dismiss</button>
          </div>
        </div>
      )}

      {/* AI Voice Onboarding Greet Panel */}
      {isProfileEmpty && (
        <div className="bg-gradient-to-r from-slate-900 to-slate-800 text-white p-6 shadow-md border-b border-slate-700/50 shrink-0">
          <div className="max-w-4xl mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div className="space-y-1">
              <h4 className="text-sm font-extrabold uppercase tracking-widest text-[#f59e0b] flex items-center gap-1.5 leading-none">
                <Sparkles className="w-4 h-4 animate-bounce" />
                AI Voice Intake Launcher
              </h4>
              <p className="text-xs text-slate-300">
                Visitor has not submitted credentials. Welcome them in Swahili automatically with the AI speaker!
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={playVoiceFirstGreeting}
                className="bg-[#f59e0b] hover:bg-amber-600 text-slate-900 px-5 py-2.5 rounded-xl font-extrabold uppercase text-[11px] tracking-wider shadow-md shadow-amber-950/20 transition-all flex items-center gap-2"
              >
                <Mic className="w-3.5 h-3.5" />
                {labels.lblAutoGreet}
              </button>
              <button
                onClick={skipWizardIntake}
                className="bg-slate-700/50 hover:bg-slate-700 text-slate-300 hover:text-white px-4 py-2.5 rounded-xl font-bold uppercase text-[11px] tracking-wider border border-slate-600 transition-all"
              >
                Skip Auto-Greeting
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Translation Interface Grid */}
      <div className="flex-grow grid grid-cols-2 gap-px bg-slate-200 overflow-hidden">
        {/* Doctor Interface (English) */}
        <section className="bg-white flex flex-col p-8 overflow-hidden">
          <div className="flex items-center justify-between mb-4 shrink-0">
            <h2 className="text-xs font-black text-slate-500 uppercase tracking-widest px-1">
              {labels.agentTitle}
            </h2>
            <div className="flex items-center gap-2">
              {isListeningEn && (
                <div className="flex items-center gap-1.5 bg-red-50 text-red-600 text-[10px] px-2 py-1 rounded-full font-bold uppercase tracking-wider animate-pulse">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-600" />
                  Listening
                </div>
              )}
            </div>
          </div>

          {/* Message log */}
          <div 
            ref={scrollRefEn}
            className="flex-grow space-y-5 overflow-y-auto mb-6 pr-4 scrollbar-hide"
          >
            {messages.map((msg) => {
              const speakTargetText = msg.sender === "doctor" ? msg.text : msg.translation;
              const isSpeaking = currentlySpeakingId === msg.id;

              return (
                <div key={msg.id} className="flex flex-col items-end group/msg">
                  <div className="flex items-center gap-2.5 max-w-[90%] justify-end">
                    <button 
                      onClick={() => speakText(speakTargetText, Language.ENGLISH, msg.id)}
                      className={`p-2 rounded-full transition-all border shrink-0 ${
                        isSpeaking 
                          ? "bg-slate-900 text-white shadow-sm scale-105 border-slate-755" 
                          : "text-slate-400 hover:text-slate-900 bg-white border-slate-100 hover:border-slate-300 opacity-100 lg:opacity-0 group-hover/msg:opacity-100"
                      }`}
                    >
                      <Volume2 className={`h-3.5 w-3.5 ${isSpeaking ? "animate-pulse" : ""}`} />
                    </button>
                    <div className={`p-4 rounded-2xl rounded-tr-none text-sm leading-relaxed shadow-xs transition-all ${
                      msg.sender === "doctor" 
                        ? "bg-slate-100 text-slate-700" 
                        : "bg-slate-50 text-slate-800 border border-slate-150"
                    }`}>
                      {speakTargetText}
                    </div>
                  </div>
                  <span className="text-[9px] text-slate-450 mt-1 uppercase font-bold pr-1 select-none">
                    {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              );
            })}

            {/* LIVE ENGLISH SPEECH BUBBLE OVERLAY */}
            {isListeningEn && (
              <div className="flex flex-col items-end animate-pulse">
                <div className="flex items-center gap-2 max-w-[90%]">
                  <div className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-ping shrink-0" />
                  <div className="bg-blue-50/70 text-blue-800 border-2 border-dashed border-blue-200 p-4 rounded-2xl rounded-tr-none text-sm leading-relaxed">
                    {interimTranscript ? (
                      <span className="text-blue-900 font-semibold">Live speaking: "{interimTranscript}"</span>
                    ) : (
                      <span className="text-slate-400 italic">Listening... Speak now</span>
                    )}
                  </div>
                </div>
                <span className="text-[10px] text-blue-500 font-bold uppercase mt-1 tracking-wider">Voice Capture Active</span>
              </div>
            )}

            {isTranslating && currentUser === "doctor" && (
              <div className="flex justify-end pr-2 animate-pulse">
                <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Syncing Swahili Dialogue...</span>
              </div>
            )}
          </div>

          {/* Typing area */}
          <div className="relative shrink-0">
            <textarea
              className={`w-full p-4 pb-14 border rounded-xl text-sm focus:outline-none transition-all resize-none bg-slate-50/50 ${
                currentUser === "doctor" ? "border-slate-800 ring-4 ring-slate-100 bg-white" : "border-slate-200"
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
              placeholder={isListeningEn ? "🎙️ Recording active... keep speaking" : labels.placeholderEn}
              disabled={isListeningEn}
            />

            <div className="absolute bottom-3 right-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => isListeningEn ? stopListening() : startListening("doctor")}
                className={`p-2.5 rounded-lg shadow-sm transition-all flex items-center justify-center border ${
                  isListeningEn 
                    ? "bg-red-500 border-red-400 text-white animate-pulse hover:bg-red-600" 
                    : "bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 border-slate-200"
                }`}
                title={isListeningEn ? "Stop feedback" : "Record English Speech"}
              >
                {isListeningEn ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </button>
              <button 
                onClick={handleSendMessage}
                disabled={currentUser !== "doctor" || !inputText.trim() || isTranslating || isListeningEn}
                className="p-2.5 bg-slate-900 text-white border border-slate-800 rounded-lg shadow-sm hover:bg-slate-800 disabled:opacity-40 transition-all flex items-center justify-center"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </div>
        </section>

        {/* Patient/Guest Interface (Dynamic Local Language) */}
        <section className="bg-slate-50 flex flex-col p-8 overflow-hidden border-l border-slate-200">
          <div className="flex flex-wrap gap-2 items-center justify-between mb-4 shrink-0">
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-black text-slate-500 uppercase tracking-widest">
                {labels.clientTitlePrefix}
              </h2>
              <select
                value={selectedLocalLanguage}
                onChange={(e) => {
                  setSelectedLocalLanguage(e.target.value as Language);
                  if (scrollRefSw.current) {
                    scrollRefSw.current.scrollTop = 0;
                  }
                }}
                className="bg-white border border-slate-200 text-xs font-bold text-slate-700 px-2 py-1 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 cursor-pointer shadow-xs"
              >
                {LOCAL_LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              {isListeningSw && (
                <div className="flex items-center gap-1.5 bg-red-50 text-red-600 text-[10px] px-2 py-1 rounded-full font-bold uppercase tracking-wider animate-pulse">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-600" />
                  {statusLabels.listeningStatus}
                </div>
              )}
            </div>
          </div>

          {/* Localized logs window */}
          <div 
             ref={scrollRefSw}
             className="flex-grow space-y-5 overflow-y-auto mb-6 pr-4 scrollbar-hide"
          >
            {messages.map((msg) => {
              const speakTargetText = msg.sender === "doctor" ? msg.translation : msg.text;
              const isSpeaking = currentlySpeakingId === msg.id;

              return (
                <div key={msg.id} className="flex flex-col items-start group/msg">
                  <div className="flex items-center gap-2.5 max-w-[90%]">
                    <div className={`p-4 rounded-2xl rounded-tl-none border text-sm leading-relaxed shadow-xs transition-all ${
                      msg.sender === "doctor" 
                        ? "bg-white border-slate-150 text-slate-800" 
                        : "bg-slate-800 text-white border-slate-700"
                    }`}>
                      {speakTargetText}
                    </div>
                    <button 
                      onClick={() => speakText(speakTargetText, selectedLocalLanguage, msg.id)}
                      className={`p-2 rounded-full transition-all border shrink-0 ${
                        isSpeaking 
                          ? "bg-slate-800 text-white shadow-sm scale-105 border-slate-700" 
                          : "text-slate-400 hover:text-slate-900 bg-white border-slate-100 hover:border-slate-300 opacity-100 lg:opacity-0 group-hover/msg:opacity-100"
                      }`}
                    >
                      <Volume2 className={`h-3.5 w-3.5 ${isSpeaking ? "animate-pulse" : ""}`} />
                    </button>
                  </div>
                  <span className="text-[9px] text-slate-450 mt-1 uppercase font-bold pl-1 select-none">
                    {msg.sender === "patient" ? selectedLocalLanguage : "Vocal Translation"}
                  </span>
                </div>
              );
            })}

            {/* LIVE REGIONAL SPEECH BUBBLE OVERLAY */}
            {isListeningSw && (
              <div className="flex flex-col items-start animate-pulse">
                <div className="flex items-center gap-2 max-w-[90%]">
                  <div className="bg-emerald-50/70 text-emerald-800 border-2 border-dashed border-emerald-200 p-4 rounded-2xl rounded-tl-none text-sm leading-relaxed">
                    {interimTranscript ? (
                      <span className="text-emerald-900 font-semibold font-mono">{statusLabels.speakingOverlay}: "{interimTranscript}"</span>
                    ) : (
                      <span className="text-slate-400 italic">{statusLabels.listeningText}</span>
                    )}
                  </div>
                  <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping shrink-0" />
                </div>
                <span className="text-[10px] text-emerald-500 font-extrabold uppercase mt-1 tracking-wider">{statusLabels.listeningBadge}</span>
              </div>
            )}

            {isTranslating && currentUser === "patient" && (
              <div className="flex justify-start pl-2 animate-pulse">
                <span className="text-[10px] text-slate-350 font-bold uppercase tracking-wider">{statusLabels.translatingBg}</span>
              </div>
            )}
          </div>

          {/* Input field */}
          <div className="relative shrink-0">
            <textarea
              className={`w-full p-4 pb-14 border rounded-xl text-sm focus:outline-none transition-all resize-none ${
                currentUser === "patient" ? "border-slate-800 ring-4 ring-slate-150 bg-white" : "border-slate-200"
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
              placeholder={isListeningSw ? `🎙️ ${statusLabels.speakingOverlay}...` : statusLabels.placeholder}
              disabled={isListeningSw}
            />

            <div className="absolute bottom-3 right-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => isListeningSw ? stopListening() : startListening("patient")}
                className={`p-2.5 rounded-lg shadow-sm transition-all flex items-center justify-center border ${
                  isListeningSw 
                    ? "bg-red-500 border-red-400 text-white animate-pulse hover:bg-red-600" 
                    : "bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-50 border-slate-200"
                }`}
                title={isListeningSw ? "Stop" : statusLabels.btnTitle}
              >
                {isListeningSw ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </button>
              <button 
                onClick={handleSendMessage}
                disabled={currentUser !== "patient" || !inputText.trim() || isTranslating || isListeningSw}
                className="p-2.5 bg-slate-900 text-white border border-slate-800 rounded-lg shadow-sm hover:bg-slate-800 disabled:opacity-40 transition-all flex items-center justify-center"
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
