export enum Language {
  ENGLISH = "English",
  SWAHILI = "Swahili",
  FRENCH = "French",
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

/**
 * Domain profiles (Phase 2).
 *
 * Every domain owns its own fields. Hotel and office information is NEVER stored
 * in a medical property again: there is no `age = length of stay`, no
 * `complaint = room preference` and no `symptoms = action items`.
 *
 * The literal `domain` property makes these a discriminated union, so
 * `profile.domain === AppDomain.HOTEL` narrows to GuestProfile at every call
 * site and the compiler rejects `profile.complaint` on a guest profile.
 *
 * All fields are required and default to `""` / `[]`: the profile is validated
 * into this complete shape on the server before it reaches app state, and the
 * merge in src/profile.ts decides what may actually be overwritten.
 */
export interface PatientProfile {
  domain: AppDomain.CLINIC;
  name: string;
  age: string;
  gender: string;
  complaint: string;
  symptoms: string[];
  intakeNotes?: string;
}

export interface GuestProfile {
  domain: AppDomain.HOTEL;
  guestName: string;
  duration: string;
  roomPreference: string;
  budgetCategory: string;
  specialRequests: string;
}

export interface OfficeProfile {
  domain: AppDomain.OFFICE;
  employeeName: string;
  department: string;
  meetingSubject: string;
  workContext: string;
  actionItems: string[];
}

export type DomainProfile = PatientProfile | GuestProfile | OfficeProfile;

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
  /** Phase 4: private two-device mode - waiting room before the conversation. */
  PRIVATE_HOST = "private-host",
  /** Private device opened from an authenticated QR pairing link. */
  PRIVATE_PARTICIPANT = "private-participant",
  SUMMARY = "summary"
}
