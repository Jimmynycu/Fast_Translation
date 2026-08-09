# Fast Translation

以繁體中文為主的 local-first English（en-US）與 Traditional Chinese（zh-TW）雙向即時翻譯 POC。一台 Windows operator PC 在同一個 LAN 上協調兩支手機瀏覽器；真人 session 只能使用已核准資料准入的 profile。受版控的 `manufacturing-poc` profile 則刻意限於 synthetic benchmark，不能用來建立真人房間。

目前可誠實宣稱的是 deterministic mechanism self-check：`pnpm benchmark` 會輸出 `MECHANISM_PASS` 與 `acceptanceVerdict: NOT_RUN`。keyless artifact 的 local mechanism observations 可為 **PASS**，但 local release evidence gate、OpenAI／Palabra provider acceptance、產品 acceptance 與 PSTN/SIP 都是 **NOT_RUN**。

## 已實作的邊界

- 兩支手機的音訊會正規化為 24 kHz、mono、PCM16LE、20 ms；A 只聽 B 的翻譯，B 只聽 A 的翻譯。
- 一個核准且雜湊釘選的 processing profile 決定 provider、可選 mode、服務端點／模型／voice、每項服務實際送出的 `dataCategories`、glossary egress、fallback、evidence、retention 與 consent policy。啟動時載入失敗即拒絕服務；不支援舊的 provider、mode、model 或 evidence 環境變數。
- `browser_pair` 是實際手機瀏覽器路徑。`fake_telephony` 僅是 in-process G.711 μ-law 機制 fixture，不是 SIP、PSTN、carrier 或電話號碼服務。
- 每個 session 有獨立的隨機 DEK；根金鑰只用來衍生包裝與 opaque archive identity。四個 evidence root 與 encrypted glossary root 都必須位於專用 `SECURITY_DATA_DIRECTORY` parent 下、分離且不得巢狀（loopback HTTP 預設 `./data`，remote HTTPS 必須是 cwd 外的絕對路徑）。
- 建立、錄音前檢查、arm、finalization、retention 與 export 都是受權限和完整性 gate 約束的流程；不能把一個失敗的 seal、未完成 session 或瀏覽器看到的 live event 當作可驗證 evidence。

## 快速啟動

需求：Windows、Node.js 24+、pnpm 11、兩支現代手機瀏覽器、可互通 LAN，以及兩支手機都信任的 HTTPS certificate。手機 flow 不可用 `localhost` 或 `127.0.0.1`。

```powershell
pnpm install --frozen-lockfile
pnpm build
Copy-Item .env.example .env
pnpm keygen
```

`pnpm keygen` 會印出要填入 `EVIDENCE_ROOT_KEY_BASE64` 的 canonical Base64 32-byte 值。它是本機 evidence root key，不是 provider API key；不能提交、分享或遺失。

範本預設指向受版控的 POC artifact [manufacturing-poc.json](profiles/manufacturing-poc.json)。`PROCESSING_PROFILE_SHA256` 必須與檔案內的 canonical profile body hash 完全相同，且只能使用小寫 64 位 SHA-256。不要以檔案的 byte hash 或自行改寫 profile 取代這個值。部署前可執行：

```powershell
pnpm processing-profile:validate -- --input .\profiles\manufacturing-poc.json
```

在 `.env` 設定網路、TLS、三組不同角色憑證、五個位於專用 `SECURITY_DATA_DIRECTORY` parent 下的不巢狀 storage root 與 profile pin：

