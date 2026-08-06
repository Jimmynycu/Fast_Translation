# Two-phone demo runbook

This runbook starts the implemented central Harness on one Windows PC and joins
two phone browsers over the same LAN. It covers a provider-free routing demo and
the optional OpenAI-backed profiles. It does not turn local mechanism checks into
provider acceptance evidence.

## 1. Equipment and prerequisites

Have all of the following before the session:

- one Windows operator PC with Node.js 24 or newer and pnpm 11;
- two current phone browsers on the same reachable LAN;
- headphones for both phone participants;
- explicit recording consent from both participants;
- inbound LAN access to the selected server port (default `4207`); and
- for a two-phone run, an HTTPS certificate trusted by the PC and both phones.

The certificate must cover the exact hostname or IP used in `PUBLIC_BASE_URL`.
A certificate warning that a user can click through is not equivalent to a
trusted secure context on every mobile browser. Install the issuing CA on both
phones before the demo and verify the HTTPS page opens without a warning.

## 2. Install and verify

Run these commands from a PowerShell window:

```powershell
Set-Location D:\Fast_Translation
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Do not continue with a two-phone demo if typecheck, tests, or build fails.

## 3. Export the common LAN configuration

Replace the example hostname and certificate paths with values for the operator
PC. Relative certificate paths are resolved from the repository root.

```powershell
$env:HOST = "0.0.0.0"
$env:PORT = "4207"
$env:PUBLIC_BASE_URL = "https://translator-pc.example.test:4207"
$env:TLS_CERT_PATH = ".\certs\lan-cert.pem"
$env:TLS_KEY_PATH = ".\certs\lan-key.pem"
$env:MEDIA_PROFILE = "browser_pair"
$env:GLOSSARY_DIRECTORY = ".\data\glossaries"
$env:LOG_LEVEL = "info"
$env:OPERATOR_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

`TLS_CERT_PATH` and `TLS_KEY_PATH` are a pair. Setting only one is a startup
error. `PUBLIC_BASE_URL` is not cosmetic: it is the origin placed in both QR
participant links. Use only a root origin such as `https://host:4207/`; a
pathname other than `/`, credentials, a query, or a fragment is rejected because
the current static app is not mounted below a subpath. Do not use `localhost` or
`127.0.0.1` there for a phone run.

The application reads these process variables directly. The `pnpm dev`, `pnpm
start`, and `pnpm benchmark` scripts also load an optional repository-root
`.env` through Node's `--env-file-if-exists` flag.

## 4. Choose one startup mode

### A. Deterministic, no OpenAI key, in-memory evidence

This is the fastest end-to-end routing and interruption check. It sends audio
through the correct opposite-side lane but does not translate language. Evidence
disappears when the process exits.

```powershell
$env:TRANSLATION_PROFILE = "deterministic_test"
$env:EVIDENCE_PROFILE = "in_memory"
$env:OPENAI_API_KEY = "" # Overrides any key loaded from the optional repo .env
Remove-Item Env:EVIDENCE_KEY_BASE64 -ErrorAction SilentlyContinue
pnpm dev
```

### B. Deterministic, no OpenAI key, encrypted evidence

Generate a separate evidence-encryption secret first:

```powershell
pnpm keygen
```

Copy only the printed base64 value into the environment, then start:

```powershell
$env:TRANSLATION_PROFILE = "deterministic_test"
$env:EVIDENCE_PROFILE = "encrypted_local"
$env:EVIDENCE_DIRECTORY = ".\data\evidence"
$env:EVIDENCE_KEY_BASE64 = "<paste the generated base64 value>"
$env:OPENAI_API_KEY = "" # Overrides any key loaded from the optional repo .env
pnpm dev
```

The evidence key is not an OpenAI credential, but it is still a secret. Losing it
makes existing evidence unreadable. Do not commit it or paste it into issue logs.

### C. OpenAI-backed profiles

Keep the common TLS settings, select either OpenAI startup profile, and inject the
key only into the server process:

```powershell
$env:OPENAI_API_KEY = "<server-side OpenAI API key>"
$env:TRANSLATION_PROFILE = "glossary_controlled"
$env:EVIDENCE_PROFILE = "in_memory"
pnpm dev
```

With a key present, the server registers `native_live_baseline`,
`glossary_controlled`, and `deterministic_test`. The startup profile variable is
validated at launch; the operator's session selection chooses the actual route.
Use encrypted evidence instead of `in_memory` when the session requires a
persistent record.

The key flows from the launching process environment to validated server config
and then to server-side OpenAI adapters. It is never sent to either phone.

## 5. Check the running server

Leave the server running and use a second PowerShell window. Replace the origin
below with the configured `PUBLIC_BASE_URL`:

