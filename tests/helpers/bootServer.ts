/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Boots the *real* application server for the test suite (Phase 8).
 *
 * `server.ts` has no export and calls `httpServer.listen()` at module scope, so
 * the only honest way to test it is the way it actually runs: start it as its own
 * Node process with tsx (the command `npm run dev` uses, plus `NODE_ENV` pinned so
 * it does not also start a second Vite middleware), on a free port, then drive it
 * over real HTTP.
 *
 * Nothing here stubs, mocks or re-implements a route. If the server does not come
 * up, the suite reports the server's own log instead of passing anyway.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, resolved from this file rather than from the cwd. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Where the spawned server's stdout/stderr go, so a test can assert on them. */
export const SERVER_LOG = path.join(ROOT, "tests", ".server.log");

/** Published by the global setup, read by `harness.ts` inside each worker. */
export const SERVER_INFO = path.join(ROOT, "tests", "helpers", "server-info.json");

/** What `globalSetup` hands to the workers through a file (see harness.ts). */
export interface ServerInfo {
  baseUrl: string;
  port: number;
  logFile: string;
  /** False when an already-running instance (TEST_BASE_URL) was reused. */
  spawned: boolean;
  nodeEnv: string;
}

export interface RunningServer {
  info: ServerInfo;
  stop: () => Promise<void>;
}

/** Ask the OS for an unused port, then release it and hand the number over. */
async function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Poll /api/health until the process answers with any status, 200 or 503. */
async function waitForHealth(
  baseUrl: string,
  timeoutMs: number,
  earlyExit: () => Error | null
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";

  while (Date.now() < deadline) {
    const died = earlyExit();
    if (died) throw died;

    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(4000) });
      // A 503 still counts as reachable: the HTTP layer is up, and whether an
      // engine is installed is a separate question the tests report themselves.
      if (response.status < 600) {
        await response.body?.cancel();
        return;
      }
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(`No usable answer from ${baseUrl}/api/health within ${timeoutMs}ms (${lastError}).`);
}

/**
 * Starts the application server, or reuses one.
 *
 * `TEST_BASE_URL` is honoured so the suite can be pointed at an instance that is
 * already running (`npm run dev` on :3000) - useful when a developer wants the
 * tests to exercise the exact process they are watching in a terminal.
 */
export async function startTestServer(): Promise<RunningServer> {
  const external = (process.env.TEST_BASE_URL ?? "").trim().replace(/\/$/, "");
  if (external) {
    const url = new URL(external);
    const info: ServerInfo = {
      baseUrl: external,
      port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
      logFile: process.env.TEST_SERVER_LOG ?? SERVER_LOG,
      spawned: false,
      nodeEnv: process.env.NODE_ENV ?? "development",
    };
    await waitForHealth(info.baseUrl, Number(process.env.TEST_BOOT_TIMEOUT_MS ?? 20_000), () => null);
    return { info, stop: async () => {} };
  }

  await writeFile(SERVER_LOG, "", "utf8");

  const port = await reserveFreePort();

  // One node process running the tsx loader, rather than a tsx wrapper that
  // forks a grandchild: teardown then cannot leave a server holding the port.
  // The loader is passed as a bare specifier on purpose - `--import` parses its
  // argument as a URL, and an absolute Windows path arrives there as protocol
  // 'c:', which Node's ESM loader refuses (ERR_UNSUPPORTED_ESM_URL_SCHEME).
  // The server still loads `.env` itself through dotenv.
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: process.env.TEST_NODE_ENV ?? "production",
      PORT: String(port),
      // The suite talks plain HTTP to 127.0.0.1, exactly as before Phase 7C: the
      // LAN certificate is exercised by its own test rather than by every one.
      HTTPS_ENABLED: process.env.TEST_HTTPS_ENABLED ?? "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const capture = (chunk: Buffer | string) => {
    void appendFile(SERVER_LOG, String(chunk), "utf8").catch(() => {});
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  let exit: { code: number | null } | null = null;
  child.on("exit", (code) => {
    exit = { code };
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const withLog = (message: string) =>
    readFile(SERVER_LOG, "utf8")
      .then((log) => `${message}\n--- server log (first 4000 chars) ---\n${log.slice(0, 4000)}`)
      .catch(() => message);

  try {
    await waitForHealth(baseUrl, Number(process.env.TEST_BOOT_TIMEOUT_MS ?? 120_000), () =>
      exit ? new Error(`Server exited (code ${(exit as { code: number | null }).code}) before it became reachable.`) : null
    );
  } catch (error) {
    child.kill();
    throw new Error(await withLog(error instanceof Error ? error.message : String(error)));
  }

  return {
    info: {
      baseUrl,
      port,
      logFile: SERVER_LOG,
      spawned: true,
      nodeEnv: process.env.TEST_NODE_ENV ?? "production",
    },
    stop: async () => {
      if (exit) return;
      child.kill();
      const deadline = Date.now() + 5_000;
      while (!exit && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  };
}
