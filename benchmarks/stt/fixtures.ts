/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Speech-to-text benchmark fixtures (Phase 7A).
 *
 * English only: the machine has no French/Swahili TTS voice, so the multilingual
 * Whisper path cannot be measured here without recording real speakers. That
 * limitation is stated in the report rather than papered over.
 *
 * Every fixture targets something the review asked to watch specifically:
 * symptoms, negation, medication names, dosage, numbers, dates, booking
 * duration, room numbers, meeting dates, action items and names.
 */

export interface SttFixture {
  id: string;
  domain: "clinic" | "hotel" | "office" | "general";
  /** Sentence spoken into the local TTS voice; also the reference transcript. */
  text: string;
  /** Windows SAPI voice, used to add speaker variety to the benchmark. */
  speaker: string;
}

/** Reference transcripts are the spoken text itself - no human transcription drift. */
export const STT_FIXTURES: SttFixture[] = [
  {
    id: "clinic-fever",
    domain: "clinic",
    text: "Good morning, my name is Amina and I have had a fever and a dry cough for three days.",
    speaker: "Microsoft David Desktop",
  },
  {
    id: "clinic-negation",
    domain: "clinic",
    text: "The child has a headache and stomach pain, but no chest pain.",
    speaker: "Microsoft Zira Desktop",
  },
  {
    id: "clinic-dosage",
    domain: "clinic",
    text: "Take one paracetamol five hundred milligram tablet twice a day after meals for five days.",
    speaker: "Microsoft David Desktop",
  },
  {
    id: "clinic-allergy",
    domain: "clinic",
    text: "She is allergic to amoxicillin, so we will prescribe a different antibiotic.",
    speaker: "Microsoft Zira Desktop",
  },
  {
    id: "clinic-date",
    domain: "clinic",
    text: "Your next appointment is on the twelfth of March two thousand and twenty six at half past nine.",
    speaker: "Microsoft David Desktop",
  },
  {
    id: "hotel-booking",
    domain: "hotel",
    text: "Welcome, may I have your name and your passport number for the booking?",
    speaker: "Microsoft David Desktop",
  },
  {
    id: "hotel-duration",
    domain: "hotel",
    text: "You have a room with an ocean view for two nights at ninety dollars per night.",
    speaker: "Microsoft Zira Desktop",
  },
  {
    id: "hotel-roomnumber",
    domain: "hotel",
    text: "Your room number is three hundred and five and breakfast starts at seven.",
    speaker: "Microsoft David Desktop",
  },
  {
    id: "hotel-requests",
    domain: "hotel",
    text: "I would like a quiet non smoking room and a late checkout, please.",
    speaker: "Microsoft Zira Desktop",
  },
  {
    id: "office-meeting-date",
    domain: "office",
    text: "The meeting is on Monday the fifteenth of September at ten o'clock in the morning.",
    speaker: "Microsoft David Desktop",
  },
  {
    id: "office-actions",
    domain: "office",
    text: "Our action items are to finalize the budget and send the report to finance by Friday.",
    speaker: "Microsoft Zira Desktop",
  },
  {
    id: "office-role",
    domain: "office",
    text: "I am the lead engineer in the engineering department.",
    speaker: "Microsoft David Desktop",
  },
  {
    id: "general-question",
    domain: "general",
    text: "How are you feeling today?",
    speaker: "Microsoft Zira Desktop",
  },
  {
    id: "general-negation",
    domain: "general",
    text: "No, I do not need any help right now, thank you.",
    speaker: "Microsoft David Desktop",
  },
];
