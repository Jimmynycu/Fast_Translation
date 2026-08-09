# Implementation architecture

## Scope and truth boundary

Fast Translation is a local-first, two-person live-translation POC for English (en-US) <-> Traditional Chinese (zh-TW), with either language assignable to either fixed side. One Windows operator PC runs the central Harness. Two phone browsers attach as fixed A and B sides. Human sessions require a profile with approved data admission; the checked-in `manufacturing-poc` profile deliberately permits only synthetic benchmarks. The system does not implement PSTN/SIP numbers, inbound ringing, IVR, AI greeting, DTMF call control, carrier provisioning or a general telephony product.

The local deterministic mechanism self-check is executable and reports `MECHANISM_PASS` separately from acceptance. A valid keyless run may contain local **PASS** observations, but the local release evidence gate, external provider behavior, regional/data assurances, production operations, product acceptance, PSTN/SIP and carrier acceptance are not inferred from that result. Unless a credentialed, audited run provides evidence, those verdicts are **NOT_RUN**.

```text
Phone A browser ── secure media/events ──┐
                                         │
                                  Central Harness
                                         │
Phone B browser ── secure media/events ──┘
                  operator UI / API / WS
```

`browser_pair` is the actual browser route. `fake_telephony` is an in-process G.711 μ-law test fixture that returns `fake-telephony://` grants and never becomes a carrier integration.

## Composition root and approved processing profile

`composeApplication()` has one non-secret provider-routing input: an `ApprovedSessionProcessingProfile` loaded from `PROCESSING_PROFILE_PATH` and pinned by `PROCESSING_PROFILE_SHA256`. It also requires `DEPLOYMENT_BUILD_SHA256`, an explicit immutable lowercase 64-hex identity derived by the release process from the exact deployed Git commit; there is no package-version or generated fallback. The loader validates the JSON, validates the embedded canonical body hash and then requires equality with the deployment pin. A session manifest is rebuilt from the approved profile and checked against it, so a caller cannot substitute different endpoints, egress, evidence, retention, consent or fallback fields while retaining only the same profile name.

The repository reference artifact is [manufacturing-poc.json](../profiles/manufacturing-poc.json):

| Field | Reference value |
|---|---|
| Profile identity | `manufacturing-poc@2026-08-09` |
| Canonical body SHA-256 | `48ccc7bd514c92c11d6d6e448fb714daf720b87891536d96efacc239e8948294` |
| Scope | `poc` |
| Runtime route | `openai_controlled`: transcription → text translation → TTS |
| Approved modes / default | `fast`, `balanced`, `accurate` / `balanced` |
| External vendor/data assurances | explicitly `unverified` with `NOT_RUN`; `trainingUse`/`serviceRetention` make admission `synthetic_only`, so human `POST /api/sessions` receives 422 `synthetic_only_profile` |

Validate an artifact before deployment:

```powershell
pnpm processing-profile:validate -- --input .\profiles\manufacturing-poc.json
```

In the clean checkout of the exact commit that will be deployed, derive the required build identity without treating a package version as an identity:

```powershell
$deployedCommit = (git rev-parse --verify 'HEAD^{commit}').Trim()
if (git status --porcelain) { throw 'Deploy only a clean checkout of the exact commit.' }
$deploymentBuildSha256 = [Convert]::ToHexString(
  [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($deployedCommit))
).ToLowerInvariant()
"DEPLOYMENT_BUILD_SHA256=$deploymentBuildSha256"
```

The runtime validates only the 64-hex shape and exposes it to authenticated operators in `evidenceIdentity`; deployment discipline supplies the exact-commit binding. It is not release attestation and must never fall back to a package version or invented static hash.

The profile contains service roles/categories, immutable ordered `dataCategories`, HTTPS origins and path templates, named model/voice where applicable, region/training/service-retention/DPA assurances, glossary egress, fallback approval, evidence controls, retention policy and consent policy. `dataCategories` are the non-secret categories actually sent to a service; they are not assertions about vendor training, retention, region or DPA. It is not a place for API keys, tokens, participant IDs, endpoint query strings or raw evidence identifiers.

