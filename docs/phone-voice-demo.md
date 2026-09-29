# Phone voice input over the LAN (Phase 7C)

A phone that joined a private session can speak instead of typing. This page is the
one-time setup and the honest account of what has - and has not - been verified.

## Why a certificate is involved

Browsers hand a page the microphone (`getUserMedia`) only in a _secure context_.
`http://localhost` counts; `http://192.168.1.71` does not. So the moment the
microphone matters, the LAN address has to be served over HTTPS, and a `https://`
certificate for a bare IP address has to be one the phone chooses to trust.

Three ways people usually "solve" this are deliberately **not** used here:

| Shortcut                                                     | Why it is refused                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| A cloud STT service (`api.openai.com`, a browser recogniser) | The audio would leave the clinic. `tests/contract/local-first.test.ts` scans the source **and the built bundle** for it. |
| A tunnel (`ngrok`, `cloudflared`)                            | It puts a route to the session on the public internet and needs no LAN at all.                                           |
| Ignoring the warning / `--ignore-certificate-errors`         | It teaches everyone in the room to click past certificate warnings, on a device that then handles patient speech.        |

What is used instead: **mkcert** - a local certificate authority, created and
installed on this laptop only, that signs a certificate naming `localhost`, the
loopback addresses and every current LAN address. Nothing leaves the machine.

## What runs where

```text
phone  ──https + session token──▶  this laptop: /api/transcribe  ──▶  local Whisper
   │                                                                        │
   └──socket.io (text)──▶  same Express + Socket.IO listener  ◀── transcript ┘
```

- One listener. With `certs/` present the server is HTTPS **only**: Socket.IO's
  engine attaches to a single server, so running HTTP beside HTTPS would split a
  session in two - a host on `http://localhost` and a phone on `https://<lan-ip>`
  would never share a room.
- One recorder. The phone uses the same `LocalAudioRecorder`
  (`src/services/audioCapture.ts`) and the same raw-PCM endpoint the host laptop
  has used since Phase 7A. `MediaRecorder` is not used, because a webm/mp4 clip
  would need a second decode path before Whisper could read it.
- One engine. `POST /api/transcribe` still ends at the local Whisper provider. The
  transcript comes back to the phone's text box; the phone sends it with the same
  send path as typed text.

## One-time setup on the laptop

```powershell
winget install FiloSottile.mkcert     # Windows (brew install mkcert elsewhere)
npm run cert:lan                      # creates certs/, valid for this laptop's addresses
```

`npm run cert:lan` prints what it signed and where the CA file went:

```text
certificate : certs\cert.pem + certs\key.pem
valid for   : localhost, 127.0.0.1, ::1, 173.15.123.116, 192.168.5.1, 192.168.137.1
CA file     : certs\rootCA.pem  <- the one file a phone must be given
```

`certs/` is git-ignored: the key never leaves this machine and the folder is never
committed. Re-run `npm run cert:lan` whenever the laptop gets a new address - the
certificate lists addresses literally, so a new DHCP lease shows up on the phone as
a warning instead of a working page.

## One-time setup on the phone

Copy `certs/rootCA.pem` to the phone (AirDrop, email to yourself, or a USB cable -
it is a public certificate, never the key) and install it as a trusted CA:

### iPhone / iPad

1. Open the file → _Profile Downloaded_ appears → **Settings → General → VPN &
   Device Management → mkcert → Install**.
2. **Settings → General → About → Certificate Trust Settings** → switch on full
   trust for _mkcert_.
   Step 2 is the one people miss; without it Safari still refuses the page.

### Android

1. **Settings → Security & privacy → More security settings → Encryption &
   credentials → Install a certificate → CA certificate** → pick `rootCA.pem`.
2. Chrome on Android trusts user-installed CAs; some apps (those targeting
   Android 7+) do not, which is fine here - the participant page runs in the
   browser.

Then add the phone to the Wi-Fi network the laptop is on.

## Run it

```powershell
npm run dev
```

The startup log says which scheme and which origins are live:

```text
Language Doctor running on https://localhost:3457
LAN HTTPS: on (cert.pem + key.pem) - a phone must have the mkcert root CA installed (one time, see docs/phone-voice-demo.md)
  phone can join at: https://173.15.123.116:3457
```

On the laptop: open the **host** screen, start a private session, and show the QR
code. The phone scans it, lands on `/join/<id>`, and the microphone button appears
next to the text box.

Tap once to start speaking, tap again to stop: the clip is posted to this laptop,
transcribed locally, and the transcript lands **in the text box** - not sent
automatically. A mis-heard word can be corrected before a clinician reads it, and
the phone uses exactly one send path whether the words were spoken or typed.

## Check the certificate from the laptop

Before involving a phone, confirm the listener answers on the LAN address with the
certificate the phone will be asked to trust:

