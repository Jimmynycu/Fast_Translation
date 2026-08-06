# Fast Translation Harness

Fast Translation is a local-first engineering POC for a live, bidirectional
translation room. One central Harness runs on an operator PC. Two participants
join from phone browsers, and the operator starts and observes the room from the
PC browser.

> Implementation status: this repository contains a working Harness, browser
> media path, local deterministic profile, OpenAI adapters, controlled
> terminology path, encrypted evidence store, and benchmark mechanism tooling.
> It does not contain evidence of a successful live OpenAI or Palabra acceptance
> run. Palabra is a benchmark reference in the protocol, not a runtime adapter.

## Implemented scope

- One Fastify server is the central authority for session state, media routing,
  translation-profile selection, interruption fencing, events, and evidence.
- Phone A and Phone B each use a browser microphone and WSS media connection.
  Audio is normalized to 24 kHz, mono, PCM16LE in 20 ms frames.
- The operator creates a room, shares two QR links, waits for both participants,
  and clicks **Start session** directly. There is no IVR, AI greeting, or
  language-question flow.
- Each participant must use headphones. This prevents translated playout from
  feeding back into the same phone's microphone.
- Evidence uses four logical audio tracks: `source_a`, `source_b`,
  `playout_to_a`, and `playout_to_b`, plus session events and transcripts.
- A generation fence clears stale playout when speech overlaps or the operator
  pauses or ends a session. Provider cancellation is only a best-effort helper;
  the local fence is authoritative.
- Graceful `SIGINT`/`SIGTERM` shutdown ends active sessions and flushes evidence
  writers before the server closes.

For the component boundaries and data flow, see
[Implementation architecture](docs/implementation-architecture.md). For the
two-phone procedure, TLS requirements, and exact commands, see the
[demo runbook](docs/demo-runbook.md).

## Translation profiles

| Profile | Provider key | Behavior |
|---|---|---|
| `deterministic_test` | None | Local deterministic transcript and audio loopback path for routing and lifecycle checks. It does not translate. |
| `native_live_baseline` | `OPENAI_API_KEY` | Dedicated OpenAI realtime speech-translation adapter. No controlled glossary guarantee. |
| `glossary_controlled` | `OPENAI_API_KEY` | Session-pinned STT keyword/language hints, text translation, exact-term authorization, and TTS. |

The server always exposes `deterministic_test`. It exposes both OpenAI-backed
profiles only when `OPENAI_API_KEY` is present at startup. Credentials remain on
the server; they are never sent in participant links or browser responses.

## Repository setup and verification

Requirements: Node.js 24 or newer and pnpm 11.16.0 or a compatible pnpm 11
release.

From PowerShell in the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

The application reads `process.env` directly. `.env.example` documents the
variables. The `pnpm dev`, `pnpm start`, and `pnpm benchmark` scripts load an
optional repository-root `.env` through Node's `--env-file-if-exists` flag.
Direct `node` invocations still require exported variables or a process supervisor.

For a provider-free PC-only startup smoke test:

```powershell
$env:PUBLIC_BASE_URL = "http://localhost:4207"
$env:TRANSLATION_PROFILE = "deterministic_test"
$env:EVIDENCE_PROFILE = "in_memory"
$env:OPENAI_API_KEY = "" # Explicitly overrides any key in the optional repo .env
pnpm dev
```

Open the exact `operatorUrl` printed at startup. Its `#access=...` fragment is
the operator credential; opening the bare root URL leaves the UI unauthorized.
If `OPERATOR_TOKEN` is omitted, every process start generates and prints a new
operator URL.

This HTTP command is only an operator-PC smoke test. A phone browser treats a
LAN HTTP origin as insecure and will not expose the microphone. Use the HTTPS
configuration in the [demo runbook](docs/demo-runbook.md) for two phones.

## Glossaries

The persistent repository can import UTF-8 CSV and XLSX, records customer
approval metadata, stores immutable versions, verifies a content hash on pin,
and pins one version into a session. Each approved source/target pair is also
compiled into the reverse lane; ambiguous reverse terms are rejected at import.
Only `glossary_controlled` accepts a glossary version; the API rejects a pinned
glossary on deterministic or native-baseline sessions.

Required entry columns are:

```text
id,source,aliases,target_exact
```

