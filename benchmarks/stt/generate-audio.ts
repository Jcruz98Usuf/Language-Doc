/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Generates the STT benchmark audio LOCALLY using the Windows speech voices
 * already installed on this machine (System.Speech / SAPI).
 *
 * No cloud text-to-speech is involved: nothing leaves the machine, and no API
 * key exists anywhere in this path. Speech audio is written to
 * benchmarks/stt/audio/ (git-ignored) purely as benchmark input.
 *
 * Run: npm run bench:stt:audio
 */

import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { STT_FIXTURES } from "./fixtures";

const AUDIO_DIR = path.join("benchmarks", "stt", "audio");
const SCRIPT_PATH = path.join("benchmarks", "stt", "audio", ".generate.ps1");

/** PowerShell single-quoted literal: escape by doubling the quote. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildScript(): string {
  const lines = [
    "Add-Type -AssemblyName System.Speech",
    "$ErrorActionPreference = 'Stop'",
    "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    // 16 kHz mono 16-bit: exactly what Whisper wants, so no resampling is needed.
    "$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)",
  ];

  for (const fixture of STT_FIXTURES) {
    const target = path.join(AUDIO_DIR, `${fixture.id}.wav`).replace(/\\/g, "/");
    lines.push(`try { $synth.SelectVoice(${psQuote(fixture.speaker)}) } catch { }`);
    lines.push(`$synth.SetOutputToWaveFile(${psQuote(target)}, $format)`);
    lines.push(`$synth.Speak(${psQuote(fixture.text)})`);
  }

  lines.push("$synth.SetOutputToNull()", "$synth.Dispose()", "Write-Output 'GENERATED'");
  return lines.join("\n");
}

function main(): void {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  fs.writeFileSync(SCRIPT_PATH, buildScript(), "utf8");

  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT_PATH],
    { encoding: "utf8" }
  );

  fs.rmSync(SCRIPT_PATH, { force: true });

  const files = STT_FIXTURES.map((fixture) => path.join(AUDIO_DIR, `${fixture.id}.wav`));
  const missing = files.filter((file) => !fs.existsSync(file));
  const totalBytes = files
    .filter((file) => fs.existsSync(file))
    .reduce((sum, file) => sum + fs.statSync(file).size, 0);

  console.log(output.trim());
  console.log(
    `audio: ${files.length - missing.length}/${files.length} clips, ${(totalBytes / 1024).toFixed(0)} KB total, 16 kHz mono`
  );
  if (missing.length > 0) {
    console.log(`missing: ${missing.join(", ")}`);
    process.exit(1);
  }
}

main();