```powershell
curl.exe --ssl-no-revoke --cacert certs\rootCA.pem -o nul -w "status=%{http_code}`n" https://192.168.1.71:3000/api/health
```

```text
status=200
```

Two failure messages look alarming and are not:

- **`curl: (60) schannel: the revocation status is unknown`** - Windows' bundled
  `curl` checks revocation through the OS, which cannot answer for a CA that was
  issued on this laptop an hour ago. `--ssl-no-revoke` says so explicitly. Do not
  "fix" this with `-k` (or any insecure flag): that would skip the check the whole
  exercise exists to pass, and browsers are not affected - they trust the CA because
  it is installed, and do not consult a revocation list for a user-installed root.
- **`npm notice run ...` lines** - npm prints its banner on stderr, which
  PowerShell shows in red as `NativeCommandError` even though the command
  succeeded. The exit code of the task itself is what matters.

When `curl` is not available, the same check is what
`tests/contract/participant-voice.test.ts` performs with Node's TLS client and
mkcert's CA pinned as the only anchor.

## If the microphone button is grey, or stuck on "waiting"

Tap **Voice diagnostics** under the microphone button on the phone. It reports what
that device says about itself, and the phone is the only machine that can answer why
its own microphone button will not light up:

| Field                          | What it should say                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phase`                        | `ready` - the button is usable. `starting` for longer than a moment means a start that did not settle                                                                                     |
| `secure-context`               | `yes`. `no` means the page was opened over plain `http://` instead of the `https://` join link                                                                                            |
| `mediaDevices`, `getUserMedia` | `yes`. `no` means this browser exposes no microphone capture at all                                                                                                                       |
| `audioContext`                 | `yes`                                                                                                                                                                                     |
| `permission`                   | **advisory only.** `unsupported` is normal on Safari, and `prompt` while the microphone is already granted is normal on some browsers. Nothing is gated on this field, which is the point |
| `blocked-by`                   | the sentence the button is greyed for, or `nothing`                                                                                                                                       |
| `last-error`                   | the last refusal in plain words, naming typing as the way through                                                                                                                         |

Two failure modes found on hardware, and what now makes them impossible:

1. **The audio context was created after the permission prompt.** Awaiting
   `getUserMedia` ends the tap's gesture, and WebKit gives back an `AudioContext`
   created outside a gesture that is born `suspended` and stays there - so the
   recorder produced nothing and the button sat on "waiting for the microphone" for a
   microphone that had _already_ been granted. The context is now created first,
   inside the tap, and its `resume()` is never awaited bare.
2. **Readiness was decided once, at mount.** Refusing the microphone, granting it in
   site settings and returning is the ordinary order on a phone, and a verdict taken
   at mount stayed stale. It is now re-answered whenever the page comes back to the
   front.

A start is also bounded now: if the microphone has not started within 30 seconds, the
button comes back with an explanation instead of waiting for the rest of the session.

## The join link belongs to one device

A temporary session has one host and one participant, and the participant role is bound
to the first device that joins it. The link still carries the session token, but the
token alone no longer decides who takes the patient side of the conversation:

| Attempt                                                                                          | Result                                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| The same browser reconnecting after wifi drops, a screen lock, or a killed tab                   | allowed - it is the same device, and its stale socket is replaced  |
| The same browser rejoining after choosing **Not now**                                            | allowed, and the transcript resumes                                |
| A different browser, a different phone, or a private tab, while the original still owns the role | refused with _"This session already has a connected participant."_ |
| Any device that presents no device identifier                                                    | refused the same way                                               |
| Any device, after the session was ended (by either side) or expired                              | refused as an ended/expired session                                |

The binding is claimed on the first join and is **not** released by a disconnection,
however that disconnection looks: a phone that was switched off, crashed, or was killed
in the background keeps the role reserved until the session itself ends. Only three
things release it, and all three delete the session: the participant choosing **End
session**, the host ending it, and expiry.

### The honest limitation

The device is recognised by a random value this browser stores locally, so:

- **clearing site data / browser storage**, using a **private or incognito tab** (even on
  the same physical phone), or using a **different browser** makes a device
  unrecognisable. It is then treated as a different device and refused, and the server
  has no way to know better - which is the correct trade for a link that can be
  photographed.
- if storage is unavailable (blocked site data, some private modes), the identifier
  lives only for that page, so a reload then looks like a different device.
- the identifier is not a secret and carries no personal data. It leaves the device only
  in the participant's socket handshake, and it disappears with the session.

The token still protects the session; the device identifier only decides which device
may take the participant side of it.

## The back button

Pressing the phone's back button inside a joined session does not leave the session
silently. It asks - with exactly two answers:

- **End session** - ends it for both devices. This is the same request the host's own
  End Session button makes: the transcript and profile are dropped from the server,
  `session:ended` is broadcast to the room, and both devices show the ended state.
