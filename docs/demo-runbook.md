# Two-phone demo runbook

This runbook launches the implemented browser path: one central Harness on a Windows operator PC and two phone browsers on the same LAN. It requires a profile whose `GET /api/capabilities` reports `dataAdmission: "approved_poc_content"`; it does not authorize a human demo with the checked-in `manufacturing-poc` sample. That sample deliberately has unverified `trainingUse`/`serviceRetention`, so `POST /api/sessions` returns 422 `synthetic_only_profile` before a relay or participant grant exists. A local keyless mechanism self-check, fixture, browser harness or benchmark is not live provider, PSTN/SIP or product acceptance; those remain **NOT_RUN** until separately executed with real credentials and evidence.

## 1. Prepare the PC and phones

Have the following before starting:

- Windows operator PC with Node.js 24+ and pnpm 11;
- two current phone browsers on a mutually reachable LAN;
- headphones for each participant;
- both participants available to read and accept recording and processing on their own pages;
- inbound LAN access to the selected port (default `4207`); and
- an HTTPS certificate trusted by the PC and both phones.

The certificate SAN must match the exact hostname/IP in `PUBLIC_BASE_URL`. A mobile click-through warning is not a reliable secure context. Do not use `localhost` or `127.0.0.1` for this two-phone flow.

From repository root:

```powershell
corepack enable
corepack prepare pnpm@11.16.0 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Stop and repair the build if any check fails. `pnpm start` runs the existing `dist` build, so run `pnpm build` again after TypeScript changes.

## 2. Create workspace-local LAN TLS material

Replace the sample IP and name with the operator PC's reachable LAN values:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\generate-lan-tls.ps1 `
  -OutputDirectory .\work\tmp\lan-tls `
  -DnsName fast-translation.local `
  -IpAddress 192.168.1.50
```

Trust `work\tmp\lan-tls\local-demo-ca.cer` on the PC and both phones. Keep `server-key.pem` local. `PUBLIC_BASE_URL` must be the root origin (`https://host:port/`), with no subpath, credentials, query or fragment.

## 3. Configure the profile, roles and encrypted evidence

Copy the template, make three different bearer secrets, and generate the evidence root key:

```powershell
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
pnpm keygen
```

The three generated secrets are for `OPERATOR_TOKEN`, `RETENTION_OWNER_TOKEN`, and `EVIDENCE_REVIEWER_TOKEN`; do not reuse them. Set `RETENTION_OWNER_ID` to the deployment-assigned data owner and `EVIDENCE_REVIEWER_ID` to the deployment-assigned bilingual-reviewer role; both identities must differ. At room creation the server freezes that exact pair into the session's sealed evidence-review grant. “Bilingual reviewer” is an authorization assignment, not a language-skill attestation. `pnpm keygen` prints the value for `EVIDENCE_ROOT_KEY_BASE64`. It is canonical Base64 for 32 random bytes, not a provider credential, and must remain secret.

The checked-in POC processing profile is [manufacturing-poc.json](../profiles/manufacturing-poc.json). It is a non-secret, approval-controlled deployment artifact. Its `sha256` is the canonical body hash—not a raw file hash—and must match `PROCESSING_PROFILE_SHA256` exactly. Do not edit the profile in place for a demo; create and approve a new profile plus pin if the route or policy changes.

```powershell
pnpm processing-profile:validate -- --input .\profiles\manufacturing-poc.json
```

This reference profile selects `openai_controlled`, so its server launch needs `OPENAI_API_KEY`. It remains synthetic-benchmark-only: selected services have `trainingUse` and `serviceRetention` marked `unverified` / `NOT_RUN`, so it cannot run the human two-phone steps below. For a human demo, supply a separately approved immutable profile with verified selected-service assurances and replace both path/pin; no browser or operator override exists.

Set `.env`:

