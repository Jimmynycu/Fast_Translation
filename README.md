# Fast Translation Harness

以繁體中文為主的 local-first live translation POC：一台 Windows operator PC
執行中央 Harness，兩支手機瀏覽器加入同一個雙向翻譯房間。

> 狀態：browser media、keyless local evaluation、OpenAI adapters、Palabra
> `palabra_live` adapter、glossary control、encrypted evidence 與 benchmark
> tooling 均已實作。Repository tests 不等於 live provider acceptance；OpenAI、
> Palabra、PSTN/SIP 與人工產品驗收仍是 `NOT_RUN`。

## 這個 POC 做什麼

- 中央 Fastify Harness 管理 session、A→B/B→A routing、profiles、interruption
  fence、事件與 evidence。
- `browser_pair` 將瀏覽器麥克風正規化為 24 kHz、mono、PCM16LE、20 ms frames，
  兩支手機各自只播放對方 lane 的聲音。
- `fake_telephony` 是 provider-free 的 in-process test seam，不是 carrier、
  SIP/PSTN 或電話號碼服務。
- 所有 provider credential 留在 server；不會進入 QR、participant link、
  browser JavaScript 或 API response。

## 架構

```text
                         operator HTTPS UI / API / events
                                      |
                                      v
 Phone A mic + headphones <-> [ Central Fastify Harness PC ] <-> Phone B mic + headphones
                                  A_TO_B / B_TO_A lanes
                                      |
                         server-side OpenAI or Palabra (optional)
```

## 先備條件

- Windows operator PC：Node.js 24 or newer、pnpm 11（lockfile 以 pnpm 11.16.0
  產生）。
- 兩支目前仍受支援的手機瀏覽器，與 operator PC 位於可互通的同一 LAN。
- 兩位參與者各自使用 headphones，並取得錄音同意。
- 兩手機正式使用麥克風時，需信任與 `PUBLIC_BASE_URL` 的 hostname/IP 相符的
  HTTPS certificate；localhost PC smoke 可使用 HTTP。

## 安裝

在 Windows operator PC 的 PowerShell 執行：

```powershell
git clone https://github.com/Jimmynycu/Fast_Translation.git Fast_Translation
Set-Location .\Fast_Translation
corepack enable
corepack prepare pnpm@11.16.0 --activate
pnpm install --frozen-lockfile
```

若該 Node.js 24 安裝未提供 `corepack`，請改用已驗證的 pnpm 11，並確認
`pnpm --version` 至少為 11，再執行 `pnpm install --frozen-lockfile`。

## 5 分鐘 keyless PC/browser smoke

以下流程在 operator PC 上以兩個本機 participant browser tabs 驗證 UI、media、
session lifecycle 與 barge-in，不需要 OpenAI 或 Palabra key：

```powershell
Copy-Item .env.example .env
$env:PUBLIC_BASE_URL = "http://localhost:4207"
$env:TRANSLATION_PROFILE = "deterministic_test"
$env:EVIDENCE_PROFILE = "in_memory"
$env:OPENAI_API_KEY = ""
$env:PALABRA_API_KEY = ""
Remove-Item Env:EVIDENCE_KEY_BASE64 -ErrorAction SilentlyContinue
pnpm dev
```

`pnpm dev` 會先 build 一次，再 watch `dist` 的 JavaScript；它不會自動重新編譯
TypeScript source。開啟 startup log 印出的完整 `operatorUrl`（包含
`#access=...`），在兩個 browser tabs 開啟 Phone A/B links；兩邊都允許麥克風、
勾選 headphones 並按 **Start microphone**。等 dashboard 顯示 `2 / 2 joined` 與
`Ready` 後按 **Start session**，各說一句、在播放時插話測試 generation cut，最後
按 **End**。

`deterministic_test` 只證明 capture、routing、opposite-side playout、lifecycle
與 fencing；它不翻譯語言，也不證明 STT、TTS 或 translation quality。

## `.env` 與 translation profiles

`.env.example` 是模板；在 repository root 建立本機 `.env`：

```powershell
Copy-Item .env.example .env
```

`.env` 已被忽略，絕不要 commit。Provider keys 只放在 server process，不能放入
browser、QR 或公開 issue。

| Profile | 啟用條件 | 行為與限制 |
|---|---|---|
| `deterministic_test` | 無 key | deterministic audio/labels；不翻譯。 |
| `local_eval` | 無 key | 以 fixture transcript 驗證 glossary binding、alerts、playout；不評估 acoustic STT。 |
| `native_live_baseline` | `OPENAI_API_KEY` | OpenAI realtime speech translation；不保證 pinned glossary。 |
| `glossary_controlled` | `OPENAI_API_KEY` | OpenAI transcribe + text translation + TTS，配合 pinned glossary target authorization。 |
| `palabra_live` | `PALABRA_API_KEY` | Server-side Palabra streaming、controlled/per-utterance relay；本地 pinned glossary 不適用。 |

