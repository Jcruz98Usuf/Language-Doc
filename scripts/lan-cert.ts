/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One-time LAN certificate for phone voice input (Phase 7C).
 *
 * A phone browser refuses `getUserMedia` unless the page is in a secure context,
 * and `http://<lan-ip>` never is one. This script creates a certificate a phone
 * can be shown to trust, using mkcert's local CA - the same mechanism browsers
 * use for their own dev certificates. It is deliberately offline: no ACME, no
 * tunnel, no certificate authority on the internet, and nothing is uploaded.
 *
 *   npm run cert:lan              localhost + 127.0.0.1 + every LAN IPv4 now up
 *   npm run cert:lan -- 10.0.0.9  add an address you know the laptop will use
 *
 * Write into `certs/` (git-ignored) and print what to do with it afterwards.
 * Re-run it whenever the laptop's LAN address changes - the certificate lists
 * addresses literally, so a new DHCP lease shows up on the phone as a warning,
 * and a warning is not something to click past in front of a patient.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CERT_DIR = path.join(ROOT, "certs");
const CERT_FILE = path.join(CERT_DIR, "cert.pem");
const KEY_FILE = path.join(CERT_DIR, "key.pem");

/** Where mkcert puts its own files; `winget` installs it outside PATH sometimes. */
const MKCERT_HINTS = [
  process.env.MKCERT_PATH ?? "",
  "mkcert",
  path.join(process.env.LOCALAPPDATA ?? "", "Microsoft/WinGet/Packages"),
  path.join(process.env.ProgramData ?? "", "chocolatey/bin/mkcert.exe"),
  path.join(process.env.USERPROFILE ?? "", "scoop/shims/mkcert.exe"),
];

function firstUsable(candidate: string): string | null {
  if (!candidate) return null;
  if (candidate.includes(path.sep) || candidate.includes("/")) {
    // A directory hint: look for the executable inside it (winget nests it).
    if (existsSync(candidate) && !/\.(exe|cmd|bat)$/i.test(candidate)) {
      try {
        for (const entry of readdirSync(candidate, { recursive: true }) as string[]) {
          const full = path.join(candidate, String(entry));
          if (/mkcert\.exe$/i.test(full) && existsSync(full)) return full;
        }
      } catch {
        /* unreadable hint directory */
      }
      return null;
    }
    return existsSync(candidate) ? candidate : null;
  }
  try {
    execFileSync(candidate, ["-version"], { stdio: "pipe", windowsHide: true });
    return candidate;
  } catch {
    return null;
  }
}

function findMkcert(): string {
  for (const candidate of MKCERT_HINTS) {
    const found = firstUsable(candidate);
    if (found) return found;
  }
  throw new Error(
    "mkcert was not found. Install it (`winget install FiloSottile.mkcert`, or brew install mkcert) " +
      "or set MKCERT_PATH to its executable, then run this again."
  );
}

/** Every address worth putting in the certificate: loopback plus live LAN IPv4s. */
function addresses(extra: string[]): string[] {
  const list = new Set<string>(["localhost", "127.0.0.1", "::1"]);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family === "IPv4" && !entry.address.startsWith("169.254.")) list.add(entry.address);
      // IPv6 link-local addresses carry a `%zone` suffix mkcert cannot use.
      if (entry.family === "IPv6" && !entry.address.includes("%")) list.add(entry.address);
    }
  }
  for (const value of extra) {
    const trimmed = value.trim();
    if (trimmed) list.add(trimmed);
  }
  return [...list];
}

function run(mkcert: string, args: string[]): string {
  return execFileSync(mkcert, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

function main(): void {
  const mkcert = findMkcert();
  const caroot = run(mkcert, ["-CAROOT"]).trim();

  // Idempotent: on an already-initialized machine this prints "The local CA is
  // already installed" and changes nothing.
  const install = run(mkcert, ["-install"]);

  const names = addresses(process.argv.slice(2));
  mkdirSync(CERT_DIR, { recursive: true });

  run(mkcert, ["-cert-file", CERT_FILE, "-key-file", KEY_FILE, ...names]);

  // The only file a phone has to be given is mkcert's CA certificate. mkcert keeps
  // it in CAROOT - a hidden, machine-specific folder - and that is the file people
  // then go hunting for at the worst possible moment, with a patient waiting. So a
  // copy stays beside the cert, inside the git-ignored certs/ folder, and the
  // contract suite verifies the chain the server offers against that same copy.
  const carootCa = path.join(caroot, "rootCA.pem");
  const localCa = path.join(CERT_DIR, "rootCA.pem");
  if (existsSync(carootCa)) copyFileSync(carootCa, localCa);

  const port = process.env.PORT ?? "3000";
  const lanNames = names.filter((name) => name !== "localhost" && !name.startsWith("127.") && name !== "::1" && !name.includes(":"));

  console.log(install.trim());
  console.log(`\ncertificate : ${CERT_FILE.replace(ROOT + path.sep, "")} + ${KEY_FILE.replace(ROOT + path.sep, "")}`);
  console.log(`valid for   : ${names.join(", ")}`);
  console.log(`mkcert CA   : ${caroot}`);
  console.log(`CA file     : ${existsSync(localCa) ? path.relative(ROOT, localCa) : carootCa}  <- the one file a phone must be given`);
  console.log("\nThe server picks this up on its own: `npm run dev` now serves HTTPS.");
  if (lanNames.length) {
    console.log("Phone join URLs once it is running:");
    for (const name of lanNames) console.log(`  https://${name}:${port}`);
  } else {
    console.log("No LAN address found - connect the laptop to the network first, then run this again.");
  }
  console.log("\nInstall the CA on the phone once, by hand: docs/phone-voice-demo.md");
  console.log("Re-run `npm run cert:lan` whenever this laptop gets a new address.");
}

try {
  main();
} catch (error) {
  console.error(`[cert:lan] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
