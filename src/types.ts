export enum Language {
  ENGLISH = "English",
  SWAHILI = "Swahili"
}

export interface PatientData {
  name: string;
  age: string;
  gender: string;
  complaint: string;
  symptoms: string[];
  intakeNotes?: string;
}

export interface Message {
  id: string;
  text: string;
  sender: "doctor" | "patient";
  originalText: string;
  translation: string;
  timestamp: Date;
}

export enum AppMode {
  WELCOME = "welcome",
  INTAKE = "intake",
  CONVERSATION = "conversation",
  SUMMARY = "summary"
}
