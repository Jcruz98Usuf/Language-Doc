/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * English -> Swahili benchmark fixtures (Phase 1.5).
 * Categories: greetings, conversation, numbers, dates, names, clinic dialogue,
 * symptoms, medication names, hotel dialogue, office dialogue, questions,
 * negation, short instructions.
 */

import type { FixtureFile } from "./types";

export const EN_SW: FixtureFile = {
  direction: "English -> Swahili",
  sourceLanguage: "English",
  targetLanguage: "Swahili",
  cases: [
    { id: "en-greeting", category: "greeting", source: "Good morning, doctor.", reference: "Habari ya asubuhi, daktari." },
    { id: "en-conversation", category: "conversation", source: "How are you feeling today?", reference: "Unajisikia vipi leo?" },
    { id: "en-numbers", category: "numbers", source: "The bill is 15,000 shillings for three days.", reference: "Bili ni shilingi 15,000 kwa siku tatu.", preserve: [["15,000"]] },
    { id: "en-dates", category: "dates", source: "Your appointment is on 12 March 2026.", reference: "Miadi yako ni tarehe 12 Machi 2026.", preserve: [["12"], ["Machi", "March"], ["2026"]] },
    { id: "en-names", category: "names", source: "Please call Nurse Amina to room four.", reference: "Tafadhali mwite muuguzi Amina kwenye chumba cha nne.", preserve: [["Amina"]] },
    { id: "en-clinic", category: "clinic", source: "I have been taking this medicine for five days but the pain has not stopped.", reference: "Nimekuwa nikichukua dawa hii kwa siku tano lakini maumivu hayajaisha." },
    { id: "en-symptoms", category: "symptoms", source: "My chest feels heavy and I am short of breath.", reference: "Nahisi kifua changu kimezito na ninapumua kwa shida." },
    { id: "en-medication", category: "medication", source: "Take one tablet of paracetamol 500 mg twice a day after meals.", reference: "Chukua kidonge kimoja cha paracetamol 500 mg mara mbili kwa siku baada ya mlo.", preserve: [["paracetamol", "paracetamoli"], ["500"], ["mg"]] },
    { id: "en-hotel", category: "hotel", source: "I would like to book a double room for two nights with breakfast included.", reference: "Ningependa kupanga chumba cha watu wawili kwa siku mbili pamoja na kiamshakinywa." },
    { id: "en-office", category: "office", source: "The meeting is on Monday, please send me the report before then.", reference: "Mkutano ni Jumatatu, tafadhali nitumie ripoti kabla ya hapo.", preserve: [["Jumatatu", "Monday"]] },
    { id: "en-question", category: "question", source: "Do you understand what I am saying?", reference: "Unaelewa ninachosema?" },
    { id: "en-negation", category: "negation", source: "I am not allowed to eat food with salt.", reference: "Siruhusiwi kula chakula chenye chumvi." },
    { id: "en-instruction", category: "instruction", source: "Open your mouth and breathe in deeply.", reference: "Fungua mdomo wako na kuvuta pumzi kwa kina." },
    { id: "en-clinic-2", category: "clinic", source: "The doctor will see you after the nurse checks your blood pressure.", reference: "Daktari atakuone baada ya muuguzi kupima shinikizo lako la damu." },
    { id: "en-chest-pain", category: "symptoms", source: "I have chest pain when I breathe.", reference: "Nina maumivu ya kifua ninapopumua." },
    { id: "en-stomach-pain", category: "symptoms", source: "Do you have a headache or stomach pain?", reference: "Una maumivu ya kichwa au maumivu ya tumbo?" },
    { id: "en-yesno", category: "question", source: "Is the pain constant? No, it comes and goes.", reference: "Maumivu ni ya kila wakati? Hapana, yanakuja na kuondoka." },
    { id: "en-amoxicillin", category: "medication", source: "Take amoxicillin 250 mg three times a day for seven days.", reference: "Chukua amoxicillin 250 mg mara tatu kwa siku kwa siku saba.", preserve: [["amoxicillin", "amoksilini"], ["250"], ["mg"], ["saba", "7"]] },
    { id: "en-room-number", category: "hotel", source: "Your room number is 204 on the second floor.", reference: "Namba ya chumba chako ni 204 kwenye ghorofa ya pili.", preserve: [["204"]] },
    { id: "en-daily-rate", category: "hotel", source: "The daily rate is 85,000 shillings including breakfast.", reference: "Bei ya kila siku ni shilingi 85,000 ikiwa ni pamoja na kiamshakinywa.", preserve: [["85,000", "85 000", "85000"]] },
    { id: "en-action-items", category: "office", source: "Action items: Amina will send the report on Friday.", reference: "Mambo ya kutekeleza: Amina atatuma ripoti Ijumaa.", preserve: [["Amina"], ["Ijumaa", "Friday"]] },
  ],
};