/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * French -> English benchmark fixtures (Phase 1.6).
 *
 * Mirrors fixtures.sw-en.ts case-for-case (same ids and categories) so the
 * Swahili and French results are directly comparable.
 */

import type { FixtureFile } from "./types";

export const FR_EN: FixtureFile = {
  direction: "French -> English",
  sourceLanguage: "French",
  targetLanguage: "English",
  cases: [
    { id: "fr-greeting", category: "greeting", source: "Bonjour, docteur.", reference: "Good morning, doctor.", preserve: [["Bonjour", "Hello", "Good morning"]] },
    { id: "fr-conversation", category: "conversation", source: "Comment vous sentez-vous aujourd'hui ?", reference: "How are you feeling today?" },
    { id: "fr-numbers", category: "numbers", source: "La facture s'élève à 15 000 shillings pour trois jours.", reference: "The bill is 15,000 shillings for three days.", preserve: [["15,000", "15 000", "15000"], ["three", "3"]] },
    { id: "fr-dates", category: "dates", source: "Votre rendez-vous est le 12 mars 2026.", reference: "Your appointment is on 12 March 2026.", preserve: [["12"], ["March", "march"], ["2026"]] },
    { id: "fr-names", category: "names", source: "Veuillez appeler l'infirmière Amina dans la chambre quatre.", reference: "Please call Nurse Amina to room four.", preserve: [["Amina"]] },
    { id: "fr-clinic", category: "clinic", source: "Je prends ce médicament depuis cinq jours mais la douleur ne s'est pas arrêtée.", reference: "I have been taking this medicine for five days but the pain has not stopped.", preserve: [["five", "5"]] },
    { id: "fr-symptoms", category: "symptoms", source: "J'ai la poitrine lourde et j'ai du mal à respirer.", reference: "My chest feels heavy and I am short of breath." },
    { id: "fr-medication", category: "medication", source: "Prenez un comprimé de paracétamol 500 mg deux fois par jour après les repas.", reference: "Take one tablet of paracetamol 500 mg twice a day after meals.", preserve: [["paracetamol", "paracétamol"], ["500"], ["mg"]] },
    { id: "fr-hotel", category: "hotel", source: "Je voudrais réserver une chambre double pour deux nuits avec petit-déjeuner inclus.", reference: "I would like to book a double room for two nights with breakfast included.", preserve: [["two", "2"]] },
    { id: "fr-office", category: "office", source: "La réunion est lundi, veuillez m'envoyer le rapport avant.", reference: "The meeting is on Monday, please send me the report before then.", preserve: [["Monday", "monday"]] },
    { id: "fr-question", category: "question", source: "Comprenez-vous ce que je dis ?", reference: "Do you understand what I am saying?" },
    { id: "fr-negation", category: "negation", source: "Je ne suis pas autorisé à manger des aliments contenant du sel.", reference: "I am not allowed to eat food with salt." },
    { id: "fr-instruction", category: "instruction", source: "Ouvrez la bouche et respirez profondément.", reference: "Open your mouth and breathe in deeply." },
    { id: "fr-clinic-2", category: "clinic", source: "Le médecin vous verra après que l'infirmière aura pris votre tension artérielle.", reference: "The doctor will see you after the nurse checks your blood pressure." },
  ],
};