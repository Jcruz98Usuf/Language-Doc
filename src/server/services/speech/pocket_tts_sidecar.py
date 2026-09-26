#!/usr/bin/env python3
# @license SPDX-License-Identifier: Apache-2.0
"""Kyutai Pocket TTS sidecar (Phase 7B, Stage 1 - standard voice).

A local, offline text-to-speech worker. Express owns it: the server spawns this
process with a fixed argument list, talks to it over stdin/stdout as JSON lines,
and is the only caller. No browser request ever reaches this process directly,
and nothing here accepts an executable path, model path, shell argument, file
name, Python command or URL from the caller.

Contract (one JSON object per line, UTF-8, never anything else on stdout):

  -> {"id": "...", "cmd": "synth", "text": "...", "language": "english", "voiceMode": "standard"}
  <- {"id": "...", "ok": true, "wavB64": "...", "sampleRate": 24000, ...}
  <- {"id": "...", "ok": false, "code": "synthesis-failed", "message": "..."}

  -> {"id": "...", "cmd": "status"}
  <- {"id": "...", "ok": true, "languages": [...], "resident": [...], ...}

  -> {"cmd": "shutdown"}

Privacy and retention (exact behaviour, not intent):

* Audio is produced in memory (`wave` writes into `io.BytesIO`) and handed back
  base64-encoded. This process never opens a file for writing, never uses a
  temporary directory, and never creates a directory.
* Text is passed straight to the model as input. It is never logged, echoed
  back, written to disk or included in an error message; only its length is
  reported.
* HF_HUB_OFFLINE=1 by default: a missing weight makes the request fail with a
  clear error instead of silently reaching out to the network, so the
  no-cloud guarantee is enforced here and not merely assumed.
* The voice for each language is a built-in precomputed embedding; this sidecar
  accepts no reference audio at all, so there is nothing to retain or delete.

Engine : Kyutai Pocket TTS (weights: kyutai/pocket-tts-without-voice-cloning)
Runtime: PyTorch (CPU) + the `pocket_tts` package, already installed locally.
"""

from __future__ import annotations

import base64
import ctypes
import io
import json
import logging
import os
import sys
import threading
import time
import wave
from ctypes import wintypes

# Must be set before huggingface_hub/pocket_tts are imported.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("PYTHONUTF8", "1")
os.environ["PYTHONIOENCODING"] = "utf-8"

# Hard limits. They mirror the Express-side validation and exist so a bug in the
# caller can never make this process generate a multi-minute utterance.
MAX_TEXT_CHARS = 500
MIN_TEXT_CHARS = 1

# Absolute ceiling on generated speech. A normal 500-character message is around
# 40 seconds; this only bites on pathological input (a repeated token the model
# never decides to end), which is otherwise able to occupy the CPU for minutes.
# Measured: "x" * 5000 could not be stopped and burned ~11 minutes of CPU before
# this cap existed. Reaching it is reported as `truncated` rather than hidden.
MAX_AUDIO_SECONDS = 60

# Built-in voices, one per supported language. These are catalogue entries of
# the released model (precomputed prompt embeddings), i.e. standard voices -
# this build has no voice-cloning weights and accepts no reference audio.
LANGUAGE_VOICES = {"english": "alba", "french": "cosette"}
SUPPORTED_LANGUAGES = tuple(LANGUAGE_VOICES)

# How many languages may stay loaded at once. One model is roughly a gigabyte of
# resident memory, so the newest languages win and older ones are evicted.
MAX_RESIDENT_LANGUAGES = int(os.environ.get("SPEECH_TTS_MAX_RESIDENT", "2") or "2")

VOICE_MODE_STANDARD = "standard"
# Voice matching ("clone") needs the separate gated cloning weights, which are
# not installed here. It is reported as unavailable rather than silently ignored.
VOICE_MODE_CLONE = "clone"

logger = logging.getLogger("pocket_tts_sidecar")


