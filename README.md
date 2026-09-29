# Language Doctor / DualBridge

Local-first bilingual communication bridge for **clinics**, **hotels** and **offices**.

English ⇄ { Swahili, French, Luganda, Kinyarwanda, Somali, Luo, Kikuyu, Kalenjin } with live
translation, speech input, spoken output and automatic profile extraction — every AI task
runs on a model on your own machine.

## Language capability states

Languages are only advertised as demo-ready when a dedicated local translation
model for **both** directions is verified, cached and benchmarked. The current
state is served by `GET /api/capabilities` and shown as a badge in the UI:

| Language                                            | State                                                 | Served by                                     |
| --------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------- |
| English                                             | CORE (pivot language)                                 | dedicated local MT                            |
| **French**                                          | **DEMO READY**                                        | dedicated local MT (opus-mt ONNX, Apache-2.0) |
| Swahili                                             | EXPERIMENTAL — chat-model fallback, **not validated** | Qwen3 1.7B                                    |
| Luganda, Kinyarwanda, Somali, Luo, Kikuyu, Kalenjin | EXPERIMENTAL                                          | Qwen3 1.7B                                    |

Swahili is deliberately _not_ marked demo-ready: no permissive dedicated
EN↔SW model exists (see `benchmarks/translation/README.md` for the measurements),
and the chat-model fallback is labelled unvalidated everywhere it is used —
in the UI, in the response headers and in the server log. Summarisation and
profile extraction always run on the local chat model and are unaffected.

## Architecture

```text
React 19 + TypeScript (browser)
        |
        v
Express API (server.ts, port 3000)
        |
        v
Ollama  ->  qwen3:1.7b   (http://127.0.0.1:11434)
```

No cloud AI provider is contacted, and no API keys are required or stored. The browser
never speaks to Ollama directly; only the Express API does.

## Prerequisites

