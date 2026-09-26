# Phase 1.5 / 1.6 — Local Translation Quality Gate

Translation is mission-critical, so it is benchmarked against reproducible
fixtures before any provider is trusted in the product. Everything here runs
**locally**: no cloud AI service is contacted, and the only network access is the
one-time download of model weights from Hugging Face (equivalent to
`ollama pull`), after which inference is offline.

## Architecture

```
Express
├── Translation Engine  -> TranslationProvider (dedicated local MT preferred)
│                          local-mt-hf : opus-mt ONNX, in-process (transformers.js)
│                          local-mt    : dedicated-MT HTTP sidecar (optional)
│                          ollama      : chat-model fallback (unvalidated)
└── Intelligence Engine -> Ollama / Qwen3 1.7B (summarize, parse-dialogue)
```

The browser still only sees `POST /api/translate`. The server reports which
engine answered through `X-Translation-Provider` / `X-Translation-Validated`
response headers, the server log and `GET /api/health`.

## Language capability states

`GET /api/capabilities` is the single source of truth, produced by
`src/server/services/translation/languagePairs.ts`:

| Language | Role | State | Served by |
|---|---|---|---|
| English | pivot (CORE) | supported | `local-mt-hf` |
| French | demo | **supported (DEMO READY)** | `local-mt-hf` (opus-mt ONNX) |
| Swahili | demo | **experimental** | `ollama` chat fallback — **not validated** |
| Luganda | experimental | experimental | chat fallback only |
| Kinyarwanda | experimental | experimental | chat fallback only |
| Somali | experimental | experimental | chat fallback only |
| Luo | experimental | experimental | chat fallback only |
| Kikuyu | experimental | experimental | chat fallback only |
| Kalenjin | experimental | experimental | chat fallback only |

A language is only labelled DEMO READY when **both** directions have a cached,
verified dedicated model. Swahili is shown as experimental precisely because no
permissive dedicated model could be validated (see below) — the chat-model
fallback must never be presented as a validated translation.

## Fixtures

`fixtures.en-sw.ts`, `fixtures.sw-en.ts`, `fixtures.en-fr.ts`, `fixtures.fr-en.ts`
(14 cases each, 13 categories: greetings, conversation, numbers, dates, names,
clinic dialogue, symptoms, medication names, hotel dialogue, office dialogue,
questions, negation, short instructions) plus `fixtures.fr-sw.ts` for the
English-pivoted path. The EN↔FR sets mirror the EN↔SW sets case-for-case, so
results are directly comparable.

Reference translations are short human-written aids for human review. They are
**not** official gold standards, are not scored automatically, and automated
flags are explicitly not a claim of medical translation accuracy.

Per-case flags: `empty`, `repetition`, `source-copy` (echoed the source) and
`preserve` misses (names, numbers, dosages that must survive verbatim).

## Candidates and licences

| Candidate | Runtime | Licence | Status |
|---|---|---|---|
| `Helsinki-NLP/opus-mt-en-fr` (ONNX: `Xenova/opus-mt-en-fr`) | transformers.js + ONNX Runtime, in-process | **Apache-2.0** (verified via HF API) | ✅ **selected for EN→FR** |
| `Helsinki-NLP/opus-mt-fr-en` (ONNX: `Xenova/opus-mt-fr-en`) | same | **Apache-2.0** (verified) | ✅ **selected for FR→EN** |
| `Helsinki-NLP/opus-mt-en-mul` (ONNX: `Xenova/opus-mt-en-mul`) | same | Apache-2.0 (upstream) | ❌ measured broken for African targets |
| `Helsinki-NLP/opus-mt-mul-en` (ONNX: `Xenova/opus-mt-mul-en`) | same | Apache-2.0 (upstream) | ❌ measured broken/hallucinating |
| `opus-mt-en-sw` / `opus-mt-sw-en` | — | — | ❌ do not exist (HF API returns 401) |
| NLLB-200 distilled (covers Swahili, Luganda, Kikuyu…) | — | **CC-BY-NC-4.0 (non-commercial)** | ❌ excluded on licence grounds |
| gemma3:4b | Ollama chat | Gemma Terms of Use | ⚠️ download too slow (~270 KB/s, ~3 h); not benchmarked |
| qwen3:1.7b | Ollama chat | Apache-2.0 | ⚠️ baseline only — fails human review for Swahili |
| `@huggingface/transformers` | npm runtime | Apache-2.0 | ✅ optional dependency |
| `onnxruntime-node` | npm runtime | MIT | ✅ optional dependency |

## Results measured on this machine (CPU-only inference)

Evidence: `results/<timestamp>/report.md` + `raw.json`. Real model calls, not
estimates.

| Candidate | Direction | Auto-flags clean | Mean latency | Human review |
|---|---|---|---|---|
| **local-mt-hf** (opus-mt ONNX) | EN→FR | **14/14** | **540 ms** | **✅ good** |
| **local-mt-hf** (opus-mt ONNX) | FR→EN | **14/14** | **504 ms** | **✅ good** |
| qwen3:1.7b | EN→SW | 11/14 | 3.8 s | ❌ invented Swahili |
| qwen3:1.7b | SW→EN | 10/13 | 2.6 s | ❌ dangerously wrong |
| Qwen3.5-4b (community finetune) | EN→SW | 11/14 | 15.5 s | ⚠️ better, still unfaithful; licence/safety unsuitable |

### Human review of the EN↔FR outputs (excerpts)

