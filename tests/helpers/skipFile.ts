/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A one-line-per-reason record of why coverage was skipped.
 *
 * The test files run in worker processes and the reporter in the main one, so a
 * file in the OS temp directory is the cheapest way for them to agree on what was
 * skipped and why. `globalSetup.ts` deletes it at the start of every run, so a
 * reason can never survive into a report that did not earn it.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SkipRecord {
  label: string;
  reason: string;
}

export const SKIP_FILE = join(tmpdir(), "language-doc-skip-reasons.jsonl");

export function recordSkip(label: string, reason: string): void {
  try {
    appendFileSync(SKIP_FILE, `${JSON.stringify({ label, reason })}\n`);
  } catch {
    // A missing reason note must never fail a test run.
  }
}

export function readSkips(): SkipRecord[] {
  try {
    return readFileSync(SKIP_FILE, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as SkipRecord);
  } catch {
    return [];
  }
}