def _configure_stdout() -> None:
    """stdout carries the protocol only, so it must be UTF-8 and unbuffered-ish."""
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    sys.stderr.reconfigure(encoding="utf-8", newline="\n")


def _memory_mb() -> tuple[float, float]:
    """(working set, peak working set) of this process in MB; (0, 0) if unknown."""
    try:
        class ProcessMemoryCounters(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD),
                ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi.GetProcessMemoryInfo.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(ProcessMemoryCounters),
            wintypes.DWORD,
        ]
        psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE

        counters = ProcessMemoryCounters()
        counters.cb = ctypes.sizeof(ProcessMemoryCounters)
        if not psapi.GetProcessMemoryInfo(
            kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb
        ):
            return (0.0, 0.0)
        return (counters.WorkingSetSize / 1e6, counters.PeakWorkingSetSize / 1e6)
    except Exception:  # pragma: no cover - diagnostics must never break synthesis
        return (0.0, 0.0)


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _silence_third_party_logs() -> None:
    """Hold every logger except ours at WARNING.

    The Pocket TTS library raises its own logger to INFO and logs the directory
    the weights were loaded from. This process's stderr is forwarded into the
    server log, and the server log must not carry filesystem paths, so the
    library's chatter is switched off - including after import, when it gets a
    chance to set its own level.
    """
    logging.getLogger().setLevel(logging.WARNING)
    for name, existing in logging.Logger.manager.loggerDict.items():
        if name == logger.name or not isinstance(existing, logging.Logger):
            continue
        if existing.level < logging.WARNING:
            existing.setLevel(logging.WARNING)


def _fail(request_id: str | None, code: str, message: str) -> None:
    logger.warning("%s: %s", code, message)
    _emit({"id": request_id, "ok": False, "code": code, "message": message})



class LanguageEngine:
    """One loaded language: the model plus its precomputed standard-voice state."""

    def __init__(self, language: str) -> None:
        from pocket_tts import TTSModel  # imported lazily: the torch import is ~20s

        self.language = language
        self.voice = LANGUAGE_VOICES[language]
        started = time.perf_counter()
        self.model = TTSModel.load_model(language=language)
        # The library configures logging while importing; silence it again now
        # that it has had its chance to raise its own level.
        _silence_third_party_logs()
        self.load_seconds = time.perf_counter() - started
        self.voice_state = self.model.get_state_for_audio_prompt(self.voice)
        logger.info("loaded %s (voice %s) in %.2fs", language, self.voice, self.load_seconds)

    @property
    def model_id(self) -> str:
        return f"kyutai/pocket-tts-without-voice-cloning:{self.language}"

    @property
    def sample_rate(self) -> int:
        return int(self.model.sample_rate)


class EnginePool:
    """Keeps at most MAX_RESIDENT_LANGUAGES models in memory, newest first.

    Pocket TTS generation is not thread-safe and the protocol is strictly one
    request at a time, so a single pool is enough. Models are evicted when the
    limit is exceeded; peak resident memory is bounded by that limit and is
    reported through `status`.
    """

    def __init__(self) -> None:
        self._engines: dict[str, LanguageEngine] = {}
        self._order: list[str] = []
        self._first_load_ms: int | None = None

    @property
    def first_load_ms(self) -> int | None:
        return self._first_load_ms

    def get(self, language: str) -> LanguageEngine:
        engine = self._engines.get(language)
        if engine is not None:
            self._order.remove(language)
            self._order.append(language)
            return engine

        engine = LanguageEngine(language)
        self._engines[language] = engine
        self._order.append(language)
        if self._first_load_ms is None:
            self._first_load_ms = int(engine.load_seconds * 1000)

        while len(self._order) > max(1, MAX_RESIDENT_LANGUAGES):
            evicted = self._order.pop(0)
            self._engines.pop(evicted, None)
            logger.info("evicted %s to keep resident memory bounded", evicted)

        return engine

    def residents(self) -> list[str]:
        return list(self._order)


_POOL = EnginePool()


