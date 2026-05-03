import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());



  // API Endpoints
  app.post("/api/translate", async (req, res) => {
    try {
      const { text } = req.body;
      const response = await fetch("http://localhost:5000/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data: any = await response.json();
      res.json({ translatedText: data.translatedText });
    } catch (error) {
      console.error("Translation error:", error);
      res.status(500).json({ error: "Translation failed" });
    }
  });

  app.post("/api/summarize", async (req, res) => {
    try {
      const { patientData, conversation } = req.body;
      // Summarization is not implemented with local model yet
      res.status(501).json({ error: "Summarization not implemented with local model." });
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
