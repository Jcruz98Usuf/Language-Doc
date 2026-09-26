/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Text cleanup helpers shared by the translation providers and the intelligence
 * engine (summaries / structured extraction). Small local models leak reasoning
 * blocks, code fences, labels and repetition loops; this module is the single
 * place that normalises such output.
 */

/** Removes markdown code fences and trims the surrounding whitespace. */
export function stripCodeFences(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/^\s*```[a-zA-Z]*\s*/, "")
    .replace(/```\s*$/, "")
    .trim();
}

/**
 * Guards against the repetitive degeneration small local models fall into
 * (for example "kwa matokeo kwa matokeo kwa matokeo ..."). A phrase of two or
 * more words repeated more than `maxRepeats` times in a row is collapsed to a
 * single occurrence.
 */
export function collapseDegenerateRepetition(text: string, maxRepeats = 2): string {
  const words = text.split(/\s+/).filter(Boolean);

  for (let size = 8; size >= 2; size -= 1) {
    if (words.length < size * (maxRepeats + 1)) continue;

    for (let start = 0; start + size * (maxRepeats + 1) <= words.length; start += 1) {
      const phrase = words.slice(start, start + size).join(" ").toLowerCase();
      let repeats = 1;
      let cursor = start + size;

      while (cursor + size <= words.length) {
        const candidate = words.slice(cursor, cursor + size).join(" ").toLowerCase();
        if (candidate !== phrase) break;
        repeats += 1;
        cursor += size;
      }

      if (repeats > maxRepeats) {
        return [...words.slice(0, start + size), ...words.slice(cursor)].join(" ").trim();
      }
    }
  }

  return text;
}

/** Removes the labels and wrapping quotes small models like to add around translations. */
export function cleanTranslationOutput(raw: string): string {
  let text = stripCodeFences(raw)
    .replace(/^(translation|translated text|tafsiri|answer)\s*[:\-–]?\s*/i, "")
    .trim();

  if (text.length > 1) {
    const first = text[0];
    const last = text[text.length - 1];
    const wrapped =
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === "“" && last === "”");
    if (wrapped) text = text.slice(1, -1).trim();
  }

  return collapseDegenerateRepetition(text);
}