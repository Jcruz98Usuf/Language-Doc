/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * English -> French benchmark fixtures (Phase 1.6).
 *
 * Mirrors fixtures.en-sw.ts case-for-case (same ids and categories) so the
 * Swahili and French results are directly comparable.
 */

import type { FixtureFile } from "./types";

export const EN_FR: FixtureFile = {
  direction: "English -> French",
  sourceLanguage: "English",
  targetLanguage: "French",
  cases: [
    { id: "en-greeting", category: "greeting", source: "Good morning, doctor.", reference: "Bonjour, docteur." },
    { id: "en-conversation", category: "conversation", source: "How are you feeling today?", reference: "Comment vous sentez-vous aujourd'hui ?" },
    { id: "en-numbers", category: "numbers", source: "The bill is 15,000 shillings for three days.", reference: "La facture est de 15 000 shillings pour trois jours.", preserve: [["15,000", "15 000", "15000"], ["trois", "3"]] },
    { id: "en-dates", category: "dates", source: "Your appointment is on 12 March 2026.", reference: "Votre rendez-vous est le 12 mars 2026.", preserve: [["12"], ["mars", "Mars", "March"], ["2026"]] },
    { id: "en-names", category: "names", source: "Please call Nurse Amina to room four.", reference: "Veuillez appeler l'infirmière Amina dans la chambre quatre.", preserve: [["Amina"]] },
    { id: "en-clinic", category: "clinic", source: "I have been taking this medicine for five days but the pain has not stopped.", reference: "Je prends ce médicament depuis cinq jours mais la douleur ne s'est pas arrêtée.", preserve: [["cinq", "5"]] },
    { id: "en-symptoms", category: "symptoms", source: "My chest feels heavy and I am short of breath.", reference: "J'ai la poitrine lourde et j'ai du mal à respirer." },
    { id: "en-medication", category: "medication", source: "Take one tablet of paracetamol 500 mg twice a day after meals.", reference: "Prenez un comprimé de paracétamol 500 mg deux fois par jour après les repas.", preserve: [["paracetamol", "paracétamol"], ["500"], ["mg"]] },
    { id: "en-hotel", category: "hotel", source: "I would like to book a double room for two nights with breakfast included.", reference: "Je voudrais réserver une chambre double pour deux nuits avec petit-déjeuner inclus.", preserve: [["deux", "2"]] },
    { id: "en-office", category: "office", source: "The meeting is on Monday, please send me the report before then.", reference: "La réunion est lundi, veuillez m'envoyer le rapport avant.", preserve: [["lundi", "Lundi", "Monday"]] },
    { id: "en-question", category: "question", source: "Do you understand what I am saying?", reference: "Comprenez-vous ce que je dis ?" },
    { id: "en-negation", category: "negation", source: "I am not allowed to eat food with salt.", reference: "Je ne suis pas autorisé à manger des aliments contenant du sel." },
    { id: "en-instruction", category: "instruction", source: "Open your mouth and breathe in deeply.", reference: "Ouvrez la bouche et respirez profondément." },
    { id: "en-clinic-2", category: "clinic", source: "The doctor will see you after the nurse checks your blood pressure.", reference: "Le médecin vous verra après que l'infirmière aura pris votre tension artérielle." },
  ],
};