| Service role | Required ordered `dataCategories` |
|---|---|
| controlled transcription | `canonical_audio`, `source_language`, `source_terms`, `aliases` |
| controlled text translation | `source_transcript`, `source_language`, `target_language`, `opaque_placeholders` |
| controlled TTS | `authorized_target_text` |
| OpenAI native speech-to-speech | `canonical_audio`, `target_language` |
| Palabra speech-to-speech | `canonical_audio`, `source_language`, `target_language` |

Each service projection is profile- and manifest-hash-bound; unknown, duplicate or reordered values reject the profile. The pre-consent disclosure exposes only id/provider/role/category and that ordered category list. It never exposes endpoint, model, voice, assurance body or raw manifest.

The composition root selects exactly one adapter route:

| Profile provider | Adapter construction | Credential | Capability mapping |
|---|---|---|---|
| `openai_native` | One OpenAI realtime speech-to-speech service | `OPENAI_API_KEY` | `fast` native, `balanced` locally controlled, `accurate` experimental/nonselectable; no deterministic pinned glossary. |
| `openai_controlled` | OpenAI live transcription, Responses text translation, and TTS | `OPENAI_API_KEY` | `fast`, `balanced`, `accurate` locally controlled; only profile-defined local pinned-glossary egress is allowed. |
| `palabra` | One Palabra streaming speech-to-speech service | `PALABRA_API_KEY` | all three modes native; input transport maps to fixed 320 ms chunks; provider account glossary does not make deterministic pinned glossary. |

The provider and static capabilities are fixed for the process. `/api/capabilities` reports all three mode rows and the profile's `dataAdmission`: `approved_poc_content` or `synthetic_only`. Only `native` and `locally_controlled` are selectable; `experimental` and `unsupported` have an explanatory reason. `fast`, `balanced`, `accurate` specify relay behavior (commit/finality/holdback), not an external-quality claim. If any selected service `trainingUse` or `serviceRetention` assurance is unverified, `POST /api/sessions` rejects with 422 `synthetic_only_profile` before it creates a relay or grants; no client/operator override exists.

`fallback.kind` is immutable and only `none` or `same_route_fail_open`, both requiring an approval reference. `none` releases no source substitution when translation fails; `same_route_fail_open` may make the approved bounded source fallback on the same route. Neither authorizes automatic cross-provider or cross-route fallback. The reference profile uses `none`.

There is no legacy environment route for a provider, mode, model, voice, profile alias, evidence profile, single evidence directory or arbitrary plaintext export path. Configuration rejects those obsolete keys rather than using a fallback.

## Session lifecycle and consent

The authoritative lifecycle is:

```text
operator create waiting room
  → each participant accepts recording + processing
  → both sides connect
  → recorder preflight
  → operator arm_recorder
  → provider prewarm/readiness
  → ready
  → operator start
  → active
  → end or participant withdrawal
  → finalization
  → closed
```

1. `POST /api/sessions` is operator-authenticated and only permitted when the profile's `dataAdmission` is `approved_poc_content`. It creates an unconsented `waiting` room using the fixed English (en-US) <-> Traditional Chinese (zh-TW) pair in either direction, selected mode and optional glossary version, then builds the session's immutable processing manifest.
2. The side-bound participant page displays the sanitized processing disclosure. The participant accepts recording and processing on that exact side; the server binds the consent receipt to the session manifest's consent policy reference. Browser media cannot attach before consent.
3. Both sides must connect and report qualified participant readiness (`fake_telephony` is explicitly N/A). `arm_recorder` runs the persisted recorder preflight: disk capacity, encrypted spool/metadata integrity, manifest binding and exactly four tracks.
4. Arming persists and flushes four `recorder_track_armed` proofs: `source_a`, `source_b`, `playout_to_a`, `playout_to_b`. Provider preparation/prewarm runs automatically before `ready`, and truthful provider readiness must be present in both directions. `translation_prepare_failed` is an operator-only static-safe alert; raw provider errors never cross this boundary.
5. The `start` command only transitions a fully qualified `ready` session to `active`; it cannot silently make an unprepared partial session active.
6. A participant's exact-side withdrawal uses a fresh withdrawal ID. It is terminal by policy: the relay ends the session and initiates finalization; it cannot be treated as a pause or reversed into active.

