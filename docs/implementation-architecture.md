# Implementation architecture

This document describes the code that is present in this repository. The
research and prototype documents under `docs/research` and `docs/prototypes`
remain useful design inputs, but they are not implementation or acceptance
evidence.

## Deployed POC topology

The current POC is one central Harness on one operator PC, with two independent
phone-browser participants on the same LAN:

```text
                             operator HTTPS UI/API/events
                                      |
                                      v
+----------------+   HTTPS/WSS   +-----------------------------+   server only
| Phone A browser| <-----------> | Central Harness on one PC   | <------------> selected provider
| mic + headphones|              | session, routing, modes,    |       OpenAI or Palabra
+----------------+               | glossary, fence, evidence   |
                                 +-----------------------------+
+----------------+   HTTPS/WSS              ^
| Phone B browser| <-------------------------+
| mic + headphones|
+----------------+
```

This is not a carrier call. A phone is an ordinary browser endpoint. There is no
PSTN/SIP number, inbound ring, IVR, AI greeting, live DTMF control, or
automated language question in the current implementation. The test-telephony
driver can inject DTMF only as a normalized fixture alert; it never dials,
answers, or synthesizes conversational audio.

`createMediaRuntime` is the composition seam. `MEDIA_PROFILE=browser_pair`
builds the browser WebSocket port and signed QR grants.
`MEDIA_PROFILE=fake_telephony` instead builds the in-process G.711 mu-law test
port, returns `fake-telephony://` grants, exposes a test driver, and omits the
browser media route. Capabilities advertise only the active media setting. The
fake fixture is executable but is not a live carrier.

The direct-start rule is enforced by the room lifecycle: the operator creates a
room, both participants connect through the selected media adapter, the Harness
becomes ready, and the operator sends the `start` command. No conversational
agent sits in front of either human.

## Central Harness responsibilities

`ModularGuardedDuplexRelay` is the deep session module. It owns:

- the A-to-B and B-to-A lanes;
- session lifecycle and idempotent operator command IDs;
- participant connection state;
- bounded source and playout queues;
- per-lane sequence and generation state;
- fixed-provider, per-session-mode routing;
- interruption cuts and stale-generation rejection;
- normalized session events; and
- non-blocking evidence writes, including active-session closure and evidence
  flush during graceful `SIGINT`/`SIGTERM` shutdown.

Fastify provides the static operator/participant UI, JSON API, event WebSocket,
and, for `browser_pair`, media WebSockets. Provider details remain behind
`TranslationPort`; browser and test-telephony details remain behind `MediaPort`.
Evidence storage remains behind `EvidencePort`. The core does not consume raw
OpenAI, future carrier, or browser protocol events.

## Audio and duplex flow

The browser capture worklet resamples microphone input to the canonical format:

| Property | Value |
|---|---|
| Encoding | signed PCM16LE |
| Sample rate | 24,000 Hz |
| Channels | 1 |
| Frame duration | 20 ms |
| Samples per frame | 480 |
| Bytes per frame | 960 |

Phone A audio enters lane `A_TO_B` and only plays to Phone B. Phone B audio
enters `B_TO_A` and only plays to Phone A. The two lanes have independent queues,
translation runs, transcript accumulators, and generation fences.

When the other participant starts speaking while translated audio is queued, the
Harness advances the affected generation, aborts the old translation run, clears
server and browser playout, and rejects any late frame from the old generation.
The browser playout worklet also drops old or duplicate sequence values and trims
excess buffering. A provider cancel call may reduce wasted work, but correctness
does not depend on its acknowledgement.

Headphones are a required operating condition, not an optional recommendation.
They keep translated output out of the local microphone and make the two logical
lanes observable without acoustic feedback.

## Four-track evidence

Every accepted source frame and every accepted translated playout frame is
recorded with one of four track labels:

| Track | Meaning |
|---|---|
| `source_a` | microphone audio accepted from Phone A |
| `source_b` | microphone audio accepted from Phone B |
| `playout_to_a` | translated audio accepted for Phone A |
| `playout_to_b` | translated audio accepted for Phone B |

Session state, participant state, transcripts, latency observations, glossary
events, alerts, generation cuts, and closure are recorded beside the audio
records. `encrypted_local` encrypts each JSONL record independently with
AES-256-GCM and uses a SHA-256 digest of the session ID as the filename.
`in_memory` retains bounded cloned records only for the current process.

The runtime boundary remains four labeled PCM frame streams inside encrypted
evidence. The separate authorized exporter authenticates every record before
writing plaintext, aligns all tracks to a common capture origin, and emits four
mono WAVs plus one interleaved four-channel WAV in the table order. It also emits
sanitized events, a hash-pinned manifest, and checksums. Export requires the
recording key plus an explicit plaintext acknowledgement. Live evidence writes
remain bounded and fail open: an evidence problem is surfaced as a health alert
without blocking media.

