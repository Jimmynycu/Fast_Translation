# Two-phone demo runbook

This runbook launches the central Harness on one Windows PC and connects two
phone browsers over the same LAN. It describes the implemented browser path and
the three server-side translation provider alternatives. It does not turn local
tests, fixture replay, or a successful local session into provider or product
acceptance evidence.

## 1. Prepare the operator PC and phones

Before starting, have:

- one Windows operator PC with Node.js 24+ and pnpm 11;
- two current phone browsers on the same reachable LAN;
- headphones for both participants;
- explicit recording consent from both participants;
- inbound LAN access to the selected port (default `4207`); and
- an HTTPS certificate trusted by the PC and both phones.

The certificate SAN must match the exact hostname or IP in `PUBLIC_BASE_URL`.
A click-through warning is not a dependable mobile secure context. Install the
issuing CA on both phones and confirm that the HTTPS page opens without a
warning before the demo.

From the repository root, install and validate the build:

```powershell
corepack enable
corepack prepare pnpm@11.16.0 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Do not proceed with a two-phone demo if these checks fail. `pnpm start` runs the
existing `dist` build; run `pnpm build` again after changing TypeScript. `pnpm
dev` builds once and watches `dist`, but it does not compile later source edits.

## 2. Create workspace-local LAN TLS material

Replace the sample address with the operator PC's reachable LAN IP:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\generate-lan-tls.ps1 `
  -OutputDirectory .\work\tmp\lan-tls `
  -DnsName fast-translation.local `
  -IpAddress 192.168.1.50
```

Trust `work\tmp\lan-tls\local-demo-ca.cer` on the PC and both phones. Keep
`server-key.pem` local; do not commit it. Ensure Windows Firewall and any LAN
firewall permit the configured port.

`PUBLIC_BASE_URL` is the exact root origin used to make participant links. It
must be `http(s)://host:port/` with no subpath, credentials, query, or fragment.
For two phones use an HTTPS hostname/IP that appears in the certificate SAN;
never use `localhost` or `127.0.0.1` for this flow.

## 3. Configure one provider and a default mode

Copy the template and generate an operator secret:

```powershell
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Paste the generated 32+ character value into `.env` as `OPERATOR_TOKEN`. The
server intentionally redacts its token fragment in startup logs, so the PC
operator must know this value. The operator opens
`https://<host>:4207/#access=<OPERATOR_TOKEN>` locally; it is not a participant
link and must not be shared.

Set the common browser/LAN values in `.env`:

```dotenv
HOST=0.0.0.0
PORT=4207
PUBLIC_BASE_URL=https://192.168.1.50:4207
TLS_CERT_PATH=./work/tmp/lan-tls/server-cert.pem
TLS_KEY_PATH=./work/tmp/lan-tls/server-key.pem
OPERATOR_TOKEN=<32-or-more-character-secret>
MEDIA_PROFILE=browser_pair
EVIDENCE_PROFILE=in_memory
```

Then choose exactly one provider. This choice is fixed for the running server;
the UI never switches providers. `TRANSLATION_MODE` is the UI's preselected
mode, not a lock: the operator can choose another mode that the configured
provider advertises before each new session.

| Provider | Required `.env` values | Advertised modes and limits |
|---|---|---|
| OpenAI native | `TRANSLATION_PROVIDER=openai_native`, `OPENAI_API_KEY=<server-side-key>` | `fast`, `balanced`. `accurate` is unsupported. `balanced` is marked degraded because it uses adapter-local holdback, not because of a model-quality measurement. No mode guarantees a pinned glossary. |
| OpenAI controlled | `TRANSLATION_PROVIDER=openai_controlled`, `OPENAI_API_KEY=<server-side-key>` | `fast`, `balanced`, `accurate`; all currently advertise deterministic pinned glossary support. |
| Palabra | `TRANSLATION_PROVIDER=palabra`, `PALABRA_API_KEY=<server-side-key>` | `fast`, `balanced`, `accurate`. This is the complete independent server-side speech-to-speech alternative. No mode provides this Harness's deterministic pinned glossary; `accurate` is marked degraded for that limitation. |

