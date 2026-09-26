/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * French -> Swahili PIVOT fixture (Phase 1.6, items 2-8 and 12).
 *
 * There is no direct FR↔SW model, so this direction runs as two stages
 * (French→English→Swahili). It is benchmarked separately from the direct
 * directions because two-stage translation can compound errors, and the report
 * keeps it labelled "pivoted" so it is never mistaken for a direct pair.
 *
 * French sources mirror fixtures.en-fr.ts; Swahili references mirror the
 * equivalent sentences in fixtures.en-sw.ts.
 */

import type { FixtureFile } from "./types";

export const FR_SW: FixtureFile = {
  direction: "French -> Swahili (pivoted via English)",
  sourceLanguage: "French",
  targetLanguage: "Swahili",
  cases: [
    { id: "fr-sw-greeting", category: "greeting", source: "Bonjour, docteur.", reference: "Habari ya asubuhi, daktari." },
    { id: "fr-sw-numbers", category: "numbers", source: "La facture est de 15 000 shillings pour trois jours.", reference: "Bili ni shilingi 15,000 kwa siku tatu.", preserve: [["15,000", "15 000", "15000"]] },
    { id: "fr-sw-dates", category: "dates", source: "Votre rendez-vous est le 12 mars 2026.", reference: "Miadi yako ni tarehe 12 Machi 2026.", preserve: [["12"], ["Machi", "March"], ["2026"]] },
    { id: "fr-sw-names", category: "names", source: "Veuillez appeler l'infirmière Amina dans la chambre quatre.", reference: "Tafadhali mwite muuguzi Amina kwenye chumba cha nne.", preserve: [["Amina"]] },
    { id: "fr-sw-medication", category: "medication", source: "Prenez un comprimé de paracétamol 500 mg deux fois par jour après les repas.", reference: "Chukua kidonge kimoja cha paracetamol 500 mg mara mbili kwa siku baada ya mlo.", preserve: [["paracetamol", "paracetamoli"], ["500"], ["mg"]] },
    { id: "fr-sw-hotel", category: "hotel", source: "Je voudrais réserver une chambre double pour deux nuits avec petit-déjeuner inclus.", reference: "Ningependa kupanga chumba cha watu wawili kwa siku mbili pamoja na kiamshakinywa." },
    { id: "fr-sw-office", category: "office", source: "La réunion est lundi, veuillez m'envoyer le rapport avant.", reference: "Mkutano ni Jumatatu, tafadhali nitumie ripoti kabla ya hapo.", preserve: [["Jumatatu", "Monday"]] },
    { id: "fr-sw-negation", category: "negation", source: "Je ne suis pas autorisé à manger des aliments contenant du sel.", reference: "Siruhusiwi kula chakula chenye chumvi." },
  ],
};