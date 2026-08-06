# Fast Translation Harness

Fast Translation is a local-first engineering POC for a live, bidirectional
translation room. One central Harness runs on an operator PC. Two participants
can join from phone browsers; the same media contract also has an in-process
fake-telephony driver for provider-free integration tests.

> Implementation status: this repository contains a working Harness, browser
> media path, test-only fake-telephony seam, keyless local terminology replay,
> OpenAI adapters, controlled terminology path, encrypted evidence store, and
> benchmark mechanism tooling. It does not contain evidence of a successful live
> OpenAI, SIP/PSTN, or Palabra acceptance run. The `palabra_live` runtime
> adapter is implemented, but live Palabra acceptance evidence remains
> `NOT_RUN` without credentials and a completed provider run.

## Implemented scope

- One Fastify server is the central authority for session state, media routing,
  translation-profile selection, interruption fencing, events, and evidence.
- With `MEDIA_PROFILE=browser_pair`, Phone A and Phone B each use a browser
  microphone and WSS media connection. Audio is normalized to 24 kHz, mono,
  PCM16LE in 20 ms frames.
- With `MEDIA_PROFILE=fake_telephony`, tests use an exposed in-process driver
  and `fake-telephony://` grants. This exercises the replaceable media seam; it
  is not a live carrier, SIP, or telephone-number implementation.
- With `MEDIA_PROFILE=browser_pair`, the operator creates a room, shares two QR
  links, waits for both participants,
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
| `local_eval` | None | Injects declared lane transcripts after canonical input audio, runs the real glossary control/alert/playout path, and emits deterministic PCM. It proves Harness behavior, not acoustic STT or natural target speech. |
| `native_live_baseline` | `OPENAI_API_KEY` | Dedicated OpenAI realtime speech-translation adapter. No controlled glossary guarantee. |
| `glossary_controlled` | `OPENAI_API_KEY` | Session-pinned STT keyword/language hints, text translation, exact-term authorization, and TTS. |
| `palabra_live` | `PALABRA_API_KEY` | Server-side Palabra streaming adapter with controlled/per-utterance relay semantics. `PALABRA_INPUT_CHUNK_MS` defaults to 320 ms (20–320 ms, multiples of 20). |

The server always exposes `deterministic_test` and `local_eval`. It exposes
OpenAI-backed profiles only when `OPENAI_API_KEY` is present, and exposes
`palabra_live` only when `PALABRA_API_KEY` is present at startup.
Credentials remain on the server; they are never sent in participant links or
browser responses.

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
LAN HTTP origin as insecure and will not expose the microphone. Generate
workspace-local LAN test certificates, then follow the trust and HTTPS steps in
the [demo runbook](docs/demo-runbook.md):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\generate-lan-tls.ps1 `
  -OutputDirectory .\work\tmp\lan-tls `
  -DnsName fast-translation.local `
  -IpAddress 192.168.1.50
```

Replace the example IP with the Harness PC's reachable LAN address. Generated
keys and certificates remain disposable test assets under `work/tmp/lan-tls`.

## Provider-free terminology replay

On Windows, the generator first tries a matching SAPI voice and falls back to
an installed FFmpeg build with the `flite` filter when SAPI cannot render. It
generates WAV fixtures for each source term and alias, then replays them through
PCM-to-mu-law conversion,
`FakeTelephonyMediaPort`, the actual relay, `local_eval`, glossary
authorization, playout, and in-memory evidence:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\generate-local-eval-corpus.ps1 `
  -InputCsv .\examples\manufacturing-glossary.csv `
  -OutputDirectory .\work\tmp\local-eval-corpus `
  -Language en-US

pnpm local-eval:replay `
  --manifest .\work\tmp\local-eval-corpus\manifest.json `
  --source-language en-US `
  --target-language zh-TW `
  --output .\work\tmp\local-eval-corpus\replay-report.json
```

Every WAV is SHA-256 pinned before a session opens. The report verifies
`target_exact`, alerts, source/playout evidence, and test-telephony output. Its
transcript comes from the manifest fixture text; this path intentionally does
not claim acoustic STT accuracy or provider TTS quality.

## Glossaries

The persistent repository can import UTF-8 CSV and XLSX, records customer
approval metadata, stores immutable versions, verifies a content hash on pin,
and pins one version into a session. Each approved source/target pair is also
compiled into the reverse lane; ambiguous reverse terms are rejected at import.
Both `glossary_controlled` and `local_eval` accept a pinned glossary version.
The API rejects one on deterministic, native-baseline, and `palabra_live`
sessions; Palabra account glossaries are outside this pinned target-exact guarantee.

Required entry columns are:

```text
id,source,aliases,target_exact
```

`aliases` accepts a JSON string array or values separated by `|`, `;`, or a
newline. The browser and HTTP API accept both CSV and XLSX bytes. Headers are
normalized, and duplicate normalized names are rejected before any value can
be overwritten. The shipped example contains demonstration values, not customer
approval; review it before naming an approver.
A browser-ready example is
[examples/manufacturing-glossary.csv](examples/manufacturing-glossary.csv).