- Node.js 20+
- [Ollama](https://ollama.com) installed and running

## Run locally

1. Start the local engine and pull the model:
   `ollama serve`
   `ollama pull qwen3:1.7b`
2. Install dependencies:
   `npm install`
3. Optional: copy `.env.example` to `.env` to change the engine URL, model or port.
4. Run the app:
   `npm run dev`
5. Open [http://localhost:3000](http://localhost:3000)

With a certificate in `certs/`, the same command serves **HTTPS only**:
`https://localhost:3000` plus one `https://<lan-ip>:3000` URL per LAN address -
which is what a phone needs for voice input, since a browser only hands a page the
microphone in a secure context. See [Phone voice input](#phone-voice-input-lan-https).

## Check the local engine

`GET /api/health` reports whether Ollama is reachable and whether the configured model is
installed. It returns `200` when healthy and `503` when degraded.

```powershell
curl.exe http://127.0.0.1:3000/api/health
```

```json
{
  "status": "ok",
  "engine": "ollama",
  "cloudProviders": "none",
  "ollama": {
    "baseUrl": "http://127.0.0.1:11434",
    "model": "qwen3:1.7b",
    "reachable": true,
    "modelInstalled": true,
    "installedModels": ["qwen3:1.7b"],
    "latencyMs": 12,
    "error": null,
    "hint": null
  }
}
```

## API

| Method | Path                     | Request body                          | Response                          |
| ------ | ------------------------ | ------------------------------------- | --------------------------------- |
| GET    | `/api/health`            | –                                     | engine + session status           |
| GET    | `/api/capabilities`      | –                                     | language capability states        |
| POST   | `/api/translate`         | `{ text, from, to, context, domain }` | `{ translatedText }`              |
| POST   | `/api/summarize`         | `{ profile, conversation, domain }`   | `{ summary }`                     |
| POST   | `/api/parse-dialogue`    | `{ conversation, domain }`            | domain profile JSON               |
| POST   | `/api/sessions`          | `{ domain, localLanguage }`           | `{ sessionId, token, expiresAt }` |
| GET    | `/api/sessions/:id`      | token in `x-session-token` header     | session state (never the token)   |
| DELETE | `/api/sessions/:id`      | token in header or `{ token }` body   | `{ success, sessionId }`          |
| POST   | `/api/transcribe`        | raw PCM or WAV body, `language`       | `{ text, provider, model }`       |
| POST   | `/api/speech/synthesize` | `{ text, language, voiceMode }`       | 16-bit PCM WAV                    |

`domain` is one of `clinic` (default), `hotel` or `office`.

`/api/transcribe` sends the audio to this machine's Whisper engine and stores
nothing. A request from another device must name the session its audio belongs to
(`x-session-id` + `x-session-token`, or `Authorization: Bearer`); a request from
this machine's own loopback interface needs no token, exactly as since Phase 7A.

`/api/parse-dialogue` returns the profile that belongs to that domain — a
`PatientProfile`, `GuestProfile` or `OfficeProfile` (see `src/types.ts`). Hotel
and office information is never stored in medical properties, and the client
merge in `src/profile.ts` never lets an empty extraction erase a confirmed value.

Structured intake is optional and domain-specific (Phase 7D). The welcome
screen's "Voice First Chat" and "Shared Device" still start the conversation
with no form at all, and the AI fills the profile as it goes. Choosing
"Structured Intake" opens the wizard for the active domain: the original clinic
wizard (`IntakeForm.tsx`, unchanged), plus a hotel and an office one, all sharing
its styling (`components/intake/IntakeShell.tsx`). Each wizard can only build its
own profile — the field names it may set are typed from the same discriminated
union, so putting a hotel detail in a medical field is a compile error, not a
runtime surprise. Switching domain drops the previous profile, and manual intake
and AI extraction share one merge (`mergeDomainProfile`), so a field the operator
typed is never overwritten by a later extraction.

### Private two-device sessions (memory only)

Sessions exist so a private two-device session can be added later. They live in
RAM only: no database, nothing written to disk, no audio or transcripts saved.
The visible id (`LD-K7P4X2`) is short enough to dictate by hand and never encodes
personal information; the security token is a separate 32-byte secret sent in
the `x-session-token` header (or `Authorization: Bearer`) for API requests.
`SESSION_TTL_MINUTES` (default 30) is the sliding lifetime, capped by
`SESSION_ABSOLUTE_TTL_MINUTES`; expiry and deletion drop the messages and profile
from memory, and logs contain ids and counts only.

Join links use the SPA path `/join/<id>` (the legacy `?join=<id>` form still works). By default the server auto-detects this machine's LAN IPv4 addresses and offers each as a QR candidate on the host screen; set `HOST_URL` to override the primary candidate (for example
`http://192.168.1.71:3000`). The host QR code contains the session id in the
query and its pairing credential in the URL fragment. Browsers never send URL
fragments in HTTP requests; the participant consumes and removes it from its
address bar before authenticating its Socket.IO connection. The token is never
persisted in local storage, cookies, or server logs.

## Phone voice input (LAN HTTPS)

A phone that joined a session can speak instead of typing. The audio goes to the
same local Whisper engine, the transcript lands in the phone's text box (never sent
automatically, so it can be corrected first), and typed messages take the identical
send path. No cloud speech service is involved, and no tunnel.

A browser only hands a page the microphone in a secure context, so when a
certificate is present the LAN address is served over HTTPS with a certificate this
laptop signs for itself:

```powershell
winget install FiloSottile.mkcert
npm run cert:lan
```

That writes `certs/` (git-ignored), which the server picks up on its own. A phone
must be given `certs/rootCA.pem` once - it is a public certificate, never the key -
and then trusts the pages this laptop serves.

Two things about a joined session on the phone are worth knowing before a clinic uses
it. The back button asks before it leaves: **End session** closes the session for both
devices, **Not now** disconnects this phone and leaves the session alive so the same
link can be reopened. And the participant role belongs to the first device that joins

- another phone holding the same link is refused, however the first one disappeared.

Step-by-step setup, the audio rules a
phone is held to, and exactly what has and has not been verified are in
[docs/phone-voice-demo.md](docs/phone-voice-demo.md).

## Configuration

| Variable                   | Default                  | Meaning                                                                        |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `OLLAMA_BASE_URL`          | `http://127.0.0.1:11434` | Local inference runtime                                                        |
| `OLLAMA_MODEL`             | `qwen3:1.7b`             | Model for every AI task                                                        |
| `OLLAMA_TIMEOUT_MS`        | `120000`                 | Per-request generation timeout                                                 |
| `OLLAMA_HEALTH_TIMEOUT_MS` | `5000`                   | Timeout for the health probe                                                   |
| `PORT`                     | `3000`                   | Express + Vite port                                                            |
| `HOST_URL`                 | unset                    | Optional join-link origin override (else auto-detected LAN IPs)                |
| `NODE_ENV`                 | –                        | `production` serves the built `dist/`                                          |
| `HTTPS_ENABLED`            | auto                     | `false`/`0`/`off` forces plain HTTP; `true` warns when no certificate is found |
| `TLS_CERT_PATH`            | `certs/cert.pem`         | Leaf certificate (`npm run cert:lan`)                                          |
| `TLS_KEY_PATH`             | `certs/key.pem`          | Private key for that certificate                                               |

## Scripts

| Script                  | Action                                       |
| ----------------------- | -------------------------------------------- |
| `npm run dev`           | Runs `server.ts` (Express + Vite middleware) |
| `npm run build`         | Builds the frontend into `dist/`             |
| `npm run preview`       | Serves the production build                  |
| `npm run lint`          | TypeScript check (`tsc --noEmit`)            |
| `npm run test`          | Full suite against a real server process     |
| `npm run test:contract` | HTTP contract + source/bundle scans          |
| `npm run test:models`   | Ollama, Whisper, TTS and translation         |
| `npm run cert:lan`      | mkcert certificate for the LAN phone demo    |

## Project layout

```text
server.ts                              Express API + Vite middleware
src/server/services/ollama.ts          Local engine transport, config, health probe, askModel()
src/server/services/languageEngine.ts  Local AI tasks, domain prompts, JSON validation
src/components/*                       UI (welcome, intake, conversation, summary)
src/services/api.ts                    Browser client for the Express API
src/services/audioCapture.ts           Raw-PCM push-to-talk recorder (host and phone)
docs/phone-voice-demo.md               One-time phone setup, audio rules, verification status
tests/contract/participant-voice.test.ts  LAN voice guard, phone socket path, HTTPS handshake
```
