/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Phase 1.5 translation benchmark fixture types.
 */

export type BenchmarkCategory =
  | "greeting"
  | "conversation"
  | "numbers"
  | "dates"
  | "names"
  | "clinic"
  | "symptoms"
  | "medication"
  | "hotel"
  | "office"
  | "question"
  | "negation"
  | "instruction";

export interface TranslationCase {
  id: string;
  category: BenchmarkCategory;
  /** Input text exactly as it would arrive from the conversation UI. */
  source: string;
  /**
   * Short human-written reference translation (standard Swahili / English).
   * These are NOT official gold standards and are not scored automatically;
   * they exist so a human reviewer can eyeball quality per category.
   */
  reference: string;
  /**
   * Tokens that must survive translation (names, numbers, dosages...).
   * Each group lists acceptable variants; a group passes when ANY variant
   * appears in the output (case-insensitive, word-boundary match).
   */
  preserve?: string[][];
}

export interface FixtureFile {
  /** "English -> Swahili" style label used in reports. */
  direction: string;
  sourceLanguage: string;
  targetLanguage: string;
  cases: TranslationCase[];
}