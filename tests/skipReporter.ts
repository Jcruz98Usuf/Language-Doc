/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Vitest reporter: says out loud what a green run did not check.
 *
 * A skipped model-tier suite is a pass in every summary line there is, which is
 * exactly how "the tests are green" drifts away from "the behaviour works". This
 * reporter prints the skipped tests, the reason each one was recorded, and a line
 * saying plainly which tiers this run left uncovered. On GitHub Actions it also
 * raises a warning annotation, so the gap is visible on the run page and not only in
 * a log someone has to open.
 *
 * It deliberately imports nothing from vitest at runtime: the shapes it reads are
 * declared locally, so a vitest upgrade cannot break the report.
 */

import { readSkips } from "./helpers/skipFile";

interface TaskLike {
  id?: string;
  name?: string;
  mode?: string;
  type?: string;
  tasks?: TaskLike[];
  result?: { state?: string };
}

interface FileLike {
  name?: string;
  mode?: string;
  tasks?: TaskLike[];
}

function shortPath(name = "unknown file"): string {
  return name.replace(/\\/g, "/").replace(/^.*?\/(tests\/)/, "$1");
}

function relativeToTestName(name = "unknown suite"): string {
  return name.replace(/^.*\/tests\//, "");
}

/** A suite or test skipped by `describe.skip` / `it.skip`, not merely not collected. */
function collectSkipped(tasks: TaskLike[], prefix: string[], found: string[]): void {
  for (const task of tasks) {
    const trail = [...prefix, task.name ?? "?"];

    if (task.mode === "skip" || task.result?.state === "skip") {
      found.push(trail.join(" > "));
      // Everything inside a skipped suite is skipped too; one line is enough.
      continue;
    }

    if (task.tasks?.length) collectSkipped(task.tasks, trail, found);
  }
}

export default class SkipReporter {
  onFinished(files: FileLike[] = []): void {
    const skipped: string[] = [];

    for (const file of files) {
      if (file.mode === "skip") {
        skipped.push(shortPath(file.name));
        continue;
      }
      if (file.tasks?.length) collectSkipped(file.tasks, [shortPath(file.name)], skipped);
    }

    if (skipped.length === 0) {
      console.log("\n\x1b[32m✓ no skipped coverage - every tier ran\x1b[0m\n");
      return;
    }

    const reasons = readSkips();
    console.log("\n\x1b[33m── Coverage this run did not assert ─────────────────────────\x1b[0m");
    for (const entry of skipped) console.log(`  \x1b[33m-\x1b[0m ${entry}`);

    if (reasons.length > 0) {
      console.log("\n  Why:");
      for (const reason of reasons) console.log(`    ${reason.label}\n      ${reason.reason}`);
    }

    console.log(
      "\n  The model tier (real translations, extractions and audio) needs Ollama,\n" +
        "  Pocket TTS and a Whisper engine on the machine running the suite. Run it\n" +
        "  locally with `npm run test:all` before shipping a change to an engine.\n"
    );

    if (process.env.GITHUB_ACTIONS) {
      // One annotation naming the gap, rather than one per test: the point is that
      // the run page cannot be read as full coverage.
      console.log(
        `::warning title=Model tier not exercised::${skipped.length} tests were skipped because local engines are unavailable (GitHub runners have none). Contract tier only.`
      );
    }
  }
}
