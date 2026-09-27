/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Vitest configuration (Phase 8).
 *
 * Kept separate from `vite.config.ts` on purpose: the client build needs the
 * React and Tailwind plugins, the test run needs neither. Every test here is a
 * real HTTP request against a real server process that `tests/helpers/
 * globalSetup.ts` boots on an ephemeral port - there is no in-process mock of
 * the API anywhere in this suite.
 *
 * Files are run one at a time (`fileParallelism: false`) because they share that
 * single server: parallel workers would race over the session store and over the
 * one-at-a-time speech and transcription engines.
 */

import { defineConfig } from "vitest/config";
import SkipReporter from "./tests/skipReporter";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/helpers/globalSetup.ts"],
    fileParallelism: false,
    // Model-backed requests (Whisper, Pocket TTS, a cold chat-model prompt) are
    // legitimately slow; contract requests finish in milliseconds.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // `default` for the usual per-test lines; SkipReporter for what they hide.
    reporters: ["default", new SkipReporter()],
  },
});