## Translation provider and mode contract

`TRANSLATION_PROVIDER` selects exactly one provider while the server starts:
`openai_native`, `openai_controlled`, or `palabra`. Composition validates the
selected key and the configured `TRANSLATION_MODE`, constructs only that
provider's `TranslationPort`, and publishes its static capabilities. The
provider never changes at runtime.

| Provider | Required server credential | Advertised modes | Deterministic pinned glossary |
|---|---|---|---|
| `openai_native` | `OPENAI_API_KEY` | `fast`, `balanced`; `accurate` is unsupported | none; `balanced` is marked degraded because it uses adapter-local holdback rather than a model-quality guarantee |
| `openai_controlled` | `OPENAI_API_KEY` | `fast`, `balanced`, `accurate` | all three modes advertise it |
| `palabra` | `PALABRA_API_KEY` | `fast`, `balanced`, `accurate` | none; `accurate` is marked degraded because Palabra account glossaries cannot provide this Harness's deterministic pinned guarantee |

`TRANSLATION_MODE` defaults to `balanced` and must be one of `fast`,
`balanced`, or `accurate`; it supplies the default UI selection and is validated
against the chosen provider. It does not force all sessions to use that mode.
The operator UI reads `/api/capabilities`, displays the fixed provider, and
offers only the advertised modes. Each option carries a behavior version,
full/degraded state and reason, and a `deterministicGlossary` flag. A session
request sends a mode, not a provider; the server rejects unsupported modes and
pins provider, mode, behavior version, and degradation state into the session
snapshot.

The mode behavior is defined independently of an adapter: `fast` continuously
commits input and permits provisional revisions with no holdback; `balanced`
continuously commits input, emits final-only transcript segments, and uses a
250 ms holdback; `accurate` commits at speech end, emits final-only segments,
and uses a 700 ms holdback. All modes retain the same destination-only
interruption rule. The capability status is authoritative when a provider cannot
meet a mode's strongest terminology expectation.

`openai_native` is the direct server-side OpenAI realtime path. `openai_controlled`
is a separate complete path composing transcription, server-side text
translation, glossary binding/authorization, and TTS. For each controlled lane,
pinned source terms and aliases are deduplicated into session keyword hints; the
compiled reverse glossary supplies the opposite lane without runtime mutation.
Matched terms are replaced by opaque placeholders, translated while preserved,
then restored to approved `target_exact` values. Missing, duplicate, reordered,
or unknown placeholders create structured terminology alerts. This path fails
open with the best available text if control or a provider fails; continuity does
not make a terminology acceptance claim.

`palabra` is a complete independent server-side speech-to-speech alternative.
It uses the Palabra streaming adapter with `PALABRA_INPUT_CHUNK_MS` pacing
(20–320 ms in 20 ms increments) and exposes its own capability table. A Palabra
account glossary is not a substitute for the Harness's deterministic pinned
target-exact contract.

Translation ports expose `prepare(context)` and `closeSession(sessionId)`
lifecycle methods. Opening a room prepares both lane contexts concurrently
before it becomes active; a preparation failure leaves the room ready and closes
the provider session.

## Glossary boundary

There are two intentionally different import surfaces:

| Surface | Current capability |
|---|---|
| Browser UI and `POST /api/glossaries` | CSV or XLSX bytes carried as bounded canonical base64, plus filename, name, source language, target language, and customer approver. The server derives repository identity/version metadata and stamps the approval time. |
| `FileGlossaryRepository` | CSV or XLSX parsing, explicit identity/version/languages/approval metadata, immutable create-only persistence, conflict detection, hash verification, and version pinning. |

Both file formats use the required columns `id`, `source`, `aliases`, and
`target_exact`. A session pins the returned immutable version; it never follows a
mutable "latest" glossary. The current UI selects one glossary version for one
session. The Harness compiles both directions: the approved `source` ->
`target_exact` pair controls the declared lane, and an automatically derived
`target_exact` -> `source` pair controls the reverse lane. Forward aliases are
not guessed as reverse aliases. Import compiles both directions up front and
rejects duplicate or ambiguous reverse terms before storing the version.

Supplying `glossaryVersion` when creating a session is valid only when the
selected mode advertises `deterministicGlossary: true`. The UI prevents an
incompatible request, and the HTTP API authoritatively rejects it with
`glossary_unsupported`, returning the compatible modes. This is capability
driven: currently all `openai_controlled` modes qualify, while no
`openai_native` or `palabra` mode does. Palabra account-enabled glossaries are
outside this pinned target-exact guarantee.

Both CSV and XLSX are advertised by `/api/capabilities` and accepted by the
browser picker. Header names are normalized before mapping; duplicate normalized
names are rejected before a row object can overwrite an approved value.