The relay normalizes each browser frame to canonical 24 kHz, mono, PCM16LE, 20 ms audio. Source A drives lane `A_TO_B`; source B drives `B_TO_A`. Barge-in starts a new generation for the destination lane and clears only that destination's old provisional playout. It never erases durable final evidence or stops capture on the other lane.

## Evidence lifecycle and cryptographic boundary

`SessionArtifactStore` is the production evidence port. It owns storage paths, encryption, finalization, recovery, retention, deletion and managed export. Tests/local evaluations may inject an in-memory port at a narrow seam, but it is not launch-configurable.

```text
EVIDENCE_ROOT_KEY_BASE64
      │
      ├── HKDF wrapping key ── wraps one random per-session DEK
      └── HKDF archive-id key ── opaque archive identity
      └── HKDF audit keys ── detached encrypted content-free audit chain

per-session DEK ── AES-256-GCM/AAD ── encrypted archive + sealed metadata
```

The configuration declares five non-overlapping, non-nested roots. Each is a
strict descendant of the dedicated resolved `SECURITY_DATA_DIRECTORY` parent.
Loopback HTTP development defaults to `./data`; remote HTTPS requires an
explicit absolute parent outside the deployment cwd. Recursive ancestor
boundary checks are fail-closed by default; only a disposable exact-loopback
HTTP fixture may set `ALLOW_INSECURE_LOOPBACK_DATA_BOUNDARY=true`:

| Root | Purpose |
|---|---|
| `EVIDENCE_ARCHIVE_DIRECTORY` | encrypted active spool and sealed ledger |
| `EVIDENCE_KEY_DIRECTORY` | wrapped-DEK / encrypted metadata sidecar |
| `EVIDENCE_EXPORT_DIRECTORY` | store-managed plaintext export workspace |
| `EVIDENCE_RECEIPT_DIRECTORY` | content-free deletion, sweep-health, and detached review-audit receipts |

The preflight persists its result and refuses arming if free space is insufficient, the spool/metadata cannot be verified, or the exact four tracks are not ready. The relay requires a result bound to the session and processing-manifest SHA.

At finalization the store writes a finalization manifest and seal, verifies the encrypted ledger, final chain and four track digests, and binds the receipt to session ID and processing-manifest SHA. The sealed receipt has a retention deadline equal to finalization time plus the profile's default retention. A `FINALIZATION_FAILED` result is explicit (`seal_write_failed`, integrity failure or manifest write failure) with a recovery directive; it blocks managed export and blocks a local PASS claim.

Evidence visibility is intentionally split:

- accepted final provider-derived transcript/terminology/alert events are durable and retain internal opaque `evidenceRef` values;
- provisional provider events are live-only, not durable;
- rejected provider output and adapter diagnostics become `translation_rejected` evidence records only;
- browser/session/event projections never emit rejection payloads, raw evidence refs, provider credentials, root keys, archive paths or raw archive identities; and
- the only profile plaintext-export policy is `explicit_owner_acknowledgement`; a frozen authorized reviewer may request sealed metadata and bounded audio windows but never create plaintext.

## Retention, recovery and governance

The only retention policy accepted by the core is scheduled deletion with a 14-day default, one extension, a 30-day maximum, and expiry verification within 24 hours.