```dotenv
HOST=0.0.0.0
PORT=4207
PUBLIC_BASE_URL=https://192.168.1.50:4207
TLS_CERT_PATH=./work/tmp/lan-tls/server-cert.pem
TLS_KEY_PATH=./work/tmp/lan-tls/server-key.pem

PROCESSING_PROFILE_PATH=./profiles/manufacturing-poc.json
PROCESSING_PROFILE_SHA256=48ccc7bd514c92c11d6d6e448fb714daf720b87891536d96efacc239e8948294
DEPLOYMENT_BUILD_SHA256=<sha256-of-exact-deployed-git-commit>

OPERATOR_TOKEN=<distinct-32-to-512-character-secret>
RETENTION_OWNER_ID=<retention-owner-identity>
RETENTION_OWNER_TOKEN=<different-32-to-512-character-secret>
EVIDENCE_REVIEWER_ID=<evidence-reviewer-identity>
EVIDENCE_REVIEWER_TOKEN=<third-32-to-512-character-secret>

MEDIA_PROFILE=browser_pair
ALLOW_INSECURE_LOOPBACK_DATA_BOUNDARY=false
SECURITY_DATA_DIRECTORY=C:/fast-translation-security
EVIDENCE_ARCHIVE_DIRECTORY=C:/fast-translation-security/evidence/archive
EVIDENCE_KEY_DIRECTORY=C:/fast-translation-security/evidence/keys
EVIDENCE_EXPORT_DIRECTORY=C:/fast-translation-security/evidence/exports
EVIDENCE_RECEIPT_DIRECTORY=C:/fast-translation-security/evidence/receipts
GLOSSARY_DIRECTORY=C:/fast-translation-security/glossaries
EVIDENCE_ROOT_KEY_BASE64=<output-from-pnpm-keygen>
```

`SECURITY_DATA_DIRECTORY` 與五個 root 必須是 deployment cwd 外的專用絕對目錄（HTTPS 啟用時）；loopback HTTP 開發可省略並使用預設 `./data`。Plaintext loopback HTTP 也必須將 `HOST` 設為 exact numeric `127.0.0.1`、`::1` 或 `[::1]`；wildcard/remote bind 會被拒絕。`0.0.0.0` 僅在 HTTPS `PUBLIC_BASE_URL` 下可用。Ancestor boundary checks 預設 fail-closed；只有 disposable loopback HTTP fixture 可明確設定 `ALLOW_INSECURE_LOOPBACK_DATA_BOUNDARY=true`，HTTPS 會拒絕這個 opt-out。`OPERATOR_TOKEN`、`RETENTION_OWNER_TOKEN` 與 `EVIDENCE_REVIEWER_TOKEN` 必須都不同；`RETENTION_OWNER_ID` 是 deployment-assigned data owner，`EVIDENCE_REVIEWER_ID` 是 deployment-assigned bilingual-reviewer role，兩個 identity 也必須不同。server 在每個 session 建立時凍結這一對 identity 作為 sealed evidence-review grant；「bilingual reviewer」是授權指派，不是系統對語言能力的驗證。未設定 operator token 時 process 會生成一個，但不會在 startup log 印出 access fragment；正式 demo 請明確設定它。

`DEPLOYMENT_BUILD_SHA256` 是明確、不可變、全小寫 64-hex 的 deployment identity；它不是 package version，也沒有 runtime fallback。請在**將要部署的乾淨 commit checkout** 中由完整 commit ID 產生並填入 `.env`：

```powershell
$deployedCommit = (git rev-parse --verify 'HEAD^{commit}').Trim()
if (git status --porcelain) { throw 'Deploy only a clean checkout of the exact commit.' }
$deploymentBuildSha256 = [Convert]::ToHexString(
  [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($deployedCommit))
).ToLowerInvariant()
"DEPLOYMENT_BUILD_SHA256=$deploymentBuildSha256"
```

Copy the emitted assignment into the deployed `.env`. The commit-derived identity is operator-only evidence metadata; it does not replace a release attestation or make a dirty local build claimable as that commit.

依 processing profile 的 selected provider 加入對應的 server-only credential：

```dotenv
# profile provider = openai_native 或 openai_controlled
OPENAI_API_KEY=<server-only-key>

# profile provider = palabra
PALABRA_API_KEY=<server-only-key>
```

profile 沒有選中的 credential 可以留白。兩種 key 都不能進入 browser JavaScript、QR link、participant URL、API payload 或 evidence。
受版控的 `manufacturing-poc` profile 選的是 `openai_controlled`，因此 server 啟動需要 `OPENAI_API_KEY`；但每個 service 的 `trainingUse` 與 `serviceRetention` 都是 `unverified`／`NOT_RUN`。因此 `GET /api/capabilities` 會顯示 `dataAdmission: "synthetic_only"`，而 `POST /api/sessions` 在建立 relay 或 participant grant 前以 422 `synthetic_only_profile` 拒絕。它只能用於 synthetic/keyless benchmark，不可執行本 README 的真人兩手機流程。

