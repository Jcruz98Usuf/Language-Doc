/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Vitest global setup: one server process for the whole suite.
 *
 * The base URL travels to the workers through a JSON file rather than through
 * `process.env`, because environment changes made in a global setup are not
 * guaranteed to reach already-spawned workers - a file is unambiguous.
 */

import { rm, writeFile } from "node:fs/promises";
import { SERVER_INFO, startTestServer, type ServerInfo } from "./bootServer";
import { SKIP_FILE } from "./skipFile";

export default async function setup(): Promise<() => Promise<void>> {
  // A skip reason recorded by an earlier run must not be reported by this one.
  await rm(SKIP_FILE, { force: true });

  const { info, stop } = await startTestServer();

  await writeFile(SERVER_INFO, JSON.stringify(info, null, 2), "utf8");
  describeLine(info);

  return async () => {
    await stop();
  };
}

/**
 * Loud, deliberate banner: which instance the suite is talking to. The suite
 * never silently changes what it covers, so the run always states whether it
 * drove a process it started itself or an instance that was already running.
 */
function describeLine(info: ServerInfo): void {
  console.log(
    `\n[test-server] real server under test: ${info.baseUrl} ` +
      `(${info.spawned ? `started by vitest, NODE_ENV=${info.nodeEnv}` : "already running - reused"}, ` +
      `log: ${info.logFile})\n`
  );
}
