export enum Language {
  ENGLISH = "English",
  SWAHILI = "Swahili",
  LUGANDA = "Luganda",
  KINYARWANDA = "Kinyarwanda",
  SOMALI = "Somali",
  LUO = "Luo",
  GIKUYU = "Kikuyu",
  KALENJIN = "Kalenjin"
}

export enum AppDomain {
  CLINIC = "clinic",
  HOTEL = "hotel",
  OFFICE = "office"
}

export interface PatientData {
  // Medical / Common Fields
  name: string;
  age: string;
  gender: string;
  complaint: string;
  symptoms: string[];
  intakeNotes?: string;

  // Hospitality Fields
  guestName?: string;
  duration?: string;
  roomPreference?: string;
  budgetCategory?: string;
  specialRequests?: string;

  // Office Fields
  employeeName?: string;
  department?: string;
  meetingSubject?: string;
  workContext?: string;
  actionItems?: string[];
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