要執行真人 demo，需改用另一份已核准、完整驗證每個選用 service `trainingUse` 與 `serviceRetention` 的 immutable profile，加上該 profile 的 canonical SHA pin；沒有 client 或 operator override。

```powershell
pnpm start
```

Operator 只在 PC 上使用啟動 log 的 base URL 加上 `#access=<OPERATOR_TOKEN>`。不要把 operator URL 交給 participant；session response 另行產生 side-bound participant grants。

### LAN TLS helper

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\generate-lan-tls.ps1 `
  -OutputDirectory .\work\tmp\lan-tls `
  -DnsName fast-translation.local `
  -IpAddress 192.168.1.50
```

此 helper 只建立 workspace-local demo certificate。operator PC 與兩支手機必須信任它的 CA，並讓 certificate SAN、`PUBLIC_BASE_URL`、LAN DNS/IP 與 firewall 規則一致。

## Provider 與 mode

profile 是唯一的 provider route。它的 `translation.provider`、`allowedModes` 與 `defaultMode` 必須與 runtime capability table 相容；operator 只能在核准且 selectable 的 rows 中選擇。`GET /api/capabilities` 會回傳完整三列 `fast`、`balanced`、`accurate`，每列包含 behavior version、state、deterministic glossary 能力，以及在必要時的 reason。

| Profile provider | 必要的 server credential | Runtime mapping |
|---|---|---|
| `openai_native` | `OPENAI_API_KEY` | 一個 OpenAI managed realtime speech-to-speech service；`fast` 為 `native`，`balanced` 為 `locally_controlled`，`accurate` 是有原因的 `experimental` row，不能選。沒有 deterministic pinned glossary。 |
| `openai_controlled` | `OPENAI_API_KEY` | 三個 OpenAI services：transcription、text translation、TTS；`fast`、`balanced`、`accurate` 都為 `locally_controlled`。此 route 可依 profile 的 egress policy 使用 local pinned glossary。 |
| `palabra` | `PALABRA_API_KEY` | 一個 Palabra managed realtime speech-to-speech service；三種 mode 都為 `native`。transport input 固定映射為 320 ms chunks；Palabra account glossary 不等於 Harness 的 deterministic pinned glossary。 |

`dataCategories` 是 profile/manifest 雜湊綁定、依序列出的非秘密 egress 類別；它描述實際送給該 service 的資料，不是 vendor training、retention、region 或 DPA assurance。受版控的 controlled route 使用：

| Service role | Ordered `dataCategories` |
|---|---|
| transcription | `canonical_audio`, `source_language`, `source_terms`, `aliases` |
| text translation | `source_transcript`, `source_language`, `target_language`, `opaque_placeholders` |
| TTS | `authorized_target_text` |
| OpenAI native speech-to-speech | `canonical_audio`, `target_language` |
| Palabra speech-to-speech | `canonical_audio`, `source_language`, `target_language` |

`fast` 是 continuous commit／provisional revisions／無 holdback；`balanced` 是 continuous commit／final-only transcript／250 ms holdback；`accurate` 是 speech-end commit／final-only transcript／700 ms holdback。它們是 relay behavior，不是模型品質、延遲或語意正確率保證。

`experimental` 與 `unsupported` 永遠不可選，且一定附帶 reason。`fallback.kind` 只能是 profile-approved 的 `none` 或 `same_route_fail_open`，並且都要有 approval reference；sample 使用 `none`。這不允許自動跨 provider／route fallback。不要從 provider 名稱、mode 名稱或 provider account setting 推論 profile 沒有承諾的 region、training、service retention、DPA 或 glossary guarantee。

## 一個 session 的正確順序

