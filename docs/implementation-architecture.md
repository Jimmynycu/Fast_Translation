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

The direct-start rule is enforced by the room lifecycle: the operator creates a
room, both browser participants connect their microphones, the Harness becomes
ready, and the operator sends the `start` command. No conversational agent sits
in front of either human.

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
and media WebSockets. Provider details remain behind `TranslationPort`. Browser
wire details remain behind `MediaPort`. Evidence storage remains behind
`EvidencePort`. The core does not consume raw OpenAI, future carrier, or browser
protocol events.

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

"Four-track recording" currently means four labeled PCM frame streams in the
evidence record. It does not mean that the server exports four WAV files, and the
repository does not yet ship an evidence decrypt/export CLI. Evidence writes are
bounded and fail open: an evidence problem is surfaced as a health alert without
blocking live media.

## Translation profiles

The composition root always registers `deterministic_test`. If and only if
`OPENAI_API_KEY` is present, it also registers both OpenAI-backed profiles:

| Profile | Implementation |
|---|---|
| `deterministic_test` | Emits deterministic labels and returns input audio through the correct opposite-side route. It exercises the Harness but performs no language translation. |
| `native_live_baseline` | Connects server-side to the dedicated OpenAI realtime translation adapter and streams normalized translation events into the Harness. |
| `glossary_controlled` | Composes live transcription, server-side text translation, glossary binding/authorization, and TTS. |

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
validation. A no-key process must set it to `deterministic_test`. The API reports
the actually registered profiles and rejects a session request for an unavailable
profile.

## Glossary boundary

There are two intentionally different import surfaces:

| Surface | Current capability |
|---|---|
| Browser UI and `POST /api/glossaries` | UTF-8 CSV only. The request supplies a name, source language, target language, customer approver, and CSV text. The server derives repository identity/version metadata and stamps the approval time. |
| `FileGlossaryRepository` | CSV or XLSX bytes, explicit identity/version/languages/approval metadata, immutable create-only persistence, conflict detection, hash verification, and version pinning. |

Both file formats use the required columns `id`, `source`, `aliases`, and
`target_exact`. A session pins the returned immutable version; it never follows a
mutable "latest" glossary. The current UI selects one glossary version for one
session. The Harness compiles both directions: the approved `source` ->
`target_exact` pair controls the declared lane, and an automatically derived
`target_exact` -> `source` pair controls the reverse lane. Forward aliases are
not guessed as reverse aliases. Import compiles both directions up front and
rejects duplicate or ambiguous reverse terms before storing the version.

`glossaryVersion` is valid only when the session profile is
`glossary_controlled`; the HTTP API rejects it for `deterministic_test` and
`native_live_baseline` instead of advertising a glossary that those paths ignore.

XLSX support therefore exists at the repository boundary but is not advertised
by `/api/capabilities` and is not accepted by the current browser file picker.

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

## Future phone adapter

The core depends on the `MediaPort` contract rather than browser or carrier
types. A future Twilio Media Streams, SIP/RTP, or PBX adapter belongs in
`src/adapters/media` and is selected in the composition root by configuration.
The session core, translation profiles, glossary control, and evidence contract
should not change.

The repository includes an 8 kHz G.711 mu-law codec and a fake telephony adapter
for contract tests. They are not a live carrier integration. Future production
phone work must also preserve the product rule: ring/connect the two humans
directly, with no AI greeting or IVR before the human conversation.

## Evidence boundary and known gaps

- Contract and unit tests use local fakes for provider sockets and HTTP calls.
- The benchmark self-check is deterministic and explicitly reports
  `acceptanceVerdict: "NOT_RUN"`.
- The discovery command can call the OpenAI text endpoint, but it is not a live
  speech-to-speech acceptance run.
- No Palabra runtime adapter or automated Palabra runner is implemented.
- The 24-case formal terminology corpus, 36 live latency runs, 20 interruptions
  per arm, and 10-minute soak per arm are not yet executed by the benchmark CLI.
- TLS certificate issuance, phone trust enrollment, LAN DNS, and firewall setup
  remain operator responsibilities.
- Evidence is not a substitute for recording consent or an approved retention
  policy.

These gaps prohibit a live OpenAI or Palabra PASS claim from repository tests
alone.