```dotenv
HOST=0.0.0.0
PORT=4207
PUBLIC_BASE_URL=https://192.168.1.50:4207
TLS_CERT_PATH=./work/tmp/lan-tls/server-cert.pem
TLS_KEY_PATH=./work/tmp/lan-tls/server-key.pem

PROCESSING_PROFILE_PATH=./profiles/manufacturing-poc.json
PROCESSING_PROFILE_SHA256=48ccc7bd514c92c11d6d6e448fb714daf720b87891536d96efacc239e8948294
DEPLOYMENT_BUILD_SHA256=<sha256-of-exact-deployed-git-commit>

OPERATOR_TOKEN=<operator-secret>
RETENTION_OWNER_ID=<retention-owner-identity>
RETENTION_OWNER_TOKEN=<retention-owner-secret>
EVIDENCE_REVIEWER_ID=<evidence-reviewer-identity>
EVIDENCE_REVIEWER_TOKEN=<evidence-reviewer-secret>

MEDIA_PROFILE=browser_pair
ALLOW_INSECURE_LOOPBACK_DATA_BOUNDARY=false
SECURITY_DATA_DIRECTORY=C:/fast-translation-security
EVIDENCE_ARCHIVE_DIRECTORY=C:/fast-translation-security/evidence/archive
EVIDENCE_KEY_DIRECTORY=C:/fast-translation-security/evidence/keys
EVIDENCE_EXPORT_DIRECTORY=C:/fast-translation-security/evidence/exports
EVIDENCE_RECEIPT_DIRECTORY=C:/fast-translation-security/evidence/receipts
GLOSSARY_DIRECTORY=C:/fast-translation-security/glossaries
EVIDENCE_ROOT_KEY_BASE64=<pnpm-keygen-output>
```

The five security directories must be strict descendants of the dedicated `SECURITY_DATA_DIRECTORY`, distinct and non-nested. Remote HTTPS deployments require that parent to be an explicit absolute directory outside the deployment cwd; loopback HTTP development may omit it and use `./data`. Ancestor boundary checks are fail-closed by default; only a disposable loopback HTTP fixture may set `ALLOW_INSECURE_LOOPBACK_DATA_BOUNDARY=true`, and HTTPS rejects that opt-out. The root key and provider credentials never go to browser code, QR data, participant links, evidence refs, logs, or source control.

`DEPLOYMENT_BUILD_SHA256` is mandatory, immutable lowercase 64-hex deployment metadata; it has no package-version or generated fallback. In the exact clean Git checkout that will be deployed, derive it from the full commit ID:

```powershell
$deployedCommit = (git rev-parse --verify 'HEAD^{commit}').Trim()
if (git status --porcelain) { throw 'Deploy only a clean checkout of the exact commit.' }
$deploymentBuildSha256 = [Convert]::ToHexString(
  [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($deployedCommit))
).ToLowerInvariant()
"DEPLOYMENT_BUILD_SHA256=$deploymentBuildSha256"
```

Copy that emitted assignment into the deployment `.env`. It is an operator-only evidence identity, not a substitute for release attestation.

### Provider route

The processing profile—not environment routing—selects one provider and the approved modes. Add only its server-side credential:

| Profile provider | Required `.env` credential | Route |
|---|---|---|
| `openai_native` | `OPENAI_API_KEY` | One OpenAI managed realtime speech-to-speech service. `fast` is native; `balanced` is locally controlled; `accurate` is experimental/nonselectable. No deterministic pinned glossary. |
| `openai_controlled` | `OPENAI_API_KEY` | OpenAI transcription, text translation and TTS services. `fast`, `balanced`, `accurate` are locally controlled; profile egress rules govern local pinned glossary. |
| `palabra` | `PALABRA_API_KEY` | One Palabra managed realtime speech-to-speech service. All modes are native; transport input is fixed at 320 ms; account glossary does not create Harness deterministic glossary support. |

`GET /api/capabilities` is the runtime source of truth. It reports one row for each of `fast`, `balanced`, `accurate`; only `native` and `locally_controlled` state can be selected. `experimental`/`unsupported` rows have a reason and cannot be selected.

The pre-consent disclosure shows each selected service's immutable ordered `dataCategories`: controlled transcription sends `canonical_audio`, `source_language`, `source_terms`, `aliases`; controlled text translation sends `source_transcript`, `source_language`, `target_language`, `opaque_placeholders`; controlled TTS sends `authorized_target_text`; OpenAI native speech-to-speech sends `canonical_audio`, `target_language`; Palabra speech-to-speech sends `canonical_audio`, `source_language`, `target_language`. These are actual egress categories, not claims about vendor training, retention, region or DPA. The profile fallback is only `none` or approved `same_route_fail_open`; it never enables automatic cross-provider fallback. The reference profile uses `none`.

## 4. Start and inspect health

```powershell
pnpm start
Invoke-RestMethod -Uri "https://192.168.1.50:4207/api/health"
```

Expect health `ok`, evidence health `healthy`, and retention health `healthy`. The server runs recovery then an expiry sweep before accepting traffic, and runs another sweep every hour. A fatal recovery failure (for example, an unreadable or unauthenticated evidence root) aborts startup before serving. A recoverable finalization failure or crash-orphan quarantine starts a restricted degraded health/deletion service instead; new sessions, retention extension and export remain rejected until health is restored, while owner deletion stays available.

Open the operator UI only on the PC:

