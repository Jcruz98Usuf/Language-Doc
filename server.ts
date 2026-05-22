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
      const { text, from, to, context } = req.body;
      const ai = getGeminiClient();
      const prompt = `Translate this medical communication from ${from} to ${to}. 
      Context: ${context || "General medical consultation"}.
      Text: "${text}"`;
      
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
        config: {
          systemInstruction: `You are a medical translator specifically trained for English and Swahili.
Rules:
- Maintain strict medical accuracy.
- Preserve symptoms exactly.
- Do not add diagnosis or treatment advice.
- Do not simplify critical medical terms unless requested by the doctor for the patient.
- Keep tone professional and empathetic.
- When translating intake data, extract structural information like name, age, and symptoms.`
        }
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
      const { patientData, conversation } = req.body;
      const ai = getGeminiClient();
      const prompt = `Generate a structured Medical Intake Summary based on this data:
      Patient Data: ${JSON.stringify(patientData)}
      Conversation History: ${JSON.stringify(conversation)}
      
      Format strictly as:
      PATIENT INTAKE SUMMARY
      Name: ...
      DOB/Age: ...
      Primary Complaint: ...
      History of Present Illness: ...
      Notes: ...`;
      
      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
        config: {
          systemInstruction: `You are a medical translator and summarizer specifically trained for English and Swahili.
Rules:
- Maintain strict medical accuracy.
- Preserve symptoms exactly.
- Do not add diagnosis or treatment advice.
- Do not simplify critical medical terms unless requested by the doctor for the patient.
- Keep tone professional and empathetic.`
        }
      });
      const summary = response.text || "";
      res.json({ summary });
    } catch (error) {
      console.error("Summary error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Summary generation failed" });
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