```powershell
$operatorHeaders = @{ Authorization = "Bearer $env:OPERATOR_TOKEN" }
Invoke-RestMethod -Uri "https://translator-pc.example.test:4207/api/health"
Invoke-RestMethod -Headers $operatorHeaders -Uri "https://translator-pc.example.test:4207/api/capabilities" |
  ConvertTo-Json -Depth 4
```

Expected health is `status: ok`. Confirm `mediaProfiles` contains
`browser_pair`, the intended translation profile is listed, and the advertised
audio is 24 kHz mono PCM16LE with 20 ms frames. A certificate error here must be
fixed before scanning the QR codes.

## 6. Run the room

1. On the operator PC, open the exact `operatorUrl` printed at startup. Keep its
   `#access=...` fragment; the bare `PUBLIC_BASE_URL` is intentionally unauthorized.
2. Select the language spoken by Phone A, the language spoken by Phone B, and a
   translation profile advertised by `/api/capabilities`.
3. Only for `glossary_controlled`, optionally import a glossary before creating
   the room. After the glossary owner reviews the entries, enter that approver's
   name and upload `examples/manufacturing-glossary.csv`, or an approved
   replacement. The current UI accepts CSV only. A glossary version is rejected
   for the other two profiles.
4. Confirm recording consent and click **Create translation room**.
5. Scan the Phone A QR with the A participant and the Phone B QR with the B
   participant. Do not swap links; each link fixes its side.
6. On each phone, connect headphones, check **I'm wearing headphones**, allow
   microphone access, and click **Start microphone**.
7. On the operator dashboard, wait for `2 / 2 joined` and the room state
   `Ready`. Then click **Start session**. This is the direct operator start; no
   IVR or AI greeting runs first.
8. Have A speak and confirm that only B hears the routed output. Have B speak and
   confirm that only A hears it.
9. Test overlap: while translated playout is audible on one phone, have that
   participant speak. The dashboard should show a generation cut, and stale
   translated audio should stop.
10. Click **End** before closing either phone page.

For `deterministic_test`, the audible result is routed source audio and the
captions contain deterministic labels. That proves browser capture, central
routing, opposite-side playout, session control, and fencing only. It does not
prove translation quality.

For `glossary_controlled`, import the table in the Phone A language -> Phone B
language direction. The Harness also derives Phone B -> Phone A entries by using
each approved `target_exact` as the reverse source and the original `source` as
the reverse exact target. Ambiguous reverse terms are rejected during import, so
the one pinned version controls both lanes deterministically.

## 7. Glossary file contract

The UI example uses four required columns:

```text
id,source,aliases,target_exact
```

- `id` is stable within that glossary.
- `source` is the source phrase to match.
- `aliases` are forward-direction source variants. They may be empty, a JSON
  string array, or values separated by `|`, `;`, or a newline.
- `target_exact` is the customer-approved spelling inserted into committed
  target text. It also becomes the automatically derived reverse source, whose
  exact target is the original `source`.

Every `target_exact` must therefore identify one unambiguous reverse entry.

At session start, the controlled profile sends the pinned lane's `source` and
`aliases` to live transcription as keyword hints, together with the lane source
language. The reverse lane uses the automatically derived glossary.

The UI sends CSV text plus name, languages, and approver metadata. The server
creates an immutable repository version and returns the version pin used when
the room is created. Reusing an identity/version with different content is a
conflict rather than an overwrite.

`FileGlossaryRepository` can also parse XLSX with the same headers, but no current
HTTP or browser control exposes XLSX upload. Do not rename an XLSX file to CSV.

The bundled CSV is a schema and routing example. Its values are not evidence of
customer approval and must not be treated as a production glossary by default.

## 8. Inspect evidence

For `encrypted_local`, ending the session flushes the session writer. Graceful
process shutdown on `SIGINT` or `SIGTERM` also ends every active relay session
and waits for its evidence writer before closing the server. Prefer the operator
**End** action so the intended session reason is explicit, but a normal Ctrl+C is
also a supported flush path. List the encrypted bundles with:

```powershell
Get-ChildItem .\data\evidence\*.evidence.jsonl.enc
```

The filename is derived from a hash of the session ID. Each line is an
authenticated encrypted record. Audio records carry one of `source_a`,
`source_b`, `playout_to_a`, or `playout_to_b`; event records carry normalized
session evidence.

The repository does not currently include a decrypt/export CLI or WAV muxer. Use
the typed `readEncryptedEvidence` API for authorized programmatic inspection.
With `in_memory`, no evidence file is expected.

## 9. Benchmark commands and exact workload

Create the workspace-local output directory and print the encoded workload:

```powershell
New-Item -ItemType Directory -Force .\work\tmp | Out-Null
pnpm benchmark protocol --output .\work\tmp\benchmark-protocol.json
Get-Content .\work\tmp\benchmark-protocol.json
```