1. 只有 `GET /api/capabilities` 顯示 `dataAdmission: "approved_poc_content"` 的 profile 可建立真人 `waiting` room；請求只包含固定的 English（en-US）與 Traditional Chinese（zh-TW）雙向語言組合、translation mode 與可選 glossary version，不包含 operator 代替 participant 的 consent。
2. 每位 participant 在自己的頁面閱讀 manifest-derived processing disclosure（僅 service id/provider/role/category/ordered `dataCategories`），確認 headphone self-attestation，接受 microphone audio 與 transcript 的 recording/processing，然後才按 **Start microphone**。browser 先送出該 side 的 consent，再要求麥克風／接上 media WebSocket。
3. 兩 side 都 consent 且連線，並回報 qualified browser readiness（`fake_telephony` 為 N/A）後，進入 **preflight → arm**：operator 執行 **Arm recorder**，evidence port 檢查可用空間、encrypted spool／metadata integrity、manifest binding 與四個 track。
4. arm 會持久化並 flush `source_a`、`source_b`、`playout_to_a`、`playout_to_b` 四個 encrypted logical-track proofs。provider prewarm 會在 `ready` 前自動執行，且兩個 direction 都必須有 truthful provider readiness；`translation_prepare_failed` 只會以 static-safe operator alert 顯示。
5. 只有通過 **consent → connect → preflight → arm → ready** 的 room 可 **Start session**；`start` 只做 `ready → active`，不會偷偷執行未完成的 preparation。
6. 任一 participant 可在自己的 side-bound page 撤回 consent。撤回是 terminal：relay 立刻走結束／finalization 路徑，不能恢復成 active。

當接收端在舊的翻譯 playout 中開始說話時，barge-in 只切掉該 destination 的舊 provisional generation；另一條 lane 繼續 capture。final event/evidence 不會因清除 provisional output 而被移除。

## Evidence Console 與安全投影

operator bearer 的 session/capabilities 視圖可顯示 `evidenceIdentity`（deployment build SHA、profile id/version/SHA、processing manifest SHA、services SHA）、recorder preflight、participant/provider readiness、truthful queue/lag、terminology 與 genuine barge lifecycle，以及 sanitized `evidenceFinalization`。participant 只會取得自己範圍的 session/media events，絕不取得 identity、preflight、finalization、path、archive ID、raw manifest 或 evidence reference。Evidence Console 是 live operation projection，不是 sealed-evidence review surface：`OPERATOR_TOKEN`、phone/participant grant 都不能讀 retention review、metadata review 或 review audio。

finalization 只會是已封存的 hashes/deadline/four-track digest 資訊，或 `FINALIZATION_FAILED` 加上 allowlisted failure/recovery code；後者阻擋 verdict。browser headphone 是 self-attestation，不是硬體驗證；provider readiness 也保留其真實語意，不能泛稱為已連上或已通過外部 provider assurance。

## Evidence、finalization 與 retention

所有 launched server 都使用 `SessionArtifactStore`，沒有可由環境變數選取的 in-memory／單檔舊 evidence 路徑。

- archive、wrapped-DEK sidecar、managed plaintext export、deletion/health receipt 與 encrypted glossary 分別放在四個 `EVIDENCE_*_DIRECTORY` 及 `GLOSSARY_DIRECTORY`；五個 root 必須位於 `SECURITY_DATA_DIRECTORY` 之下，並在設定時拒絕相同或巢狀路徑（包括 web static root）。Loopback HTTP 開發預設使用 `./data`；remote HTTPS 必須使用 deployment cwd 外的專用絕對 parent。
- 每 session 以隨機 32-byte DEK 加密 artifacts（AES-256-GCM）；DEK 以 root-derived wrapping key 包裝。archive identity、actor、reason、command 的 receipt 記錄使用 opaque HMAC，而不是 raw session ID 或 plaintext evidence。
- finalization 需產生、驗證並封存 session/processing-manifest-bound finalization manifest、encrypted ledger digest、chain digest、四個 track digest 和 retention deadline。`FINALIZATION_FAILED` 會記錄 recovery 指示，且不得 export 或被 benchmark 視為 local PASS。
- 預設保留期是 finalization 後 14 天；retention owner 可基於 UUID command ID、原因與 UTC deadline 延展**一次**，且絕不可超過 30 天。
- server startup 先 `recover()` 再 sweep；無法讀取或驗證 evidence root 的 fatal recovery failure 會在 serving 前 abort。可治理的 finalization failure 或 crash-orphan quarantine 則以 degraded health 啟動 restricted health/deletion service；其後每小時 sweep。到期資料要在 24 小時內刪除，degraded 時拒絕新增 session、延展與 export，但 owner 的刪除仍可用。
- early 或 scheduled delete 只接受 terminal sealed artifact，或已治理、隔離並帶有 recovery/quarantine directive 的 `FINALIZATION_FAILED` artifact；兩者都留下 content-free receipt：opaque actor/reason/command information、policy/profile/finalization/digest binding、延展審核與 verification-window 結果。刪除後不保留 conversation、encrypted evidence 或 plaintext export。
- sealed retention／metadata／audio review 有另外的 detached content-free audit chain。store 先驗證 opaque artifact 的 finalization/seal/chain/grant binding，再以 purpose-separated keys 寫入 encrypted、HMAC-authenticated entry：allowlisted action/outcome/role、HMACed actor、request-selection HMAC、response hash、timestamp 與 authenticated prior head；不含 transcript、audio、raw identity、session/archive ID、path 或 export location。成功回應只能在 audit durable commit 後送出；deletion receipt 會固定 audit head/count，故此 chain 在 evidence/key/export data 刪除後仍保留，且它證明 disclosure 被核准及提交，不證明收件者已閱聽內容。