For all choices, set a valid default such as:

```dotenv
TRANSLATION_MODE=balanced
```

`openai_native` with `TRANSLATION_MODE=accurate` fails preflight. A selected
OpenAI provider requires `OPENAI_API_KEY`; selected Palabra requires
`PALABRA_API_KEY`. The other provider's key can remain empty. Both keys stay in
the server process and never enter client JavaScript, QR data, participant URLs,
capability/session responses, or evidence. `PALABRA_INPUT_CHUNK_MS` defaults to
`320`; valid values are 20–320 in 20 ms increments.

## 4. Start and check the server

Build and start the configured server:

```powershell
pnpm build
pnpm start
```

In a separate PowerShell window, verify health. The health endpoint does not
need the operator bearer token:

```powershell
Invoke-RestMethod -Uri "https://192.168.1.50:4207/api/health"
```

To inspect the actual server capabilities, use the same operator token that is
in `.env`:

```powershell
$operatorToken = "<same OPERATOR_TOKEN from .env>"
$operatorHeaders = @{ Authorization = "Bearer $operatorToken" }
Invoke-RestMethod -Uri "https://192.168.1.50:4207/api/capabilities" -Headers $operatorHeaders
```

Confirm that `mediaProfiles` contains `browser_pair`, `translation.provider`
matches the selected provider, `translation.defaultMode` is valid, and
`translation.supportedModes` contains the expected modes. Each entry exposes its
behavior version, full/degraded state, reason when degraded, and
`deterministicGlossary` flag. This capability response is the source of truth;
do not infer a guarantee from a provider name.

Open the operator UI on the PC with the token in the fragment:

```text
https://192.168.1.50:4207/#access=<same OPERATOR_TOKEN from .env>
```

The fragment supplies local browser authorization; the provider API keys are not
part of this URL. QR links created later contain only session/side-scoped
participant grants, never provider credentials.

## 5. Create and run the room

1. On the operator page, wait for the configuration check to load. It displays
   the fixed provider and fills the mode select from the server capabilities.
   The configured default mode is preselected.

2. Choose two different spoken languages and select an advertised mode. The UI
   shows the behavior version, full/degraded status and reason, plus whether a
   pinned glossary is supported. A created session echoes its pinned provider,
   mode, behavior version and degradation state; it does not change later.

3. If the selected mode supports deterministic glossary, optionally import a
   glossary before creating the room. If it does not, remove the glossary or
   choose a compatible mode. The UI prevents the request and the server also
   rejects it with `glossary_unsupported`.

4. Confirm recording consent, then click **Create translation room**. The
   session API requires this affirmative consent.

5. Give Phone A's QR/link only to participant A and Phone B's QR/link only to
   participant B. Each participant must trust the certificate, allow microphone
   access, wear headphones, check **I'm wearing headphones**, then click
   **Start microphone**.

6. Wait for `2 / 2 joined` and `Ready`, then click **Start session**. Verify
   that speech from A only plays on B and speech from B only plays on A.

7. Test interruption: while translated audio is queued to a participant, have
   that participant begin speaking. The Harness cuts only that destination's old
   generation of provisional playout/text; the other lane remains capturable.
   Final transcript/evidence records remain terminal rather than being erased.

8. Use **End** to close the room cleanly. Participant event pages show recording
   state; close them after the room ends.

## 6. Glossary file workflow

The browser accepts CSV and XLSX. Both formats require these columns:

```text
id,source,aliases,target_exact
```

`aliases` may be a JSON string array or values separated by `|`, `;`, or
newlines. In the operator UI:

1. select the intended A → B languages;
2. enter a glossary name and the approving person's name;
3. select the CSV/XLSX and click **Import glossary**; and
4. keep the chosen language direction unchanged until creating the room.

The server creates an immutable version and hash. It compiles both language
directions and pins the returned version to the session; it never follows a
mutable “latest” glossary. Changing the UI language direction invalidates the
selection and requires re-import. See
[manufacturing-glossary.csv](../examples/manufacturing-glossary.csv) for the
file shape, not as pre-approved customer terminology.