- startup calls `recover()` before serving and performs an immediate sweep; fatal recovery errors (for example, an unreadable or unauthenticated evidence root) abort startup, while recoverable finalization failures or crash-orphan quarantines start a restricted degraded health/deletion service;
- the same server schedules a sweep every hour on the same artifact store;
- if a sweep fails, retention health becomes degraded and the server refuses new sessions, extension and export while allowing an owner-initiated deletion;
- extension is owner-only, idempotent by UUID command ID, requires a reason and UTC deadline, and cannot be used more than once or beyond 30 days;
- early deletion or scheduled expiry delete terminal sealed artifacts or governed/quarantined `FINALIZATION_FAILED` artifacts;
- deletion erases the encrypted ledger, sidecar and managed plaintext export workspace while retaining a content-free receipt with opaque actor/reason/command information, retention policy/profile/finalization bindings, encrypted-ledger/final-seal hashes, extension audit and the 24-hour verification result. It also retains the detached content-free review-audit chain and records its authenticated head/count in the deletion receipt.

Access scopes are separate:

| Scope | Configuration | Authority |
|---|---|---|
| Operator | `OPERATOR_TOKEN` | sessions, commands, glossary import, capability/session/events access |
| Retention owner (data owner) | `RETENTION_OWNER_ID` + `RETENTION_OWNER_TOKEN` | when matching the frozen session grant: audited retention/metadata/audio review; the retention-owner credential is exclusively authorized for one extension, early deletion, immutable glossary deletion, finalized plaintext export |
| Evidence reviewer (deployment-assigned bilingual reviewer) | `EVIDENCE_REVIEWER_ID` + `EVIDENCE_REVIEWER_TOKEN` | when matching the frozen session grant: audited retention summary, metadata pages and bounded audio windows; never plaintext creation or lifecycle mutation |

Tokens must be 32–512 non-whitespace characters and all three tokens must differ. Owner and reviewer identities must differ. The two deployment-assigned identities are frozen into `{ dataOwnerId, bilingualReviewerId }` at session creation; the finalization binding exposes only its hash. “Bilingual reviewer” names a deployment authorization role, not a runtime language-skill assertion. Evidence management is HTTP bearer-token authorization, not the operator URL fragment.

```text
POST   /api/sessions/:sessionId/evidence/review
POST   /api/sessions/:sessionId/evidence/review/audio-window
GET    /api/sessions/:sessionId/evidence/retention
POST   /api/sessions/:sessionId/evidence/retention/extensions
DELETE /api/sessions/:sessionId/evidence
POST   /api/sessions/:sessionId/evidence/exports
DELETE /api/glossaries/:version
```

### Sealed evidence-review boundary

The application creates one immutable review grant for every session from deployment configuration, not operator/participant input. A retention-owner actor must equal its `dataOwnerId`; an evidence-reviewer actor must equal its `bilingualReviewerId`. A mismatch receives no session/data projection. Operator bearer and every phone/participant credential are excluded. The grant's raw identities remain internal encrypted evidence; finalization binds its SHA-256 only.

`POST /api/sessions/:sessionId/evidence/review` accepts only `{ cursor?: opaque canonical cursor, pageSize?: 1..100 }` and produces a paged sealed summary plus constrained transcript, glossary-provenance, and alert projections—never audio markers. `POST /api/sessions/:sessionId/evidence/review/audio-window` accepts only `{ track, startOffsetMs, durationMs }`, where track is one of the four evidence tracks and start/duration are 20-ms aligned; duration is 20–30,000 ms. Audio is available exclusively through this route, which returns only bounded 24 kHz mono PCM16LE `audio/wav` (maximum 1,440,044 bytes) and an opaque audit ID header. `GET /api/sessions/:sessionId/evidence/retention` uses the same verified review path and returns only sealed retention deadline metadata. These evidence routes use `Cache-Control: no-store`; none emits a filesystem path, archive ID, raw manifest, evidence reference, export location, or an unbounded/conversation JSON copy of audio.