| Source | Output | Verdict |
|---|---|---|
| "Your appointment is on 12 March 2026." | "Votre rendez-vous est le 12 mars 2026." | ✅ date preserved |
| "Take one tablet of paracetamol 500 mg twice a day after meals." | "Prenez un comprimé de paracétamol 500 mg deux fois par jour après les repas." | ✅ drug + dose preserved |
| "Open your mouth and breathe in deeply." | "Ouvrez la bouche et respirez profondément." | ✅ |
| "The meeting is on Monday, please send me the report before then." | "La séance est lundi, veuillez me faire parvenir le rapport avant." | ✅ (minor: "séance" vs "réunion") |
| "Prenez un comprimé de paracétamol 500 mg deux fois par jour après les repas." | "Take one tablet of paracetamol 500 mg twice daily after meals." | ✅ |
| "La réunion est lundi, veuillez m'envoyer le rapport avant." | "The meeting is Monday, please send me the report before." | ✅ |
| "The bill is 15,000 shillings for three days." | "Le projet de loi est de 15 000 shillings…" | ⚠️ "bill" → "projet de loi" (legislation), one wrong sense |

**Automated flags are not an accuracy measure.** qwen3:1.7b scored 11/14 and
10/13 while producing meaningless or dangerous text — only reading the outputs
exposes that. Any clinical use requires human review by a speaker of the target
language.

### Why there is no dedicated Swahili entry

1. **No per-pair model exists.** `opus-mt-en-sw` / `opus-mt-sw-en` are not
   published (the HF API returns 401 for both), so Swahili would depend on the
   multilingual `*-mul` models.
2. **The multilingual ONNX ports are broken for these languages.** With the
   model card's own target token (`>>swh<<`, not `>>swa<<` — `swa` is invalid and
   produces garbage) `en-mul` still echoed the token and emitted pseudo-English:

   ```
   in : >>swh<< Good morning, doctor. The patient has had a fever for three days.
   out: >>swh< < < Gomormordin, doktor. A pacient have febert febert 3 days.
   ```

   `mul-en` hallucinated a completely unrelated sentence for a Swahili input
   ("Mtoto ana homa na kikohozi kwa siku tatu." → *"A dream was about to begin —
   and it proved to be a mere dream."*). The same runtime produced correct French
   on the first attempt, so the fault is the port, not the pipeline.
3. **The model that would cover Swahili (NLLB-200) is non-commercial.** Its
   licence is CC-BY-NC-4.0, so it cannot be shipped in a commercial MVP.

Consequently the Swahili directions were deliberately **not** registered as
dedicated MT: it is served by the chat model and clearly reported as
`X-Translation-Validated: false`, with a UI badge and a development notice.

## Running

```powershell
npm run bench:translate -- --provider hf --directions en-fr,fr-en
npm run bench:translate -- --provider ollama --models "qwen3:1.7b" --directions en-sw,sw-en
npm run bench:translate -- --provider local-mt        # only with a sidecar running
```

The dedicated-MT candidate is measured **through the real production provider**,
so it uses the same model map, the same target tokens, the same sentence
segmentation and the same English-pivot logic as the app.

## Enabling a dedicated model for another language

Only models whose licence was verified may be added, and only after measuring
them. To add a direction:

1. Confirm the upstream model's licence via the HF API and record it in
   `LOCAL_MT_MODELS`.
2. Confirm an ONNX port exists (`onnx/encoder_model*.onnx` in the repo's file
   listing) — transformers.js needs ONNX weights.
3. Add the entry, then run the benchmark with `--provider hf`.
4. Only if it passes and a human review accepts the output does it become
   DEMO READY in `/api/capabilities` (readiness is derived from the local cache,
   so nothing is claimed before the weights exist).

## Notes and gotchas

- **Test harness encoding:** on Windows PowerShell, `Set-Content` writes ANSI, so
  accented test payloads reach the server corrupted and appear to produce
  garbled translations (it looked like a model defect: "…→ tabol 500 mg parac
  tablet"). Write request bodies as UTF-8, e.g.
  `[System.IO.File]::WriteAllText($path, $json, (New-Object System.Text.UTF8Encoding($false)))`.
  The fixtures are UTF-8 source files, so benchmark results are unaffected.
- **Sentence segmentation matters.** OPUS-MT is trained on single sentences and
  degrades on multi-sentence input, so `HfLocalMtProvider` splits input into
  sentences, translates each and rejoins (`splitIntoSentences`). Measured before
  the fix: a two-sentence French input produced "tabol 500 mg parac tablet".
- **First request per model is slow** (pipeline load, 2-4 s warm; the very first
  ever use also downloads weights). Subsequent requests are ~0.5 s.
- **Pivoting is implemented but currently unusable for Swahili**, because the
  Swahili leg has no dedicated model; `fr-sw` is measured only if both legs
  exist. Two-stage paths are labelled `pivoted` and carry a compounding-error
  note.
- **`npm install-scripts approve onnxruntime-node`** is required on npm ≥12 for
  the native ONNX binary to install; otherwise `local-mt-hf` reports
  not-ready and translation falls back (never crashes).
- Latency depends on this machine (CPU inference); treat numbers as relative.

## Caveats

- Latency depends on the local machine (CPU-only inference here); treat numbers
  as relative comparisons on this host.
- Clean-rate improvements must be confirmed by reading `report.md` outputs — a
  translation can pass all automated flags and still be medically wrong.
- Passing this gate is not a medical-accuracy claim; the clinic domain still
  requires clinician review of any translated patient communication.