Pinned target-exact control is conditional, not universal: only a mode that the
running server advertises with `deterministicGlossary: true` may use the pinned
version. Presently that is every `openai_controlled` mode and no `openai_native`
or `palabra` mode. A Palabra account glossary is separate from this Harness
guarantee.

## 7. Recording and evidence

`EVIDENCE_PROFILE=in_memory` is appropriate for a disposable demo: it retains
only bounded records for the running process and does not write a file.

For persistent encrypted evidence, generate an encryption key and change `.env`:

```powershell
pnpm keygen
```

```dotenv
EVIDENCE_PROFILE=encrypted_local
EVIDENCE_DIRECTORY=./data/evidence
EVIDENCE_KEY_BASE64=<generated-32-byte-base64-value>
```

Do not lose or disclose this key. It is required to read that evidence later.
After a clean room end, an authorized operator can export plaintext only by
providing the same key and explicitly acknowledging the risk:

```powershell
$env:EVIDENCE_ENCRYPTION_KEY_BASE64 = "<same-32-byte-base64-key>"
$input = (Get-ChildItem .\data\evidence\*.evidence.jsonl.enc | Select-Object -First 1).FullName
pnpm evidence:export -- --input $input --output-dir .\work\tmp\evidence-export --acknowledge-plaintext-export
```

Encrypted evidence includes accepted source/playout audio tracks and event data
such as session state, transcripts, glossary events, alerts, generation cuts and
closure. Export creates sensitive plaintext events/WAV outputs. Retain, share or
remove it only under the recorded consent and applicable retention policy.

## 8. The fake telephony fixture

`MEDIA_PROFILE=fake_telephony` switches the composition root from browser
WebSockets to an in-process test driver. It uses fixed 8 kHz mono 20 ms
PCMU/G.711 μ-law frames and exercises conversion, bounded jitter reordering,
generation-aware clear, DTMF/transport alerts, hangup/reconnect and evidence
routing. It deliberately has no browser media route and returns
`fake-telephony://` test addresses rather than phone QR links.

This option is for integration and mechanism testing, not a two-phone demo. It
does not dial, ring, answer, provision a number, connect Twilio, connect SIP/RTP,
or prove any carrier behavior. It remains independent of the provider choice, so
the chosen server-side provider/key preflight still applies.

A future Twilio Media Streams, SIP/RTP or PBX adapter belongs at the same
`MediaPort` / `createMediaRuntime` seam. Before it can be used as a phone
service, it needs separate carrier, codec, resampling, jitter, sequencing, DTMF,
lifecycle, privacy, quality, glossary, barge-in and soak acceptance evidence.

## 9. Troubleshooting and acceptance boundary

| Symptom | Check |
|---|---|
| Startup says a key is missing | Match `TRANSLATION_PROVIDER` with its required server-only `OPENAI_API_KEY` or `PALABRA_API_KEY`, then restart. |
| Startup rejects the default mode | `openai_native` offers only `fast` and `balanced`; choose one. |
| Operator gets 401 | Open the URL with `#access=<OPERATOR_TOKEN>` from `.env`; startup logging intentionally omits the fragment. |
| Phone says microphone requires HTTPS | Trust the CA on that phone and make certificate SAN, `PUBLIC_BASE_URL`, hostname/IP and port agree. |
| No `Ready` state | Do not swap A/B links; both participants must confirm headphones, grant mic permission and click **Start microphone**. |
| Glossary is refused | Check the selected mode's advertised `deterministicGlossary` capability and use a matching language direction/version. |
| UI shows `fake-telephony://` | Switch back to `MEDIA_PROFILE=browser_pair` for real phone browsers. |
| No evidence file appears | `in_memory` is intentionally non-persistent. For encrypted storage, supply a valid 32-byte `EVIDENCE_KEY_BASE64` and end the room cleanly. |

Passing `pnpm test`, a browser harness, fixture replay or fake-telephony test is
not a live OpenAI, Palabra, Twilio, SIP/PSTN or product acceptance verdict. No
live provider acceptance bundle is included here, so all such results remain
`NOT_RUN` until actual credentialed live runs, audio evaluation, interruption and
soak evidence, privacy review, and human/product approval have completed.
