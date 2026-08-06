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
| Phone A browser| <-----------> | Central Harness on one PC   | <------------> OpenAI
| mic + headphones|              | session, routing, profiles, |   (optional)
+----------------+               | glossary, fence, evidence   |
                                 +-----------------------------+
+----------------+   HTTPS/WSS              ^
| Phone B browser| <-------------------------+
| mic + headphones|
+----------------+
```

This is not a carrier call. A phone is an ordinary browser endpoint. There is no
PSTN/SIP number, inbound ring, IVR, AI greeting, DTMF, or automated language
question in the current implementation.

`createMediaRuntime` is the composition seam. `MEDIA_PROFILE=browser_pair`
builds the browser WebSocket port and signed QR grants.
`MEDIA_PROFILE=fake_telephony` instead builds the in-process G.711 mu-law test
port, returns `fake-telephony://` grants, exposes a test driver, and omits the
browser media route. Capabilities advertise only the active profile. The fake
profile is executable but is not a live carrier.

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
- translation-profile routing;
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

## Translation profiles

The composition root always registers `deterministic_test` and `local_eval`.
If and only if `OPENAI_API_KEY` is present, it also registers both OpenAI-backed
profiles. If and only if `PALABRA_API_KEY` is present, it registers
`palabra_live` with the configured `PALABRA_INPUT_CHUNK_MS` pacing.

| Profile | Implementation |
|---|---|
| `deterministic_test` | Emits deterministic labels and returns input audio through the correct opposite-side route. It exercises the Harness but performs no language translation. |
| `local_eval` | Accepts canonical input frames, injects declared lane transcripts, runs the same glossary binding/authorization and alert path, and emits deterministic canonical PCM. It proves Harness behavior, not acoustic STT or provider TTS. |
| `native_live_baseline` | Connects server-side to the dedicated OpenAI realtime translation adapter and streams normalized translation events into the Harness. |
| `glossary_controlled` | Composes live transcription, server-side text translation, glossary binding/authorization, and TTS. |
| `palabra_live` | Uses the server-side Palabra streaming adapter. Relay lanes remain controlled/per-utterance; it is not classified as native continuous. |

For each controlled lane, the pinned glossary's source terms and aliases are
deduplicated and sent to `gpt-live-transcribe` as session-specific keyword
hints; the lane source language is sent as a language hint. The automatically
compiled reverse glossary therefore supplies the opposite lane's hints without
runtime mutation. Unsupported keyword shapes are omitted from STT hints while
the deterministic target authorization path remains active.

The controlled profile replaces matched source terms with opaque placeholders,
asks the text translator to preserve them byte-for-byte, and reinserts the
approved `target_exact` values. Missing, duplicated, reordered, or unknown
placeholders create structured terminology alerts. The path fails open with the
best available text when control or a provider fails; continuity is not a claim
that terminology acceptance passed.

The `TRANSLATION_PROFILE` environment variable participates in startup
validation. A no-key process can select `deterministic_test` or `local_eval`;
`palabra_live` requires `PALABRA_API_KEY`. Translation ports expose required
`prepare(context)` and `closeSession(sessionId)` lifecycle methods. Starting a
room prepares both lane contexts concurrently before emitting `active`; a
preparation failure leaves the room `ready` and closes the provider session.
The API reports the actually registered profiles and rejects a session request
for an unavailable profile.

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

`glossaryVersion` is valid when the session profile is
`glossary_controlled` or `local_eval`; the HTTP API rejects it for
`deterministic_test`, `native_live_baseline`, and `palabra_live` instead of
advertising a glossary that those paths ignore. Palabra account-enabled
glossaries are outside this pinned target-exact guarantee.

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

Operator browser HTTP calls require the bearer token read from the startup
`operatorUrl` fragment; operator event sockets use the same token. Per-session
participant grants are HMAC-bound to the session and side. The human-facing link
keeps that grant in `#access=...`; the browser presents it only when opening the
same-session event socket and the exact-side media socket. Missing or mismatched
HTTP credentials return 401, and rejected WebSocket connections close with
policy code 1008.

The OpenAI credential path is deliberately short:

```text
launching process environment -> validated server config -> OpenAI adapter
```

The key never enters browser JavaScript, QR links, API payloads, UI events,
glossary files, or evidence. `.env.example` documents the variables; the `pnpm
dev`, `pnpm start`, and `pnpm benchmark` scripts load an optional repository-root
`.env` through Node's `--env-file-if-exists` flag.

## Media composition seam and future carrier

The core depends on the `MediaPort` contract rather than browser or carrier
types. `createMediaRuntime` currently selects either the browser WebSocket
adapter or the in-process fake-telephony adapter from one `MEDIA_PROFILE`
value. The relay, translation profiles, glossary control, and evidence contract
do not change.

The fake adapter converts 8 kHz G.711 mu-law to canonical PCM and back. Its
test-only driver is exposed by `ApplicationComposition` only in that profile,
so integration tests can connect both sides, signal speech, inject numbered
frames, and inspect output. It is not a live carrier integration.

A future Twilio Media Streams, SIP/RTP, or PBX adapter belongs at this seam.
Production phone work must preserve the product rule: ring/connect the two
humans directly, with no AI greeting or IVR before the human conversation.

## Evidence boundary and known gaps

- Contract and unit tests use local fakes for provider sockets and HTTP calls.
- The self-check and keyless runner are deterministic; provider and product
  acceptance verdicts remain `NOT_RUN`.
- The local TTS corpus replay hash-validates generated WAVs and exercises
  mu-law conversion, fake telephony, relay, glossary control, playout, and
  evidence. It injects manifest text as the transcript and therefore makes no
  acoustic STT or natural target-speech claim.
- The keyless runner executes the controlled arm's eight formal cases, twelve
  local-processing latency cases, twenty interruption state-machine cases, and
  one accelerated 10-minute virtual soak, with persistent markers and results.
- Those observations do not include STT, provider translation, TTS, acoustic
  playback latency, forced alignment, or human review.
- The discovery command can call the OpenAI text endpoint, but it is not a live
  speech-to-speech acceptance run.
- The `palabra_live` runtime adapter is implemented and exercised with fake
  sockets; no live Palabra acceptance runner or provider evidence is included,
  so Palabra acceptance remains `NOT_RUN` without credentials and a completed
  provider run.
- A workspace-local helper issues disposable LAN test certificates; installing
  its CA on each phone, LAN DNS/routing, and firewall setup remain operator
  responsibilities.
- Evidence is not a substitute for recording consent or an approved retention
  policy.

These gaps prohibit a live OpenAI or Palabra PASS claim from repository tests
alone.
