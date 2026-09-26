/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Swahili -> English benchmark fixtures (Phase 1.5).
 */

import type { FixtureFile } from "./types";

export const SW_EN: FixtureFile = {
  direction: "Swahili -> English",
  sourceLanguage: "Swahili",
  targetLanguage: "English",
  cases: [
    { id: "sw-greeting", category: "greeting", source: "Habari ya jioni, daktari.", reference: "Good evening, doctor." },
    { id: "sw-conversation", category: "conversation", source: "Mtoto ana homa na kikohozi kuanzia jana.", reference: "The child has had a fever and a cough since yesterday." },
    { id: "sw-numbers", category: "numbers", source: "Nimepoteza kadi yangu ya bima, namba yake ni 2233.", reference: "I have lost my insurance card; its number is 2233.", preserve: [["2233"]] },
    { id: "sw-dates", category: "dates", source: "Nilianza kuhisi maumivu tarehe 9 Oktoba.", reference: "I started feeling the pain on 9 October.", preserve: [["9"], ["October", "Oktoba"]] },
    { id: "sw-names", category: "names", source: "Mama Fatuma anahitaji dawa yake muda wowote.", reference: "Fatuma's mother needs her medicine at any time.", preserve: [["Fatuma"]] },
    { id: "sw-clinic", category: "clinic", source: "Nimekuwa nikichukua dawa hii kwa wiki moja lakini bado nahisi maumivu ya kichwa.", reference: "I have been taking this medicine for one week, but I still have a headache." },
    { id: "sw-symptoms", category: "symptoms", source: "Koo linauma na kichwa kinauma sana.", reference: "My throat hurts and my head hurts badly." },
    { id: "sw-medication", category: "medication", source: "Dozi ni kapsuli moja ya amoksilini 250 mg mara tatu kwa siku.", reference: "The dose is one capsule of amoxicillin 250 mg three times a day.", preserve: [["250"], ["mg"], ["amoxicillin", "amoksilini"]] },
    { id: "sw-hotel", category: "hotel", source: "Niwekee chumba chenye mwonekano wa bahari, na bei gani kwa siku?", reference: "Please give me a room with an ocean view, and what is the price per day?" },
    { id: "sw-office", category: "office", source: "Mkutano wa Jumatatu umehairishwa hadi Ijumaa.", reference: "Monday's meeting has been postponed to Friday.", preserve: [["Monday", "Jumatatu"], ["Friday", "Ijumaa"]] },
    { id: "sw-question", category: "question", source: "Unaelewa ninachosema?", reference: "Do you understand what I am saying?" },
    { id: "sw-negation", category: "negation", source: "Sitakuja kwa mkutano kwa sababu ni mgonjwa.", reference: "I will not come to the meeting because I am sick." },
    { id: "sw-instruction", category: "instruction", source: "Pima shinikizo la damu na halijoto ya mwili.", reference: "Measure the blood pressure and the body temperature." },
    { id: "sw-chest-pain", category: "symptoms", source: "Nina maumivu ya kifua ninapopumua.", reference: "I have chest pain when I breathe." },
    { id: "sw-stomach-pain", category: "symptoms", source: "Una maumivu ya kichwa au maumivu ya tumbo?", reference: "Do you have a headache or stomach pain?" },
    { id: "sw-yesno", category: "question", source: "Maumivu ni ya kila wakati? Hapana, yanakuja na kuondoka.", reference: "Is the pain constant? No, it comes and goes." },
    { id: "sw-amoxicillin", category: "medication", source: "Chukua amoxicillin 250 mg mara tatu kwa siku kwa siku saba.", reference: "Take amoxicillin 250 mg three times a day for seven days.", preserve: [["amoxicillin", "amoksilini"], ["250"], ["mg"], ["seven", "saba", "7"]] },
    { id: "sw-room-number", category: "hotel", source: "Namba ya chumba chako ni 204 kwenye ghorofa ya pili.", reference: "Your room number is 204 on the second floor.", preserve: [["204"]] },
    { id: "sw-daily-rate", category: "hotel", source: "Bei ya kila siku ni shilingi 85,000 ikiwa ni pamoja na kiamshakinywa.", reference: "The daily rate is 85,000 shillings including breakfast.", preserve: [["85,000", "85 000", "85000"]] },
    { id: "sw-action-items", category: "office", source: "Mambo ya kutekeleza: Amina atatuma ripoti Ijumaa.", reference: "Action items: Amina will send the report on Friday.", preserve: [["Amina"], ["Friday", "Ijumaa"]] },
  ],
};