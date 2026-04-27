import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  const getModel = () => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
      throw new Error("GEMINI_API_KEY is not configured correctly. Please open the 'Secrets' panel in the AI Studio sidebar and set your GEMINI_API_KEY there.");
    }
    const genAI = new GoogleGenerativeAI(apiKey);
    return genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash",
      systemInstruction: `You are a medical translator specifically trained for English and Swahili.
Rules:
- Maintain strict medical accuracy.
- Preserve symptoms exactly.
- Do not add diagnosis or treatment advice.
- Do not simplify critical medical terms unless requested by the doctor for the patient.
- Keep tone professional and empathetic.
- When translating intake data, extract structural information like name, age, and symptoms.`
    });
  };

  // API Endpoints
  app.post("/api/translate", async (req, res) => {
    try {
      const { text, from, to, context } = req.body;
      const model = getModel();
      const prompt = `Translate this medical communication from ${from} to ${to}. 
      Context: ${context || "General medical consultation"}.
      Text: "${text}"`;
      
      const result = await model.generateContent(prompt);
      const translatedText = result.response.text();
      res.json({ translatedText });
    } catch (error) {
      console.error("Translation error:", error);
      res.status(500).json({ error: error instanceof Error ? error.message : "Translation failed" });
    }
  });

  app.post("/api/summarize", async (req, res) => {
    try {
      const { patientData, conversation } = req.body;
      const model = getModel();
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
      
      const result = await model.generateContent(prompt);
      const summary = result.response.text();
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