`aliases` accepts a JSON string array or values separated by `|`, `;`, or a
newline. The current browser UI deliberately exposes CSV upload only. XLSX is a
repository capability, not a current UI feature. The shipped example contains
demonstration values, not customer approval; review it before naming an approver.
A browser-ready example is
[examples/manufacturing-glossary.csv](examples/manufacturing-glossary.csv).

## Benchmark tooling

The compact workload lives in `src/benchmark/protocol.ts`; the canonical,
hash-pinned execution artifact is built by `src/benchmark/executable-manifest.ts`:

| Workload | Frozen allocation |
|---|---:|
| Discovery | 10 candidates per direction x 3 real renders = 60 |
| Formal terminology | 4 per arm/direction: 2 protected, 1 confuser, 1 ordinary = 24 |
| Latency | 3 repeats per arm/direction for protected and ordinary = 36 |
| Interruptions | 5 each of four scenarios per arm = 20 per arm, 60 total |
| Continuous duplex | one 10-minute soak per arm |

The three named arms are `PALABRA_REFERENCE`, `OPENAI_NATIVE_TRANSLATE`, and
`GLOSSARY_CONTROLLED`. The manifest pins all 32 input fixtures, five duplex
schedules, three adapter configs and profiles, the evidence schema, timing
schedule, gates, deterministic run order, pairing keys, and a canonical
`manifestSha256`. Discovery uses the text API; formal and latency fixtures use
the explicit `operator_read_aloud` input mode. Validation recomputes hashes
from the supplied evidence, timing, and gate bodies. It also rejects any run,
fixture, schedule, or arm remapping that differs from the canonical allocation,
including duplicate arms inside a latency pair. Print and validate the manifest,
then run the deterministic terminology mechanism check with:

```powershell
New-Item -ItemType Directory -Force .\work\tmp | Out-Null
pnpm benchmark protocol --output .\work\tmp\benchmark-protocol.json
pnpm benchmark self-check --output .\work\tmp\benchmark-self-check.json
```

The self-check must report `acceptanceVerdict: "NOT_RUN"`. It executes and
measures 36 separate local binder/reinsertion operations; samples are not
recycled. It still does not run STT, live translation, TTS, acoustic latency,
Palabra, or human review.

`pnpm benchmark discover` runs all 20 built-in open-data candidates three
times and preserves every render, rejection decision, and provider/model
provenance in `candidateEvidence`. Only families missing the provisional exact
target in at least two renders enter the typed `healingInput` for the bounded
pre-release workflow in `src/benchmark/healing.ts`.

Before its first provider call, discovery pre-authorizes all 60 operations
against a US$3 total envelope (US$0.05 per call). Each call has a 15-second
abortable deadline, the whole run has a five-minute deadline, and Responses are
limited to 128 output tokens; completed calls are conservatively charged at the
full pre-authorized ceiling.

That workflow requires every minimized case to be strictly smaller, remain a
deletion-only token subsequence, and pass an independent reproduction check.
Each candidate changes the system prompt,
background Harness, and glossary, then evaluates every open regression.
Before dispatching each operation, the Harness reserves its declared maximum
cost from the remaining US$25 family budget and attaches a cancellable deadline
within the 30-minute family window; work that cannot fit is never dispatched.
The family is also capped at three actual proposal iterations. A zero-regression
result remains `awaiting_owner_approval`: no new immutable profile hash exists
until the Glossary Owner approves the exact base profile hash and proposed diff
hash. Nothing mutates an active runtime profile or performs a hot-swap.

## Project documents

- [Demo runbook](docs/demo-runbook.md) - secure LAN setup, operator procedure,
  evidence, glossary import, and benchmark commands.
- [Implementation architecture](docs/implementation-architecture.md) - central
  Harness boundaries, four-track evidence, profiles, secrets, and future phone
  adapter seam.
- [Same-room benchmark protocol](docs/prototypes/same-room-benchmark-protocol.md)
  - preserved planning prototype with a larger historical workload; it is not an
  implementation result and its counts are not the current compact constants.
- [Realtime translation competitive survey](docs/research/realtime-translation-competitive-survey.md)
  and [Palabra terminology research](docs/research/palabra-low-latency-terminology-deep-research.md)
  - preserved research inputs, not provider acceptance evidence.