### Authorized evidence export

For an `encrypted_local` session, set the same 32-byte base64 evidence key used
to record the session and explicitly acknowledge that the destination is plaintext:

```powershell
$env:EVIDENCE_ENCRYPTION_KEY_BASE64 = "<recording key>"
pnpm evidence:export -- --input .\data\evidence\<session-hash>.evidence.jsonl.enc --output-dir .\work\tmp\evidence-export --acknowledge-plaintext-export
```

The exporter authenticates every encrypted record before creating output. It
writes sanitized `events.jsonl`, four mono track WAVs, synchronized
`four-track.wav`, `export-manifest.json`, and `checksums.sha256`. Treat the whole
output directory as sensitive plaintext and remove it according to the approved
retention procedure.

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
pnpm run benchmark -- protocol --output .\work\tmp\benchmark-protocol.json
pnpm run benchmark -- self-check --output .\work\tmp\benchmark-self-check.json
```

The self-check must report `acceptanceVerdict: "NOT_RUN"`. It executes and
measures 36 separate local binder/reinsertion operations; samples are not
recycled. It still does not run STT, live translation, TTS, acoustic latency,
Palabra, or human review.

To execute every canonical run without provider keys and persist one terminal
marker plus one result per run:

```powershell
pnpm run benchmark -- run-local --artifact-dir .\work\tmp\keyless-benchmark --approved-profile .\work\tmp\healing\approved-profile.json --owner-public-key .\work\tmp\owner-keys\owner-public-key.pem --output .\work\tmp\keyless-summary.json
```

This creates `manifest.json`, per-run artifacts, aggregate JSONL, `score.json`,
`bundle.json`, and `checksums.sha256`. Only the deterministic
`GLOSSARY_CONTROLLED` mechanism arm can pass locally. Discovery, Palabra, and
OpenAI provider arms remain `NOT_RUN`; `providerAcceptanceVerdict` and
`productAcceptanceVerdict` therefore remain `NOT_RUN`. Local timing and
interruption observations are algorithmic processing checks, not acoustic or
human-reviewed acceptance evidence.
Artifact hashes and checksums provide only self-consistency and accidental-edit
detection inside the trusted workspace; they do not prove execution provenance.
Treat a local PASS as a self-attested trusted-workspace mechanism result.

`pnpm run benchmark -- discover` runs all 20 built-in open-data candidates three
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

The keyless pre-release path is also executable, while preserving the explicit
Glossary Owner approval boundary:

```powershell
pnpm run benchmark -- owner-keygen --output-directory .\work\tmp\owner-keys
pnpm run benchmark -- healing-propose --artifact-dir .\work\tmp\healing
# Copy the exact two hashes from healing-proposal.json into this explicit approval:
pnpm run benchmark -- healing-approve --artifact-dir .\work\tmp\healing --proposal .\work\tmp\healing\healing-proposal.json --owner "<owner>" --approved-at "<ISO-8601>" --base-profile-hash "<base hash>" --proposed-diff-hash "<diff hash>" --owner-private-key .\work\tmp\owner-keys\owner-private-key.pem
pnpm run benchmark -- run-local --artifact-dir .\work\tmp\keyless-benchmark --approved-profile .\work\tmp\healing\approved-profile.json --owner-public-key .\work\tmp\owner-keys\owner-public-key.pem --output .\work\tmp\keyless-summary.json
pnpm run benchmark -- release-gate --artifact-dir .\work\tmp\release --benchmark-dir .\work\tmp\keyless-benchmark --approved-profile .\work\tmp\healing\approved-profile.json --owner-public-key .\work\tmp\owner-keys\owner-public-key.pem
```

The proposal uses only a declared synthetic/open-data failure fixture, performs
minimize, independent reproduce, regression, and zero-regression steps, and can
never auto-approve or claim provider acceptance.

## Project documents

- [Demo runbook](docs/demo-runbook.md) - secure LAN setup, operator procedure,
  evidence, glossary import, and benchmark commands.
- [Implementation architecture](docs/implementation-architecture.md) - central
  Harness boundaries, four-track evidence, profiles, secrets, the composed
  media seam, and the future carrier adapter boundary.
- [Same-room benchmark protocol](docs/prototypes/same-room-benchmark-protocol.md)
  - preserved planning prototype with a larger historical workload; it is not an
  implementation result and its counts are not the current compact constants.
- [Realtime translation competitive survey](docs/research/realtime-translation-competitive-survey.md)
  and [Palabra terminology research](docs/research/palabra-low-latency-terminology-deep-research.md)
  - preserved research inputs, not provider acceptance evidence.

The signed profile and release-gate artifacts identify the trust anchor as
operator_supplied_test_key and keep customerOwnerAcceptanceVerdict at
NOT_RUN. A local PASS is therefore only a self-attested trusted-workspace
mechanism result; customer owner, provider, and product acceptance remain
NOT_RUN, and customer owner key provisioning remains an external blocker.