Browser 可看到 live status、provisional transcript、glossary / alert / generation 事件；provisional provider events 不會進 durable evidence。已接受的 final provider-derived events 才寫入 encrypted evidence，連同內部 `evidenceRef`。被拒絕的 provider output 或 adapter diagnostic 只寫成 `translation_rejected` evidence record，不產生 browser-facing rejection event；server 也會從所有 browser payload 移除 evidence refs。

## Evidence governance APIs

所有 management route 都用 HTTP bearer token，不使用 operator access fragment：

| Role | Token / identity | Allowed operations |
|---|---|---|
| Operator | `OPERATOR_TOKEN` | 建立/控制 session、匯入 glossary、讀取 capability / session / health。 |
| Retention owner（data owner） | `RETENTION_OWNER_ID` + `RETENTION_OWNER_TOKEN` | 若 identity 符合該 session 的 frozen grant，可做 audited retention/metadata/audio review；retention-owner credential 亦是**唯一**可做一次延展、early delete、delete immutable glossary version 與受管 plaintext export 的 credential。 |
| Evidence reviewer（deployment-assigned bilingual reviewer） | `EVIDENCE_REVIEWER_ID` + `EVIDENCE_REVIEWER_TOKEN` | 若 identity 符合該 session 的 frozen grant，只可做 audited retention summary、metadata page 與 bounded audio-window review；不能建立 plaintext、延展、刪除或操作 glossary。 |

```text
POST   /api/sessions/:sessionId/evidence/review
POST   /api/sessions/:sessionId/evidence/review/audio-window
GET    /api/sessions/:sessionId/evidence/retention
POST   /api/sessions/:sessionId/evidence/retention/extensions
DELETE /api/sessions/:sessionId/evidence
POST   /api/sessions/:sessionId/evidence/exports
DELETE /api/glossaries/:version
```

每個 session 只有一個 server-built、不可由 client/operator 改寫的 `{ dataOwnerId, bilingualReviewerId }` grant；finalization 封存其 hash，而 grant identity 不會出現在 console、participant 或 review response。兩個 review bearer 都必須同時符合 role 與 frozen identity，否則不取得 session existence 或資料。所有 `/api/sessions/:sessionId/evidence/...` route 都送 `Cache-Control: no-store`，並拒絕 operator/phone/participant access。

