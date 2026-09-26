/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Scoring helpers for the Phase 1.5 translation benchmark. All checks run on
 * the RAW model output (after <think> stripping only) so provider quality is
 * measured, not post-processed quality.
 */

export interface CaseFlags {
  empty: boolean;
  repetition: boolean;
  sourceCopy: boolean;
}

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein similarity ratio 0..1. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const rows = b.length + 1;
  let prev = new Array<number>(rows).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/** Detects "kwa matokeo kwa matokeo kwa matokeo" style loops in raw output. */
export function detectRepetition(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 8) return false;

  // Same word repeated >= 4 times.
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  for (const count of counts.values()) if (count >= 4) return true;

  // Same 2-gram repeated >= 3 times in a row.
  for (let i = 0; i + 6 <= words.length; i += 1) {
    const bigram = words.slice(i, i + 2).join(" ");
    if (words.slice(i + 2, i + 4).join(" ") === bigram && words.slice(i + 4, i + 6).join(" ") === bigram) {
      return true;
    }
  }
  return false;
}

/** True when the model basically echoed the source instead of translating. */
export function isSourceCopy(raw: string, source: string): boolean {
  const out = normalize(raw);
  const src = normalize(source);
  if (!out || !src) return false;
  if (out === src) return true;
  const lengthRatio = out.length / src.length;
  return similarity(out, src) >= 0.92 && lengthRatio > 0.6 && lengthRatio < 1.6;
}

/** Each group passes when ANY variant appears (word-boundary, case-insensitive). */
export function missingPreserveTokens(output: string, groups: string[][] | undefined): string[] {
  if (!groups || groups.length === 0) return [];
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const missing: string[] = [];
  for (const group of groups) {
    const found = group.some((variant) =>
      new RegExp(`(^|[^\\p{L}\\p{N}])${escaped(variant)}([^\\p{L}\\p{N}]|$)`, "iu").test(output)
    );
    if (!found) missing.push(group.join("|"));
  }
  return missing;
}

export function computeFlags(raw: string, source: string): CaseFlags {
  const trimmed = raw.trim();
  return {
    empty: trimmed.length === 0,
    repetition: detectRepetition(trimmed),
    sourceCopy: isSourceCopy(trimmed, source),
  };
}

/** Removes qwen3-style reasoning blocks before any measurement. */
export function stripThink(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^<think>[\s\S]*/i, "") // unterminated think block
    .trim();
}