```text
https://192.168.1.50:4207/#access=<OPERATOR_TOKEN>
```

The fragment is not printed in logs. Never share this URL with participants.

Use the operator bearer token to inspect capabilities:

```powershell
$headers = @{ Authorization = "Bearer <OPERATOR_TOKEN>" }
Invoke-RestMethod -Uri "https://192.168.1.50:4207/api/capabilities" -Headers $headers
```

Confirm `mediaProfiles` has `browser_pair`, the profile-selected provider matches `translation.provider`, the default mode is selectable, and `dataAdmission` is exactly `approved_poc_content`. If it is `synthetic_only`, stop: the profile cannot create a human room. The operator Evidence Console is also where safe build/profile/manifest/services identity, recorder preflight, participant/provider readiness, queue/lag, terminology and barge lifecycle are shown; none of those operator-only fields are exposed to participants.

## 5. Run the consent-to-start sequence

1. In the operator UI choose English (en-US) for one phone and Traditional Chinese (zh-TW) for the other, in either direction, plus a selectable translation mode. Optionally import a glossary only when that mode advertises deterministic glossary support.
2. Click **Create translation room**. This creates a `waiting` room; the creation request has languages, mode and optional glossary version, not operator-supplied participant consent.
3. Give Phone A's grant only to A and Phone B's grant only to B. Each participant verifies the processing disclosure, wears headphones, marks the headphone self-attestation, accepts recording and processing, then clicks **Start microphone**. Consent is posted for that exact side before `getUserMedia` or media WebSocket attachment.
4. Wait for both accepted participants, `2 / 2 joined`, and qualified participant browser readiness. Click **Arm recorder**. This is the **preflight → arm** stage: preflight checks free space, encrypted spool/metadata integrity, the bound processing manifest and all four logical tracks; arming durably writes and flushes `source_a`, `source_b`, `playout_to_a`, `playout_to_b` proofs.
5. Provider prewarm is automatic before `Ready`, and both directions need truthful provider readiness. A `translation_prepare_failed` alert is static and operator-only; no raw provider body is sent to browser/UI payloads. Only a session that completes **consent → connect → preflight → arm → ready** can **Start session**; Start only performs `ready → active`.
6. Confirm that A only hears translated B and B only hears translated A. Test barge-in by speaking on the receiving side while its prior provisional playout is running: only that destination's old generation is cut.
7. End normally with **End**. If either participant presses withdrawal on their own page, withdrawal is terminal and immediately starts the end/finalization path; it is never a pause or a way to resume later.

## 6. Evidence, finalization and retention operations

Each session receives a unique random DEK. The root key wraps it; archive, key, export and receipt roots remain separate. An artifact may become exportable only after finalization seals and verifies the manifest, chain, encrypted ledger and all four track digests. `FINALIZATION_FAILED` is a governed/quarantined terminal failure with a recovery directive, not a successful run; it is deletable only through the owner-governed terminal path.

Finalization starts a 14-day retention deadline. A retention owner may request one documented extension, never beyond 30 days. Scheduled deletion runs via hourly sweep and must complete within 24 hours of expiry for terminal sealed or governed/quarantined `FINALIZATION_FAILED` artifacts. Early/scheduled deletion keeps a content-free receipt with opaque actor/reason/command evidence, profile/finalization/digest bindings and verification-window result; it does not retain conversation content.

Management permissions are deliberately separate:

| Role | Deployment identity / bearer | Operations |
|---|---|---|
| operator | `OPERATOR_TOKEN` | sessions, commands, glossary, capabilities |
| retention owner (data owner) | `RETENTION_OWNER_ID` + `RETENTION_OWNER_TOKEN` | when it matches the frozen session grant: audited retention/metadata/audio review; the retention-owner credential is uniquely authorized for one extension, early delete, immutable glossary delete, finalized plaintext export |
| evidence reviewer (deployment-assigned bilingual reviewer) | `EVIDENCE_REVIEWER_ID` + `EVIDENCE_REVIEWER_TOKEN` | when it matches the frozen session grant: audited retention summary, metadata pages, bounded audio windows; never extension/delete/glossary action/plaintext export |

The relevant routes are:

```text
POST   /api/sessions/:sessionId/evidence/review
POST   /api/sessions/:sessionId/evidence/review/audio-window
GET    /api/sessions/:sessionId/evidence/retention
POST   /api/sessions/:sessionId/evidence/retention/extensions
DELETE /api/sessions/:sessionId/evidence
POST   /api/sessions/:sessionId/evidence/exports
DELETE /api/glossaries/:version
```