`deterministic_test` 與 `local_eval` 永遠註冊；OpenAI profiles 只有在
`OPENAI_API_KEY` 存在時註冊；`palabra_live` 只有在 `PALABRA_API_KEY` 存在時註冊。
選取缺少 credential 的 provider profile 會在 startup 失敗。`PALABRA_INPUT_CHUNK_MS`
預設 320，接受 20–320 間、20 的倍數。

重要 defaults：`HOST=0.0.0.0`、`PORT=4207`、`MEDIA_PROFILE=browser_pair`、
`TRANSLATION_PROFILE=glossary_controlled`、`EVIDENCE_PROFILE=encrypted_local`。
後兩者的預設組合需要 OpenAI key 與 32-byte evidence key；keyless smoke 已明確
覆寫它們。

## 兩手機 HTTPS/LAN 流程

1. 在 repository root 複製 `.env.example`，並以 operator PC 可達的 LAN IP 取代
   `192.168.1.50`：

   ```powershell
   Copy-Item .env.example .env
   powershell -ExecutionPolicy Bypass -File .\scripts\generate-lan-tls.ps1 `
     -OutputDirectory .\work\tmp\lan-tls `
     -DnsName fast-translation.local `
     -IpAddress 192.168.1.50
   ```

2. 在 operator PC 與兩支手機信任
   `./work/tmp/lan-tls/local-demo-ca.cer`。`server-cert.pem` 與尤其
   `server-key.pem` 僅供本機使用，不能提交。

3. 將 `.env` 的相關設定改成以下形式；`PUBLIC_BASE_URL` 必須是可達的 root
   `http(s)://host:port/` origin，不可有 subpath、credentials、query 或 fragment，
   並且 certificate SAN 必須匹配該 hostname/IP：

   ```dotenv
   HOST=0.0.0.0
   PORT=4207
   PUBLIC_BASE_URL=https://192.168.1.50:4207
   TLS_CERT_PATH=./work/tmp/lan-tls/server-cert.pem
   TLS_KEY_PATH=./work/tmp/lan-tls/server-key.pem
   MEDIA_PROFILE=browser_pair
   TRANSLATION_PROFILE=deterministic_test
   EVIDENCE_PROFILE=in_memory
   PALABRA_INPUT_CHUNK_MS=320
   OPENAI_API_KEY=
   PALABRA_API_KEY=
   ```

4. 啟動：

   ```powershell
   pnpm dev
   ```

   `pnpm dev` build 一次後 watch `dist`；修改 TypeScript 後請重新執行 build/dev。
   `pnpm start` 只啟動既有 `dist`，必須先執行 `pnpm build`。

5. 用設定好的 origin 檢查 health（預期 `status: ok`），並使用 startup log 印出的
   完整 `operatorUrl` 開啟 operator UI。裸的 `PUBLIC_BASE_URL` 沒有 operator
   access fragment，會被拒絕：

   ```powershell
   Invoke-RestMethod -Uri "https://192.168.1.50:4207/api/health"
   ```

6. Operator 在 UI 選兩種語言與已註冊的 profile，按 **Create translation room**，
   確認 recording consent。將 Phone A QR 給 A、Phone B QR 給 B；兩支手機各接
   headphones、允許麥克風、勾選 **I'm wearing headphones**、按 **Start microphone**。
   等 `2 / 2 joined` 與 `Ready` 後按 **Start session**。

7. A、B 各說話確認只播放到對方；播放中插話測試 barge-in/generation cut；結束時
   按 **End**，再關閉瀏覽器頁面。

## Provider examples

### OpenAI

只在 server 啟動的 PowerShell 設定 key；選 `glossary_controlled` 可使用本機
pinned glossary，選 `native_live_baseline` 則不接受 pinned glossary：

```powershell
$env:OPENAI_API_KEY = "<server-side OpenAI API key>"
$env:TRANSLATION_PROFILE = "glossary_controlled" # or native_live_baseline
$env:EVIDENCE_PROFILE = "in_memory"
$env:PALABRA_API_KEY = ""
pnpm dev
```

### Palabra

Palabra key 同樣只放 server；兩個 provider key 彼此獨立。Palabra account glossaries
不等同於本 Harness 的 pinned target-exact guarantee：

```powershell
$env:PALABRA_API_KEY = "<server-side Palabra API key>"
$env:PALABRA_INPUT_CHUNK_MS = "320"
$env:TRANSLATION_PROFILE = "palabra_live"
$env:EVIDENCE_PROFILE = "in_memory"
$env:OPENAI_API_KEY = ""
pnpm dev
```

目前沒有 live Palabra acceptance runner 或 provider evidence；不要把 fake-socket
tests 或 local PASS 報成 Palabra acceptance。

## Recording、evidence 與 glossary