`POST /api/sessions/:sessionId/evidence/review` 是 metadata page，strict body 為 `{ "cursor"?: "<opaque-canonical-cursor>", "pageSize"?: 1..100 }`；結果只有 sealed summary、authorized transcript/glossary-provenance/alert projections 與 opaque next cursor，不含 audio markers。`POST /api/sessions/:sessionId/evidence/review/audio-window` 是唯一 audio review route，strict body 為 `{ "track": "source_a|source_b|playout_to_a|playout_to_b", "startOffsetMs": <non-negative 20-ms-aligned integer>, "durationMs": <20-ms-aligned 20..30000> }`；audio 僅透過這個 route 回傳 bounded `audio/wav` 的 24 kHz mono PCM16LE window（最多 30 秒／1,440,044 bytes）與 opaque `x-evidence-audit-id`。不回 archive path、archive ID、raw manifest、evidence ref、export location 或 JSON conversation copy。`GET /api/sessions/:sessionId/evidence/retention` 同樣先完成 audit，只回 `{ status: "sealed", retentionDeadlineAt }`。若 retention/audit integrity 不健康或 audit 無法持久化，review fail closed，不送 metadata、WAV 或 retention summary。

延展 body 是 `{ "commandId": "<canonical-lowercase-uuid>", "reason": "…", "requestedDeadline": "<UTC ISO-8601 Z>" }`。evidence early-delete body 是 `{ "commandId": "<canonical-lowercase-uuid>", "reason": "…" }`。owner-only export body 是 `{ "commandId": "<canonical-lowercase-uuid>", "acknowledgePlaintextExport": true }`；缺少 acknowledgement 會被拒絕。export 成功只回傳 safe metadata（export ID、manifest / seal hashes、record count、track digest、deadline），不回傳 archive path、session/archive identity 或 conversation data；相同 command ID 是 retry 的唯一方法，改用同 ID 的不同命令會是 `409 idempotency_conflict`。

Glossary delete 也是 retention owner-only：`DELETE /api/glossaries/:version` 使用 strict `{ "commandId": "<canonical-lowercase-uuid>", "reason": "<trimmed 1..500 chars>" }`。server 自行決定 owner actor 和 request time；成功回傳的僅是 `{ status: "completed", deletionReceiptId, requestedAtMs, deletedAtMs }`。使用中的 glossary version 有 lease，刪除回 `409 glossary_active`；找不到回 `404 glossary_not_found`；不相同的 idempotent replay 回 `409 idempotency_conflict`。此操作不因 evidence retention health degraded 而失效。

Glossary artifact 只用既有 `EVIDENCE_ROOT_KEY_BASE64` 的 purpose-separated HKDF subkeys，沒有第二把 glossary key 或 fallback。每個 artifact 是 random-nonce/AAD AES-256-GCM 的 opaque `*.glossary.enc` envelope；POSIX 使用 owner-only root/files 與 fsync atomic encrypted-only write。server 對 `GLOSSARY_DIRECTORY` 持有生命週期 exclusive root lease；第二個 process、symlink/realpath 變動或不安全 root 均 fail closed。內容免費（content-free）的 whole-body HMAC receipt 與 tombstone 可跨 restart 保持 idempotency：completed version 不可 reacquire/reimport，但可以匯入新的 immutable version。legacy plaintext `<encoded-id>/<version>.json` 不會讀取或遷移；production 前請對舊 plaintext directory 依組織刪除程序安全處置，並使用 fresh/dedicated `GLOSSARY_DIRECTORY`。

### POC completion 的 encrypted master glossary 強制處置

每個 POC 的每個已匯入 immutable encrypted master glossary version 都必須在 **POC completion** 時刪除；這是 mandatory governance closeout，不是一般 session finalization、evidence retention sweep 或自動刪除。retention owner 必須完成下列 checklist：

1. 由 controlled import/session-manifest log 對帳受控 glossary import 與該 POC 的每個 immutable session manifest，列出所有 imported version；即使 version 從未被 session 使用也不可漏列。
2. 對清冊中的**每一個** version，以 retention-owner credential 呼叫 `DELETE /api/glossaries/:version`，提供 canonical lowercase UUID `commandId` 與 reason。
3. 把每一次成功的 content-free deletion receipt（receipt ID、status、timestamps）記入 POC closeout record，不記 glossary 內容。
4. 驗證每個列出的 version 都已由 tombstone/repository enforcement 阻止 reacquire 或 reimport，而不只是確認 encrypted artifact 不在目錄中。
5. 只要有任何 version 尚存、任何 delete 失敗（包括 `glossary_active`）、任何 receipt 缺漏，或無法證明不可 reacquire，POC closure 一律阻擋。先完成 terminal session/lease cleanup 後重試刪除，才可結案。