The review grant is server-built and never supplied by an operator or phone: `{ dataOwnerId, bilingualReviewerId }` is frozen with the session and finalization binds only its hash. A retention owner/reviewer must match both the authenticated role and frozen identity for that session; a mismatch reveals neither data nor session existence. The operator bearer and all phone/participant grants are denied these review/retention routes. Every `/api/sessions/:sessionId/evidence/...` route sends `Cache-Control: no-store`.

Use `POST /api/sessions/:sessionId/evidence/review` for metadata pages, never a GET review endpoint. Its strict JSON body is `{ "cursor"?: "<opaque-canonical-cursor>", "pageSize"?: 1..100 }`; it returns only sealed summary plus authorized transcript/glossary-provenance/alert projections and an opaque next cursor—never audio markers. Use `POST /api/sessions/:sessionId/evidence/review/audio-window` for review audio; audio is available exclusively through this route. Its strict JSON body is `{ "track": "source_a|source_b|playout_to_a|playout_to_b", "startOffsetMs": <non-negative 20-ms-aligned integer>, "durationMs": <20-ms-aligned 20..30000> }`. A success is a bounded 24 kHz mono PCM16LE `audio/wav` response (at most 30 seconds / 1,440,044 bytes) with an opaque `x-evidence-audit-id`; it has no archive path, archive ID, raw manifest, evidence ref, export location, or JSON conversation copy. `GET /api/sessions/:sessionId/evidence/retention` is also audited and returns only `{ status: "sealed", retentionDeadlineAt }`.

Before any retention summary, metadata, or WAV is released, the store verifies the opaque artifact's finalization/seal/chain/grant binding and atomically persists a detached content-free audit record. The encrypted, HMAC-authenticated entry has allowlisted action/outcome/role, HMACed actor, request-selection HMAC, response hash, timestamp and prior audit head; it contains no transcript/audio/raw identity/path/archive/export data. If retention/audit integrity is degraded or audit persistence fails, review fails closed and returns no content. The receipt root keeps this authenticated chain after the encrypted evidence, key sidecar and managed export workspace are deleted; deletion receipt records its audit head/count. It records a committed authorization disclosure, not proof that a person read or listened.

Use canonical lowercase UUID command IDs. Extension requires `reason` and a UTC `requestedDeadline`; early delete requires `reason`; owner-only export requires `acknowledgePlaintextExport: true`. The exact export command ID must be reused if an output/result is lost or uncertain; a different request with the same ID returns `409 idempotency_conflict`. The owner export response is metadata only—never plaintext, path, archive ID or raw archive reads. The reviewer cannot export. Do not use the operator token for evidence governance.

Glossary delete is owner-only: `DELETE /api/glossaries/:version` accepts strict `{ commandId, reason }` where reason is trimmed 1–500 characters; server derives the owner and timestamp. It returns only a completed opaque receipt ID/status/timestamps, or `409 glossary_active`, `404 glossary_not_found`, `409 idempotency_conflict`. An active session leases its selected immutable version, so it cannot be deleted until the lease releases at terminal session/failure/shutdown. This delete remains available during evidence retention degradation.

Glossaries use purpose-separated HKDF subkeys from the existing `EVIDENCE_ROOT_KEY_BASE64`, no separate glossary secret. The fresh/dedicated `GLOSSARY_DIRECTORY` stores only opaque AES-256-GCM `*.glossary.enc` artifacts and HMAC-authenticated content-free delete receipts/tombstones. The server holds an exclusive glossary-root lease for its lifetime; a second process or unsafe root path fails closed. Legacy plaintext glossary files are intentionally not migrated or read; dispose of any former plaintext root under the organization’s deletion procedure before use.

The managed plaintext export command is an authenticated owner HTTP client. Inject its bearer through `EVIDENCE_OWNER_ACCESS_TOKEN` rather than argv; it never accepts a root key, `--local-admin`, managed roots, archive ID or caller-supplied owner identity. The server derives the retention-owner actor from the bearer token and checks the session's frozen data-owner grant.

```powershell
$env:EVIDENCE_OWNER_ACCESS_TOKEN = '<retention-owner-bearer-token>'
pnpm evidence:export -- --base-url http://127.0.0.1:4207 `
  --session-id <session-id> `
  --command-id <canonical-lowercase-uuid> `
  --acknowledge-plaintext-export

pnpm evidence:sweep -- --local-admin `
  --archive-root .\data\evidence\archive `
  --key-root .\data\evidence\keys `
  --export-root .\data\evidence\exports `
  --receipt-root .\data\evidence\receipts
