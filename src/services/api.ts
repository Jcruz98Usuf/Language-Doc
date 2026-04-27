import { Language } from "../types";

export async function translateText(text: string, from: Language, to: Language, context?: string) {
  const response = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, from, to, context }),
  });
  if (!response.ok) throw new Error("Translation failed");
  const data = await response.json();
  return data.translatedText;
}

export async function generateSummary(patientData: any, conversation: any[]) {
  const response = await fetch("/api/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patientData, conversation }),
  });
  if (!response.ok) throw new Error("Summary generation failed");
  const data = await response.json();
  return data.summary;
}