## TLS and credential path

The server can start without TLS for a localhost-only PC smoke test. A phone on a
LAN is not localhost, and browser microphone capture requires a secure context.
A real two-phone run must therefore use HTTPS/WSS with:

- a certificate whose subject alternative name matches the LAN hostname or IP;
- a certificate chain trusted by the operator PC and both phones;
- `TLS_CERT_PATH` and `TLS_KEY_PATH` configured together; and
- `PUBLIC_BASE_URL` set to that reachable root `https://` origin, with pathname
  `/` and no credentials, query, or fragment. Startup rejects a base
  URL below a subpath because the current static application does not mount
  there.

Operator browser HTTP calls require the bearer token read from the operator URL
fragment; operator event sockets use the same token. Set `OPERATOR_TOKEN`
explicitly for an operable launch URL because startup logging deliberately
redacts the fragment. Per-session participant grants are HMAC-bound to the
session and side. A participant link keeps that grant in `#access=...`; the
browser presents it only when opening the same-session event socket and the
exact-side media socket. Missing or mismatched HTTP credentials return 401, and
rejected WebSocket connections close with policy code 1008.

The provider credential path is deliberately short:

```text
launch process environment -> validated server config -> selected OpenAI or Palabra adapter
```

`OPENAI_API_KEY` is required only for `openai_native` or `openai_controlled`;
`PALABRA_API_KEY` is required only for `palabra`. Neither key enters browser
JavaScript, QR links, participant URLs, API payloads, UI events, glossary files,
or evidence. QR carries a scoped participant grant rather than a provider key.
`.env.example` documents the variables; `pnpm dev`, `pnpm start`, and `pnpm
benchmark` load an optional repository-root `.env` through Node's
`--env-file-if-exists` flag.

## Media composition seam and future carrier

The core depends on the `MediaPort` contract rather than browser or carrier
types. `createMediaRuntime` currently selects either the browser WebSocket
adapter or the in-process fake-telephony adapter from one `MEDIA_PROFILE`
value. The relay, selected provider/mode contract, glossary control, and evidence
contract do not change.

The fake adapter converts fixed 8 kHz, mono, 20 ms PCMU/G.711 mu-law frames to
canonical PCM and back. Its test-only driver is exposed by
`ApplicationComposition` only in that media setting, so integration tests can connect
both sides, exercise a bounded reorder window, signal speech, inject numbered
frames, observe generation-aware clear/output events, and test
hangup/reconnect. DTMF and transport failures enter the core only as normalized
alert events; they never create translated audio. It is a keyless mechanism
fixture, not a live carrier integration or a Twilio/SIP acceptance result. The
fixture itself is keyless; a full server still enforces the selected translation
provider's normal API-key preflight.

A future Twilio Media Streams, SIP/RTP, or PBX adapter belongs at this seam.
Production phone work must preserve the product rule: ring/connect the two
humans directly, with no AI greeting or IVR before the human conversation.

## Evidence boundary and known gaps

- Contract and unit tests use local fakes for provider sockets and HTTP calls.
- The self-check and keyless runner are deterministic; provider and product
  acceptance verdicts remain `NOT_RUN`.
- The PCMU fixture validates adapter mechanics (codec conversion, bounded
  jitter, lifecycle, alerts, and evidence routing) only. It does not exercise
  Twilio, SIP/RTP networking, carrier provisioning, phone numbers, or live
  call acceptance.
- The local TTS corpus replay hash-validates generated WAVs and exercises
  mu-law conversion, fake telephony, relay, glossary control, playout, and
  evidence. It injects manifest text as the transcript and therefore makes no
  acoustic STT or natural target-speech claim.
- The keyless runner executes the controlled arm's eight formal cases, twelve
  local-processing latency cases, twenty interruption state-machine cases, and
  one sparse virtual duplex mechanism fixture: 30 actual PCM frames per lane
  placed across a virtual 10-minute (60,000-frame) timeline. Its PASS is not a
  sustained provider or queue-soak result; that evidence remains `NOT_RUN`.
- Those observations do not include STT, provider translation, TTS, acoustic
  playback latency, forced alignment, or human review.
- The discovery command can call the OpenAI text endpoint, but it is not a live
  speech-to-speech acceptance run.
- The `palabra` runtime adapter is implemented and exercised with fake sockets;
  no live Palabra acceptance runner or provider evidence is included, so Palabra
  acceptance remains `NOT_RUN` without credentials and a completed provider run.
- A workspace-local helper issues disposable LAN test certificates; installing
  its CA on each phone, LAN DNS/routing, and firewall setup remain operator
  responsibilities.
- Evidence is not a substitute for recording consent or an approved retention
  policy.

These gaps prohibit a live OpenAI or Palabra PASS claim from repository tests
alone.