```

The export command requires HTTPS for its base URL; only exact `127.0.0.1` or `[::1]` loopback HTTP fixtures are allowed, while `localhost` and remote HTTP are rejected before a bearer is sent. The client reads responses through a 256 KiB cap and fixed request deadline. It requires a lower-case canonical UUID before any request; reuse it verbatim to retry a lost/uncertain outcome. It returns safe metadata only—never plaintext, path, archive identity, session content or bearer token—and static errors for expiry, authorization, conflict or server failure. The four-track exporter rejects timelines over five minutes or aggregate WAV output over 128 MiB before opening plaintext files. The sweep command remains the only offline root-key operation: it takes an `offline_admin` lease, performs recovery plus expiry work, accepts no command ID and is suitable for an hourly OS scheduler only while the server is down and has released the roots. If a live foreign lease exists, sweep fails closed before evidence I/O. There is no lease expiry: only a same-host lease whose process the OS confirms dead can be reclaimed; unknown or cross-host leases refuse administration.

## 7. Mandatory POC-completion glossary disposal

This is a POC-governance closeout, not ordinary session finalization, evidence-retention expiry, a sweep, or an automatic deletion. At POC completion, the retention owner must complete every item below before declaring the POC closed:

1. Reconcile the controlled import/session-manifest log: inventory every immutable encrypted master glossary version imported for the POC by combining the controlled import records with every POC session manifest. Include versions never attached to a session.
2. For each inventoried version, manually call `DELETE /api/glossaries/:version` with the retention-owner credential, a canonical lowercase UUID `commandId`, and a reason.
3. Record that version’s content-free deletion receipt—receipt ID, completed status, and timestamps—in the POC closeout record, without copying glossary contents.
4. Verify the deletion/tombstone enforcement means no inventoried version can be reacquired or reimported; an absent encrypted file alone is insufficient.
5. Block POC closure while any version remains, any delete fails (including `glossary_active`), any receipt is missing, or any version can still be reacquired. Complete terminal session/lease cleanup and retry the manual delete before closing.

A customer may request deletion earlier. The retention owner must use the same manual owner-delete operation as soon as any active lease releases, record its content-free receipt, and still reconcile that version during the POC-completion inventory; deletion is never deferred to an automatic process. The legacy plaintext glossary root is neither an input nor a compatibility/recovery fallback: securely dispose of it under the organization’s deletion procedure before using the fresh/dedicated encrypted `GLOSSARY_DIRECTORY`; do not read or migrate it.

## 8. What reaches evidence and the UI

Accepted final provider events retain internal evidence references in encrypted evidence. Provisional revisions are live-only. Rejected provider output and adapter diagnostics are `translation_rejected` evidence records only; they never become browser-facing rejection events. Browser/session/event payloads redact evidence refs and do not disclose provider credentials, root keys, archive paths, raw archive IDs or plaintext evidence.

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| Startup rejects config | Verify the profile path and canonical profile SHA, all five security roots are strict descendants of `SECURITY_DATA_DIRECTORY` (an explicit absolute parent outside cwd for HTTPS), disjoint from one another and the web static root, and all three role credentials are distinct. |
| `POST /api/sessions` returns `synthetic_only_profile` | The selected profile has unverified `trainingUse` or `serviceRetention`. Do not use it with people; pin a separately approved human-admission profile. |
| Selected provider key missing | Read `translation.provider` from the approved profile and supply only its required server key. |
| Phone has no microphone | Install/trust the LAN TLS CA, align SAN and `PUBLIC_BASE_URL`, then accept recording/processing on the same participant side before starting microphone. |
| Room does not become `Ready` | Both sides must consent/connect/report qualified readiness; then recorder preflight, four-track arm proof and both provider prewarm/readiness checks must succeed. |
| Health is degraded | Repair evidence recovery/sweep first. Do not start a new session, export, or extend retention while degraded. |
| Export is refused | End and successfully finalize the session; use the retention-owner bearer/API acknowledgement and the canonical command ID. |
| Glossary delete is active | End/finalize the session using that glossary version; the immutable version remains leased until terminal cleanup. |

`pnpm benchmark` is a deterministic mechanism self-check: `MECHANISM_PASS` with `acceptanceVerdict: NOT_RUN`. In its keyless artifact, `PASS`/`FAIL` are valid local mechanism observations, `INVALID_RUN` is an evidence/finalization integrity failure (never a functional FAIL), and `NOT_RUN` is intentionally unexecuted scope. Default is 41 PASS / 0 FAIL / 0 INVALID_RUN / 142 NOT_RUN; local release evidence, provider/product/PSTN acceptance remain NOT_RUN. The checked-in `manufacturing-poc` profile is synthetic-only POC scope and explicitly reports external assurances as **NOT_RUN**.