def _clean_text(raw: object) -> str:
    """Strips control characters and caps the length. Never logged, never stored."""
    if not isinstance(raw, str):
        raise ValueError("text must be a string")
    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(ch if ch >= " " or ch == "\n" else " " for ch in text)
    text = " ".join(text.split())
    if len(text) < MIN_TEXT_CHARS:
        raise ValueError("text is empty")
    return text[:MAX_TEXT_CHARS]


def _encode_wav(pcm: bytes, sample_rate: int) -> bytes:
    """16-bit PCM WAV in memory; nothing touches the filesystem."""
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm)
    return buffer.getvalue()


def synthesize(request_id: str, payload: dict) -> None:
    language = str(payload.get("language", "")).strip().lower()
    voice_mode = str(payload.get("voiceMode", VOICE_MODE_STANDARD)).strip().lower()

    if voice_mode == VOICE_MODE_CLONE:
        _fail(
            request_id,
            "clone-unavailable",
            "Voice matching is not available in this build: the gated voice-cloning "
            "weights are not installed. Standard voice playback is unaffected.",
        )
        return
    if voice_mode != VOICE_MODE_STANDARD:
        _fail(request_id, "bad-voice-mode", f"Unsupported voiceMode {voice_mode!r}.")
        return
    if language not in LANGUAGE_VOICES:
        _fail(
            request_id,
            "unsupported-language",
            f"Local voice playback supports {', '.join(SUPPORTED_LANGUAGES)} only.",
        )
        return

    try:
        text = _clean_text(payload.get("text"))
    except ValueError as error:
        _fail(request_id, "bad-text", str(error))
        return

    # Only the length is ever reported; the text itself stays in this process.
    logger.info("synth id=%s language=%s chars=%d", request_id, language, len(text))

    try:
        engine = _POOL.get(language)
    except Exception as error:  # noqa: BLE001 - a load failure is an outage, not a crash
        _fail(
            request_id,
            "engine-unavailable",
            f"Pocket TTS could not start ({type(error).__name__}).",
        )
        return

    try:
        import numpy as np
        import torch

        started = time.perf_counter()
        first_chunk_at: float | None = None
        chunks = []
        emitted = 0
        truncated = False
        stop = threading.Event()
        max_samples = int(MAX_AUDIO_SECONDS * engine.sample_rate)

        # `stop` ends the stream early without abandoning the generator: the loop
        # keeps consuming until the engine finishes its in-flight frames, so no
        # decoder thread is left behind.
        for chunk in engine.model.generate_audio_stream(engine.voice_state, text, stop=stop):
            if first_chunk_at is None:
                first_chunk_at = time.perf_counter() - started
            chunks.append(chunk)
            emitted += int(chunk.shape[-1])
            if emitted >= max_samples and not truncated:
                truncated = True
                stop.set()
                logger.warning("reached the %ds audio ceiling; truncating", MAX_AUDIO_SECONDS)

        if not chunks:
            raise RuntimeError("the engine produced no audio")

        audio = torch.cat(chunks, dim=0)
        if truncated:
            audio = audio[:max_samples]
        samples = int(audio.shape[-1])
        if samples <= 0:
            raise RuntimeError("the engine produced no audio")

        pcm = (np.clip(audio.numpy(), -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
        sample_rate = engine.sample_rate
        wav = _encode_wav(pcm, sample_rate)
        synthesis_ms = int((time.perf_counter() - started) * 1000)
        rss_mb, peak_mb = _memory_mb()

        _emit(
            {
                "id": request_id,
                "ok": True,
                "voiceMode": VOICE_MODE_STANDARD,
                "language": language,
                "voice": engine.voice,
                "model": engine.model_id,
                "sampleRate": sample_rate,
                "durationSeconds": samples / sample_rate,
                "truncated": truncated,
                "firstChunkMs": int((first_chunk_at or 0.0) * 1000),
                "synthesisMs": synthesis_ms,
                "modelLoadMs": int(engine.load_seconds * 1000),
                "rssMb": round(rss_mb, 1),
                "peakRssMb": round(peak_mb, 1),
                "wavB64": base64.b64encode(wav).decode("ascii"),
            }
        )
    except Exception as error:  # noqa: BLE001 - report, keep serving, never crash
        logger.exception("synthesis failed")
        _fail(request_id, "synthesis-failed", f"Synthesis failed ({type(error).__name__}).")


def _apply_thread_settings() -> int:
    """Applies the operator's thread preference and returns the value in force.

    `pocket_tts` pins torch to one thread. On this machine (4 logical CPUs) that
    measured 3.37s for 2.88s of speech, and allowing four threads measured 2.94s
    for 2.72s plus a noticeably quicker model load, so the default here is one
    thread per logical CPU up to four. SPEECH_TTS_TORCH_THREADS overrides it.
    """
    import torch

    requested = (os.environ.get("SPEECH_TTS_TORCH_THREADS") or "").strip()
    threads = int(requested) if requested.isdigit() else min(4, os.cpu_count() or 1)
    if threads > 0:
        torch.set_num_threads(threads)
    return int(torch.get_num_threads())


def _status(request_id: str | None) -> None:
    rss_mb, peak_mb = _memory_mb()
    _emit(
        {
            "id": request_id,
            "ok": True,
            "languages": list(SUPPORTED_LANGUAGES),
            "voices": dict(LANGUAGE_VOICES),
            "voiceModes": {"standard": True, "clone": False},
            "resident": _POOL.residents(),
            "maxResident": MAX_RESIDENT_LANGUAGES,
            "offline": os.environ.get("HF_HUB_OFFLINE") == "1",
            "firstLoadMs": _POOL.first_load_ms,
            "rssMb": round(rss_mb, 1),
            "peakRssMb": round(peak_mb, 1),
        }
    )


def _handle_line(line: str) -> bool:
    """Handles one protocol line. False means the process should stop."""
    line = line.strip()
    if not line:
        return True

    try:
        payload = json.loads(line)
    except json.JSONDecodeError:
        _fail(None, "bad-request", "Request was not valid JSON.")
        return True

    if not isinstance(payload, dict):
        _fail(None, "bad-request", "Request must be a JSON object.")
        return True

    command = str(payload.get("cmd", "synth")).strip().lower()
    request_id = str(payload.get("id", "")) or None

    if command == "shutdown":
        return False
    if command == "ping":
        _emit({"id": request_id, "ok": True, "ready": True})
        return True
    if command == "status":
        _status(request_id)
        return True
    if command == "synth":
        synthesize(request_id or "unknown", payload)
        return True

    _fail(request_id, "bad-request", f"Unsupported command {command!r}.")
    return True


def main() -> int:
    _configure_stdout()
    # Third-party logs are held at WARNING: the Pocket TTS library logs the model
    # directory at INFO level, and this process's stderr is forwarded into the
    # server log, which must not carry filesystem paths (the security check
    # asserts that). Our own diagnostics stay at INFO.
    logging.basicConfig(
        level=logging.WARNING,
        stream=sys.stderr,
        format="[tts] %(levelname)s %(message)s",
    )
    logger.setLevel((os.environ.get("SPEECH_TTS_LOG_LEVEL") or "INFO").upper())
    _silence_third_party_logs()

    # Announced before any model work so Express can distinguish "worker alive"
    # from "worker busy loading a model".
    _emit(
        {
            "event": "ready",
            "protocol": 1,
            "languages": list(SUPPORTED_LANGUAGES),
            "voices": dict(LANGUAGE_VOICES),
            "offline": os.environ.get("HF_HUB_OFFLINE") == "1",
        }
    )

    try:
        _apply_thread_settings()
    except Exception:  # noqa: BLE001 - an unusable torch is reported per request
        logger.exception("could not apply thread settings")

    try:
        for line in sys.stdin:
            if not _handle_line(line):
                break
    except KeyboardInterrupt:  # pragma: no cover - operator interrupt only
        pass
    finally:
        logger.info("sidecar stopping")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