客戶若在 POC completion 前要求刪除，retention owner 仍必須立即走同一條**手動** owner-delete 路徑（待 active lease 釋放後），保留 content-free receipt，並在 closeout inventory 中核對它；沒有 auto-delete。legacy plaintext glossary root 不是相容或 recovery fallback：它不得讀取、遷移或保留供此 POC 使用，必須在啟用 fresh/dedicated encrypted `GLOSSARY_DIRECTORY` 前依組織刪除程序安全處置。

## Managed plaintext export 與 retention sweep

`evidence:export` 只是一個 authenticated owner HTTP client；plaintext export 永遠由 server 的 owner-only route 執行。retention-owner bearer token 只從 `EVIDENCE_OWNER_ACCESS_TOKEN` 環境注入，不放在 argv；它不接受 root key、`--local-admin`、managed root、archive ID 或自報 owner identity。server 由 bearer token 解析 retention-owner actor，並以 session 的 frozen data-owner grant 做授權檢查。

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

`evidence:export` 的 base URL 必須是 HTTPS；只有 exact `127.0.0.1` 或 `[::1]` loopback HTTP fixture 例外，`localhost` 與 remote HTTP 一律在發出 request 前拒絕。client 也會以 256 KiB response cap 和固定 request deadline bounded 地讀取 HTTP response。lower-case canonical UUID command ID 必須在 lost/uncertain output retry 時原樣重用；缺少或格式錯誤的 ID、token、base URL 或 acknowledgement 會在發出 request 前拒絕。成功只輸出 safe export metadata，不輸出 archive path、session content 或 bearer token；expired、authorization、conflict 與 server failure 都以 static error 失敗。`evidence:sweep` 不接受 command ID，也不會 export plaintext；它保留 offline `offline_admin` root lease，適合在 server 已停止並釋放 roots 時交給每小時 OS scheduler。若任何仍存活的其他 process 持有 root lease，sweep 會在 evidence I/O 前 fail closed：`Evidence root is leased by another process`。lease 沒有固定 expiry；只會在同一 host 的 OS 確認原 process 已死亡後回收。未知或跨 host lease 一律拒絕 administration。

## 驗證與判讀

```powershell
pnpm typecheck
pnpm test
pnpm test:browser
pnpm benchmark
```

`pnpm benchmark` 是 deterministic terminology mechanism self-check，stdout 為 `{ verdict: "MECHANISM_PASS", acceptanceVerdict: "NOT_RUN" }`。在 keyless artifact 中：`PASS` 是 sealed/valid evidence 的 local mechanism gate 通過；`FAIL` 是 valid-evidence 的 local functional gate 失敗；`INVALID_RUN` 是 malformed/non-opaque evidence reference 或 terminal finalization/manifest integrity failure，絕不能標成 `FAIL`；`NOT_RUN` 是刻意未執行的 scope/acceptance。預設 artifact 是 41 `PASS`、0 `FAIL`、0 `INVALID_RUN`、142 `NOT_RUN`。

local mechanism observations 可 PASS，但 local POC release evidence gate 是 **NOT_RUN**：target exact、zero regression 與 alerts clear 可通過，acoustic latency、acoustic barge-in 與 exported normalized-event/four-track-audio completeness 未執行。content-bound virtual receipt hashes 不代表 encrypted persistence、raw audio capture、four-track coverage 或 production evidence。受版控的 `manufacturing-poc` profile 也明確標記外部 vendor/data assurances 為 `NOT_RUN`；它不是 production approval。不要把 test、fixture、fake telephony、local replay 或 benchmark PASS 說成真實 OpenAI、Palabra、Twilio、SIP/PSTN 或人工產品 acceptance。

若 capabilities 顯示 `synthetic_only`，不要嘗試真人 session；以可驗證資料 assurance 的新核准 profile 替換 sample。若 health 顯示 `degraded`，先修復 evidence recovery/sweep，再開始新 session 或管理 export/retention extension。不要用刪檔、手動改 receipt、重用 token，或將 archive path 當作授權機制。