Under the artifact lifecycle lock, the store verifies sealed finalization, retention deadline, encrypted ledger/final-chain/grant binding and the prior audit head before it exposes a result. It atomically commits an encrypted, HMAC-authenticated, detached content-free audit entry first: allowlisted action/outcome/role; HMACed actor; request-selection HMAC; response hash; timestamp; and prior head. The entry contains no transcript, audio, raw identity, session/archive ID, path or export destination. Audit-integrity or persistence failure fails closed before release. Deletion removes evidence/key/export data but not this receipt-root chain; its deletion receipt preserves the verified audit integrity/head/count. The audit proves an authorized disclosure was durably committed, not that the recipient consumed it.

Owner export uses strict `{ commandId: <UUID>, acknowledgePlaintextExport: true }`; no acknowledgement is rejected and a reused command ID with different input returns `409 idempotency_conflict`. Its 200 response is safe metadata only: export ID, manifest/processing/finalization/seal hashes, count, deadline and track digests—never filesystem destination, archive ID, session plaintext or raw archive reads. It rejects degraded retention with 503 and expired evidence with 410. The reviewer cannot invoke it.

Glossary deletion is owner-only and strict `{ commandId: <UUID>, reason: <trimmed 1..500 chars> }`; server derives actor/time. It returns only opaque completed receipt metadata, or `409 glossary_active`, `404 glossary_not_found`, `409 idempotency_conflict`. A selected version stays leased through its active session and is released on terminal events, relay-open failure and shutdown. The operation is intentionally independent of evidence-retention health.

Glossary persistence uses the existing `EVIDENCE_ROOT_KEY_BASE64` with purpose-separated HKDF subkeys, not a separate key/env/fallback. It writes random-nonce/AAD AES-256-GCM `*.glossary.enc` envelopes under a fresh/dedicated encrypted `GLOSSARY_DIRECTORY`, using POSIX owner-only permissions and fsync atomic writes. The server holds an exclusive glossary-root lease from startup through orderly close; a second process, unsafe ancestor, symlink, or realpath change fails closed. HMAC-authenticated content-free deletion receipts and tombstones survive restart: a matching retry returns its original result, a changed retry conflicts, completed versions cannot be reacquired/reimported, and a new immutable version may be imported. Legacy plaintext glossary files are deliberately not read or migrated.

### Mandatory POC-completion master-glossary disposal

Session finalization seals session evidence; it is not POC closure and it does not delete encrypted master glossary versions. There is no automatic glossary-deletion lifecycle or compatibility path. At POC completion, the retention owner must perform this governance checklist:

1. Reconcile the controlled import/session-manifest log to inventory every immutable encrypted master glossary version imported for the POC, including versions never selected by a session.
2. For every inventoried version, manually invoke owner-only `DELETE /api/glossaries/:version` with a canonical lowercase UUID `commandId` and a reason.
3. Retain each resulting content-free deletion receipt in the POC closeout record; it records no glossary content.
4. Verify the deletion receipt/tombstone enforcement prevents each listed version from being reacquired or reimported.
5. Do not close the POC if any version remains, any deletion fails (including an active lease), a receipt is missing, or reacquisition remains possible. Release terminal session leases and retry as necessary.

An earlier customer deletion request uses the same manual owner-only DELETE operation as soon as its lease is released; its receipt remains part of the final reconciliation. The legacy plaintext glossary root must be securely disposed under the organization’s deletion procedure before the fresh/dedicated encrypted `GLOSSARY_DIRECTORY` is used. It is not read, migrated, or retained as a compatibility or recovery source.

Managed plaintext export is an authenticated owner HTTP client. It accepts only a base URL, session ID, canonical command ID and explicit plaintext acknowledgement; the retention-owner bearer token is injected through `EVIDENCE_OWNER_ACCESS_TOKEN`, never argv. It never accepts a root key, `--local-admin`, managed roots, archive ID or self-reported owner identity. The server derives the actor from the bearer token and enforces the frozen data-owner grant before invoking the owner-only export route. Four-track WAV admission rejects a timeline over five minutes or aggregate WAV output over 128 MiB before opening plaintext files.

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