The compact, hash-pinned executable manifest allocates every run as follows:

| Stage | Allocation |
|---|---:|
| Discovery | 10 candidates per direction x 3 real renders = 60 |
| Formal terminology | 4 per arm/direction: 2 protected, 1 confuser, 1 ordinary = 24 |
| Latency | 3 repeats per arm/direction for protected and ordinary = 36 |
| Interruptions | 5 each of four scenarios per arm = 20 per arm, 60 total |
| Continuous duplex | one 10-minute session per arm, 30 minutes total |

The protocol command validates its canonical manifest hash plus every fixture,
schedule, arm-config, profile, evidence-schema, timing, and gate hash before
writing output. Component hashes are recomputed from the supplied evidence,
timing, and gate bodies. Every run must match its canonical fixture, schedule,
direction, arm, profile/config hashes, and source-run semantics; latency pairs
require one distinct run from each arm. It also fixes the deterministic order
and cross-arm pairing key for all 183 runs. Discovery fixtures use
`openai_text_api`; the formal and latency fixtures explicitly require
`operator_read_aloud`. Printing the manifest does not execute a provider run.
Run the provider-free mechanism check with:

```powershell
pnpm benchmark self-check --output .\work\tmp\benchmark-self-check.json
Get-Content .\work\tmp\benchmark-self-check.json
```

This command must leave `acceptanceVerdict` as `NOT_RUN`. Its terminology
count comes from the 20 candidate-only entries. It performs 36 distinct timed
binder/reinsertion operations; it does not recycle 20 measurements into 36.
Those timings are not the frozen semantic result or live acoustic latency.

The optional discovery command makes three live OpenAI text translation calls
for each of the 20 built-in open-data candidate sentences:

```powershell
$env:OPENAI_API_KEY = "<server-side OpenAI API key>"
pnpm benchmark discover --output .\work\tmp\benchmark-discovery.json
```

Every render, rejected-candidate reason, and provider/model setting remains in
`candidateEvidence`. A family enters `healingInput` only when at least two of
its three renders miss the provisional exact target. These terms remain
`candidate_only`.

Before any paid request, discovery must pre-authorize all 60 calls against
the default US$3 total envelope (US$0.05 per call); otherwise it dispatches
nothing. Each request receives an AbortSignal and 15-second deadline, the whole
run has a five-minute deadline, and Responses are limited to 128 output tokens.
Completed calls are conservatively charged at the full authorized ceiling.

The pre-release workflow in `src/benchmark/healing.ts` requires a strictly
smaller minimized case whose normalized tokens are a deletion-only subsequence
of the original, plus an independent reproducer before it becomes a regression.
Each proposal changes the system prompt, background Harness, and
glossary, then runs every open regression. Before every external operation, the
Harness verifies that its declared maximum cost fits inside the remaining
US$25 family budget and gives it an abortable deadline inside the 30-minute
window. Work that cannot fit is never dispatched; only completed proposals
count toward the three-iteration cap. Success produces an exact diff with
status `awaiting_owner_approval`; the Glossary Owner must approve its base
profile hash and diff hash before an immutable profile hash is created. The
workflow never changes an active session and cannot auto-approve or hot-swap a
profile.

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| Phone says microphone requires HTTPS | Use the HTTPS QR origin and trust its issuing CA on that phone. HTTP is valid only for localhost smoke testing. |
| QR opens the wrong host | Fix the root-only `PUBLIC_BASE_URL`, restart, and create a new room. Subpaths, credentials, queries, and fragments are rejected. |
| Operator cannot start | Both participants must click **Start microphone** so both media sockets join and the session becomes ready. |
| Profile is unavailable | Check `/api/capabilities`. Add `OPENAI_API_KEY` for OpenAI profiles and restart the process. |
| Session rejects the glossary version | Select `glossary_controlled`; deterministic and native-baseline sessions cannot pin a glossary. |
| Glossary never binds | Match glossary source/target languages to the desired lane and verify all four required headers. |
| No evidence file appears | `in_memory` is intentionally non-persistent. For encrypted evidence, end the room cleanly and check `EVIDENCE_DIRECTORY`. |
| Phones cannot reach the PC | Verify LAN routing, hostname resolution, inbound firewall access to the configured port, and that `HOST` is `0.0.0.0`. |

## Acceptance warning

Passing `pnpm test`, the deterministic room, or `benchmark self-check` is not a
live provider verdict. Do not report OpenAI or Palabra PASS/CONDITIONAL_PASS until
the frozen corpus, live audio runs, forced-alignment/human review, interruptions,
continuous soaks, and evidence-integrity checks have actually completed. No such
acceptance bundle is included in this repository.