- `EVIDENCE_PROFILE=in_memory` 不寫檔，適合 smoke，process 結束即消失。
- `EVIDENCE_PROFILE=encrypted_local` 需要 32-byte base64 `EVIDENCE_KEY_BASE64`。
  執行 `pnpm keygen`，把輸出的值放入本機 `.env`；遺失 key 將無法讀取既有 evidence。
- 授權 plaintext export 時，設定同一把 key 到
  `EVIDENCE_ENCRYPTION_KEY_BASE64`，並明確 acknowledge：

  ```powershell
  $env:EVIDENCE_ENCRYPTION_KEY_BASE64 = "<same 32-byte base64 key used for the evidence file>"
  pnpm evidence:export -- --input .\data\evidence\<session-hash>.evidence.jsonl.enc `
    --output-dir .\work\tmp\evidence-export --acknowledge-plaintext-export
  ```

  Exported events/WAV 是敏感 plaintext，請依 retention policy 處理。
- CSV 與 XLSX glossary 必須有欄位：

  ```text
  id,source,aliases,target_exact
  ```

  `aliases` 可用 JSON string array，或用 `|`、`;`、newline 分隔。只有
  `glossary_controlled` 與 `local_eval` 接受 pinned glossary；示例檔案見
  [`examples/manufacturing-glossary.csv`](examples/manufacturing-glossary.csv)。

## 常用 scripts

| Command | 用途 |
|---|---|
| `pnpm typecheck` | TypeScript strict typecheck，不輸出檔案。 |
| `pnpm test` | 編譯並執行全部 Node tests。 |
| `pnpm build` | 編譯 server/CLI 到 `dist`。 |
| `pnpm test:browser` | 真 browser harness；需 Chrome 與 `CHROME_PATH`（或 Windows default path）。 |
| `pnpm keygen` | 產生 32-byte evidence key。 |
| `pnpm local-eval:replay -- --manifest <path> --source-language en-US --target-language zh-TW --output <path>` | 重播 keyless fixture corpus。 |
| `pnpm benchmark -- protocol --output <path>` | 輸出 benchmark protocol；其他 subcommands 見 demo runbook。 |
| `pnpm evidence:export -- --input <encrypted-file> --output-dir <dir> --acknowledge-plaintext-export` | 驗證並匯出 encrypted evidence。 |

`dev`、`start`、`benchmark`、`evidence:export` 會由 Node 載入 repository-root
`.env`；直接執行 `node` 不會自動載入它。`local-eval:replay` 需要 flags，且不依賴
`.env`。

## Troubleshooting

- **Startup 說 profile unavailable / missing key**：檢查 `TRANSLATION_PROFILE` 與
  對應 `OPENAI_API_KEY`/`PALABRA_API_KEY`，修改後重啟。
- **Encrypted evidence 啟動失敗**：選 `in_memory`，或用 `pnpm keygen` 產生並設定
  32-byte `EVIDENCE_KEY_BASE64`。
- **Operator 401**：使用 startup log 的完整 `operatorUrl`（含 `#access=...`），
  不要開裸 root URL。
- **手機無法用麥克風**：使用 HTTPS、信任 `local-demo-ca.cer`、確認 certificate
  SAN 與 `PUBLIC_BASE_URL` 相符，並確認 `HOST=0.0.0.0`、LAN/firewall 可達。
- **不是 `2 / 2 joined` 或沒有 Ready**：A/B QR 不要對調；兩支手機都要完成
  headphones、mic permission 與 **Start microphone**。
- **Palabra session 拒絕 glossary version**：`palabra_live` 不支援本地 pinned
  glossary；改用 `glossary_controlled` 或 `local_eval`。

## 公開 repository 的安全與限制

- 不要提交 `.env`、API keys、`server-key.pem`、`work/tmp` artifacts、decrypted
  evidence 或任何 customer recording；公開貼文也不要貼 operator token。
- `deterministic_test`/`local_eval` 是 Harness/mechanism checks，不是翻譯、acoustic
  STT、TTS、forced alignment 或 human acceptance。所有 provider/product acceptance
  在沒有完成正式 run 前都保持 `NOT_RUN`。
- 本專案是 browser-to-browser central Harness POC，不是 PSTN/SIP/carrier service；
  任何真實錄音都需 participant consent 與合規 retention policy。

## 延伸文件

- [Demo runbook](docs/demo-runbook.md)：完整 Windows/LAN、evidence、glossary 與
  benchmark 操作。
- [Implementation architecture](docs/implementation-architecture.md)：核心模組、
  media seam、profiles、evidence 與限制。
- [Palabra API integration survey](docs/research/palabra-api-integration-survey.md)：
  官方 API/SDK 證據與本 adapter 的整合決策。
- [Palabra terminology research](docs/research/palabra-low-latency-terminology-deep-research.md)
  與 [realtime translation survey](docs/research/realtime-translation-competitive-survey.md)：
  研究輸入，不是 acceptance evidence。
- [Same-room benchmark protocol](docs/prototypes/same-room-benchmark-protocol.md)：
  歷史規劃 prototype，不代表目前 workload 結果。