The export CLI base URL must use HTTPS; only exact `127.0.0.1` or `[::1]` loopback HTTP fixtures are permitted, and `localhost` or remote HTTP is rejected before a bearer is sent. The client streams response bodies through a 256 KiB cap and fixed request deadline before JSON parsing. The export CLI command ID must be reused verbatim after a lost/uncertain result; missing/invalid ID is rejected before any HTTP request. Its output is safe metadata only and never includes plaintext, paths, archive/session identities or bearer tokens; expiry, authorization, conflict and server failures are static nonzero errors. The sweep CLI has no command ID and remains the only offline root-key operation: it uses an `offline_admin` lease for recovery and expiry work while the server is stopped and roots are released. A live foreign lease makes sweep fail closed before evidence I/O. Leases have no fixed expiry: a stale same-host lease is reclaimed only after the OS confirms its process is dead; unknown/cross-host leases refuse administration. Simultaneous server and offline-sweep access to the same roots is never safe or supported.

## HTTP, WebSocket and UI boundary

Fastify serves the operator/participant UI, JSON API, session event WebSocket, participant side-bound consent/withdrawal routes and browser media WebSocket. The server maps internal `SessionEvent` records to a deliberately sanitized `UiEventEnvelope`.

Participant media access is signed and bound to session plus side. Operator token access permits operator API/event access; it does not replace participant consent or evidence-management credentials. Startup logging redacts operator URL fragments and server logging redacts request URL / authorization.

The operator Evidence Console reports state, consent, connections, recorder preflight/arm status, participant/provider readiness, truthful queue/lag provenance, terminology state, genuine barge lifecycle, capability table, glossary state, alerts, generation cuts and closure. It also receives operator-only `evidenceIdentity`: deployment build SHA, profile id/version/SHA, processing-manifest SHA and services SHA. It is not an evidence-review credential and cannot retrieve retention summaries, review metadata, or review WAV data. Headphone confirmation is a participant self-attestation, not a verified hardware fact. Provider readiness preserves adapter semantics rather than claiming a generic external provider connection.

Operator `session_state` / terminal `session_closed` projections may include sanitized `evidenceFinalization`: either sealed manifest/ledger/chain hashes, retention deadline and four track `{sha256, frameCount, byteCount}` values, or `FINALIZATION_FAILED` with allowlisted `failureCode` and recovery directive. Participant projections never include those console fields, raw manifests, evidence refs, tokens, paths, archive IDs or free-form provider errors.

## Validation boundary

Repository checks include TypeScript, unit/integration contracts, browser lifecycle and keyless benchmark artifacts. They exercise processing-manifest binding, consent/withdrawal, four-track preflight/arming, encryption/integrity, retention, opaque references, managed export and local relay mechanics.

`pnpm benchmark` writes `MECHANISM_PASS` / `acceptanceVerdict: NOT_RUN` for the deterministic self-check. A keyless run labels valid local mechanism gate outcomes `PASS` or `FAIL`; it labels malformed/non-opaque evidence references or terminal finalization/manifest integrity failures `INVALID_RUN`, never `FAIL`; intentionally unexecuted acceptance is `NOT_RUN`. The default artifact is 41 `PASS`, 0 `FAIL`, 0 `INVALID_RUN`, 142 `NOT_RUN`. Its local release evidence gate is nevertheless `NOT_RUN`: it lacks acoustic latency/barge-in and exported normalized-event/four-track audio evidence. Content-bound virtual receipt hashes are not encrypted persistence or recorder/audio coverage. No benchmark result may claim credentialed OpenAI/Palabra acceptance, regional/DPA/training/retention assurances, real-phone/PSTN/SIP behavior, operational reliability or human product acceptance. The reference `manufacturing-poc` profile intentionally retains its unverified external assurances as `NOT_RUN` and blocks human session creation.
