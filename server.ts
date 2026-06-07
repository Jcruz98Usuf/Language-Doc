import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  const getGeminiClient = () => {
    let apiKey = process.env.GEMINI_API_KEY;

    // Check if the current apiKey is a dummy, placeholder, or missing
    if (!apiKey || apiKey === "MY_GEMINI_API_KEY" || apiKey.length < 20) {
      // Fallback 1: Try reading the user-adjusted .env.example
      try {
        const envExamplePath = path.join(process.cwd(), ".env.example");
        if (fs.existsSync(envExamplePath)) {
          const content = fs.readFileSync(envExamplePath, "utf-8");
          const match = content.match(/GEMINI_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?/);
          if (match && match[1] && match[1] !== "MY_GEMINI_API_KEY" && match[1].length >= 20) {
            apiKey = match[1];
          }
        }
      } catch (e) {
        console.error("Failed to read fallback from .env.example:", e);
      }
    }

    // Fallback 2: Hardcoded safe server-side fallback using the active key provided
    if (!apiKey || apiKey === "MY_GEMINI_API_KEY" || apiKey.length < 20) {
      apiKey = "AIzaSyDH22a1ghZ4FFVBQIMg3Og_dD6xx3A0DSs";
    }

    return new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  };

  // API Endpoints
  app.post("/api/translate", async (req, res) => {
    try {
      const { text, from, to, context, domain = "clinic" } = req.body;
      const ai = getGeminiClient();

      let systemInstruction = "";
      let domainContext = "";

      if (domain === "hotel") {
        systemInstruction = `You are an expert bilingual concierge translator specifically trained for English and Swahili in premium hotel, safari guide, and hospitality settings.
Rules:
- Capture cultural nuances of warm East African hospitality (using respectful greetings like 'Karibu sana').
- Retain accurate details of room numbers, booking nights, and guest preferences.
- Keep tone professional, welcoming, and polite.`;
        domainContext = "Hospitality guest services and booking context";
      } else if (domain === "office") {
        systemInstruction = `You are a professional business translator specialized in English and Swahili business-level operations, office syncs, and executive coordination.
Rules:
- Use formal but modern corporate vocabulary.
- Maintain clarity on action items, dates, project goals, and individual assignments.
- Keep tone constructive, professional, and precise.`;
        domainContext = "Professional office meeting alignment";
      } else {
        systemInstruction = `You are a medical translator specifically trained for English and Swahili.
Rules:
- Maintain strict medical accuracy.
- Preserve symptoms exactly.
- Do not add diagnosis or treatment advice.
- Do not simplify critical medical terms unless requested by the doctor for the patient.
- Keep tone professional and empathetic.`;
        domainContext = "General medical consultation";
      }

      const prompt = `Translate this communication from ${from} to ${to}. 
      Context: ${context || domainContext}.
      Text: "${text}"`;
      
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
        config: { systemInstruction }
      });
      const translatedText = response.text || "";
      res.json({ translatedText });
    } catch (error) {
      console.error("Translation error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Translation failed" });
    }
  });

  app.post("/api/summarize", async (req, res) => {
    try {
      const { patientData, conversation, domain = "clinic" } = req.body;
      const ai = getGeminiClient();
      
      let systemInstruction = "";
      let prompt = "";

      if (domain === "hotel") {
        systemInstruction = `You are a hospitality management summarizer proficient in English and Swahili.
Generate a professional Guest Check-In & Booking Summary in English. Ensure details match the dialogue accurately.`;
        prompt = `Generate a structured Guest Booking Summary based on this data:
        Guest Profile: ${JSON.stringify(patientData)}
        Conversation History: ${JSON.stringify(conversation)}
        
        Format strictly as:
        GUEST BOOKING & HOSPITALITY SUMMARY
        Guest Name: ...
        Stay Duration (Nights): ...
        Room Preference: ...
        Budget Category: ...
        Special Requests & Activities: ...
        Overall Hospitality Plan: ...`;
      } else if (domain === "office") {
        systemInstruction = `You are an executive summarizer specialized in high-level business syncs and action plans.
Generate a concise, professional Office Sync Summary in English. Ensure details are actionable and clear.`;
        prompt = `Generate a structured Meeting Summary based on this data:
        Attendee Data: ${JSON.stringify(patientData)}
        Conversation History: ${JSON.stringify(conversation)}
        
        Format strictly as:
        OFFICE SYNC & ALIGNMENT SUMMARY
        Primary Participant: ...
        Department/Role: ...
        Meeting Subject: ...
        Discussion Context/Topic: ...
        Key Decisions/Alignments: ...
        Agreed Action Items: ...`;
      } else {
        systemInstruction = `You are a medical translator and summarizer specifically trained for English and Swahili.
Rules:
- Maintain strict medical accuracy.
- Preserve symptoms exactly.
- Do not add diagnosis or treatment advice.
- Do not simplify critical medical terms unless requested by the doctor for the patient.
- Keep tone professional and empathetic.`;
        prompt = `Generate a structured Medical Intake Summary based on this data:
        Patient Data: ${JSON.stringify(patientData)}
        Conversation History: ${JSON.stringify(conversation)}
        
        Format strictly as:
        PATIENT INTAKE SUMMARY
        Name: ...
        DOB/Age: ...
        Primary Complaint: ...
        History of Present Illness: ...
        Notes: ...`;
      }
      
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
        config: { systemInstruction }
      });
      const summary = response.text || "";
      res.json({ summary });
    } catch (error) {
      console.error("Summary error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Summary generation failed" });
    }
  });

  app.post("/api/parse-dialogue", async (req, res) => {
    try {
      const { conversation, domain = "clinic" } = req.body;
      const ai = getGeminiClient();

      const prompt = `Review this conversation history and extract relevant profile details.
Conversation History: ${JSON.stringify(conversation)}

Task: Extract information to fill a profile card. Return a complete JSON object matching the properties defined below. Do not invent details; only use facts extracted directly from the conversation. If a fact is unknown or not mentioned, return "" or empty array.

For Domain "${domain}":
- If clinic:
  Extract:
  {
    "name": "Full name of patient",
    "age": "Age of patient",
    "gender": "male, female, or other",
    "complaint": "Chief health complaint/problem",
    "symptoms": ["list of symptoms mentioned"]
  }
- If hotel:
  Extract:
  {
    "name": "Guest name",
    "age": "Length of stay/duration of nights (e.g. '3 nights')",
    "gender": "male, female, or other (optional)",
    "complaint": "Brief room preferences summary",
    "symptoms": ["list of requested activities/special requests"],
    "guestName": "Guest name",
    "duration": "Length of stay/duration (e.g. '3 nights')",
    "roomPreference": "Preferred room class or position (e.g. Single, King Suite, Beach View)",
    "budgetCategory": "Economy, Standard, or Luxury",
    "specialRequests": "Dietary constraints or special hospitality desires"
  }
- If office:
  Extract:
  {
    "name": "Employee name",
    "age": "Department (e.g., 'Marketing', 'Core Tech')",
    "gender": "male, female, or other (optional)",
    "complaint": "Meeting focal topic or subject",
    "symptoms": ["list of action items extracted"],
    "employeeName": "Employee/Presenter name",
    "department": "Department/Team name",
    "meetingSubject": "Core theme or topic of discussion",
    "workContext": "Problem context or business challenge being aligned",
    "actionItems": ["list of individual assigned action items"]
  }`;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          systemInstruction: "You are an AI data extractor. You analyze Swahili/English chat transcripts, capture the details mentioned, and format them into precise structured JSON. Return only the flat JSON block in the requested format."
        }
      });

      const parsedJSON = JSON.parse(response.text || "{}");
      res.json(parsedJSON);
    } catch (error) {
      console.error("Dialogue parsing error:", error);
      res.status(500).json({ error: "Failed to parse dialogue" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Language Doctor running on http://localhost:${PORT}`);
  });
}

startServer();