- **Not now** - this device disconnects cleanly, the host is told the participant
  disconnected, and the session stays alive until its normal expiry. Nothing is purged,
  so the same device can open the link again and carry on.

There is no third path: the history entry is put back before the question appears, so
back cannot slide past the session view while the session quietly continues.

## What the phone can and cannot do with audio

| Caller                                                                    | `POST /api/transcribe`                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| This laptop (loopback)                                                    | accepted, no session needed - unchanged since Phase 7A                                   |
| Any other device with `x-session-id` + `x-session-token` for that session | accepted                                                                                 |
| Any other device without both                                             | refused with `401 token-required`, **before a single byte of audio is read into memory** |
| A device presenting a token that belongs to a different session           | refused with `403 invalid-token`                                                         |

The refusal is written to be shown verbatim on the phone:

> Voice input from another device must be paired with a session. Please reopen the
> session from the QR code - typing still works and is translated the same way.

## Verified, and not yet verified

Checked on this machine, by `tests/contract/participant-voice.test.ts` and by hand:

- a TLS handshake against `https://127.0.0.1:<port>` **and** the real LAN address,
  with mkcert's CA pinned as the only anchor, and the leaf's subject alternative
  names asserted to include `localhost`, `127.0.0.1` and every current LAN IPv4;
- `joinUrls` handed to the host start with `https://` when the certificate is
  present, so the QR code opens a secure context;
- unpaired and wrongly-paired LAN recordings are refused with `401`/`403` before
  the body parser runs, over both schemes;
- loopback voice input is still accepted without a token;
- a phone-shaped Socket.IO client at the LAN address joins the session room, is
  refused when the pairing is wrong, and carries a typed message to the host and
  back translated;
- `npm run dev` starts HTTPS, logs the LAN URLs, and answers `/api/health` with
  `200` on the LAN interface;
- by `tests/contract/session-binding.test.ts`, against a running server: the same
  device reconnects and still replaces its own stale socket (case A), rejoins after
  a clean leave with the session still alive (case B), and a different device - or one
  naming no device at all - is refused with _"This session already has a connected
  participant."_ whether the owner is connected or gone for an unknown reason, without
  the owner being evicted and without the session being touched (case C);
- that ending the session from the phone is the same request the host makes: the
  transcript and profile are dropped, `session:ended` reaches **both** devices, and the
  binding goes with the session rather than with the socket.

**Not verified without a phone:** that a real iOS/Android browser reports
`window.isSecureContext === true` for `https://<lan-ip>` after the CA is installed,
that the OS microphone permission prompt behaves as expected, that the phone's
**back gesture** (Android's, and iOS Safari's edge swipe) is intercepted by the
history entry rather than walking out of the session, and that a real **second
device** is refused the participant role. All four are a few minutes on two handsets.
If any of them fails, the page says so in plain words rather than pretending:

> Voice input needs a secure connection (HTTPS or localhost). Please type the
> message - it is translated the same way.

## Troubleshooting

| Symptom                                                         | Cause and fix                                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Voice input needs a secure connection"                         | The page is on `http://<lan-ip>`, or the CA is not trusted yet. Re-check `certs/` and step 2 of the iOS instructions.                                         |
| "Voice input from another device must be paired with a session" | The QR fragment was lost (a re-typed or forwarded URL). Re-scan the QR code; typing keeps working meanwhile.                                                  |
| Browser warning about the certificate                           | The laptop's address changed since `npm run cert:lan`. Re-run it and re-open the page.                                                                        |
| Startup log still says `http://localhost`                       | `certs/` is missing or unreadable. Run `npm run cert:lan`; `HTTPS_ENABLED=false` forces plain HTTP if a machine cannot use TLS.                               |
| Microphone button stuck spinning                                | It cannot wait forever: the start is bounded at 30 seconds and then says so. The **Voice diagnostics** panel above names which check is false on that device. |
| "The microphone did not start"                                  | The browser never settled the permission request. Answer it and tap again, or type the message - it is translated the same way.                               |
| "This session already has a connected participant"              | Another device owns the participant role of this session. Re-open the link on the phone that joined first.                                                    |

## Configuration

| Variable        | Default          | Meaning                                                                      |
| --------------- | ---------------- | ---------------------------------------------------------------------------- |
| `HTTPS_ENABLED` | auto             | `false`/`0`/`off` forces plain HTTP; `true` warns if no certificate is found |
| `TLS_CERT_PATH` | `certs/cert.pem` | Leaf certificate (mkcert output)                                             |
| `TLS_KEY_PATH`  | `certs/key.pem`  | Private key for that certificate                                             |

## What this deliberately is not

No cloud speech service, no tunnel, no insecure-origin flag, no click-through of
certificate warnings, and no second audio pipeline. The phone is a microphone for
this laptop and nothing more; the audio is decoded, transcribed and dropped.
