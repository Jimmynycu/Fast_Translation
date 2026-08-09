# Palabra 公開技術深研：接近其延遲、但讓專有名詞可驗證

> 調查日期：2026-08-06（Asia/Taipei）
> 目標：先完成本機 input → output POC；延遲接近 Palabra（允許略慢），換取製造業關鍵術語的可控、可量測正確率；電話、Twilio、SIP 留在下一階段以 adapter 接入。
> 證據標記：**Official** 官方文件、**Public source** 公開原始碼、**Observed** 公開 playground／前端可見行為、**Vendor claim** 廠商宣稱、**Inference** 依公開證據推論、**Not public** 尚無公開證據。

> **?? POC ?????????????????** runtime ?????? placeholder ??????? fail open???? best-effort ????? alert ? log????????POC ????? `target_exact` ??? 100% gate??????????????????????????????????????????? Palabra ???????????????? `docs/implementation-architecture.md`?`docs/prototypes/same-room-benchmark-protocol.md` ? `docs/demo-runbook.md` ???

## 0. 執行結論

1. 無法從 Palabra 的公開 SDK 複製出其核心翻譯服務。公開的 JavaScript、Python、Java repositories 是連線、協議、裝置、音訊收送與事件處理 client；生產 ASR、翻譯、TTS、預測式演算法、權重與後端排程均未公開。
2. 可以合法重建它的**可觀察低延遲行為**：WebRTC／LiveKit 直送、預先建連、partial ASR／translation、短句切分、streaming TTS、直接播放遠端 audio track、有限 queue、auto-tempo，以及插話時 flush／丟棄 stale audio。
3. Palabra 公開 playground 目前用 **translate_partial_transcriptions: true**、0.7 秒 silence threshold 與 sentence splitter。這解釋了為何不必等完整句尾；0.7 秒是 segment finalization 條件，不等於固定增加 0.7 秒首音延遲。
4. OpenAI **gpt-realtime-translate** 是最低延遲基線：它在輸入仍持續時直接輸出翻譯音訊與 transcript delta；但目前沒有 custom prompt、glossary 或 pronunciation guide，因此不能單獨承諾關鍵術語零誤譯。
5. 建議產品主線是 **Selective-Commit Glossary Cascade**：所有一般文字照 partial 穩定前綴提早走；只有可能命中保護詞的短 span 多等約 120–350 ms，通過來源正規化、placeholder 翻譯、目標 exact assertion 與發音規則後才送 TTS。延遲代價被局部化，而不是讓整句等 final STT。
6. 驗收不採廠商的「<1 秒」行銷值，而採同一音源、裝置與網路下的相對門檻：一般語句 p50 不比 Palabra 慢超過 250 ms、p95 不超過 400 ms；含保護詞語句 p50 不慢超過 500 ms、p95 不超過 800 ms，同時 agreed corpus 的 critical-term source／target text 與 spoken output 必須 100% 通過。

## Annotation 1 — 私有後端與授權界線

使用者表示是 Palabra 員工但目前沒有 VPN。這仍不足以驗證對私有 repository、後端、模型權重或公司帳號的正式授權，因此本調查沒有嘗試繞過 VPN／登入／存取控制，也沒有取得或複製未公開程式碼。

可直接使用的範圍：

- Palabra 官方 GitHub 中明示 MIT 的 SDK，可在保留 copyright 與 license notice 的前提下使用、修改與散布。
- 公開文件、公開 API schema、公開 playground 與無需登入即可讀取的前端行為，可用於 interoperability 與 clean-room 需求分析；公開部署的 minified bundle 不因「可下載」就自動成為可複製的開源碼。
- 若之後把經公司批准的 repository checkout、source archive 或正式 access 放進 workspace，我可以再做授權範圍內的 code audit；在那之前只做公開來源與獨立實作。

## 1. Palabra 公開與未公開的 source code

截至調查日，本機以唯讀方式檢查了下列公開 snapshot：

| Repository | Snapshot／版本 | 授權 | 實際內容 | 能否重建核心模型 |
|---|---|---|---|---|
| [palabra-ai-python](https://github.com/PalabraAI/palabra-ai-python) | commit 01a7e1b2…（2026-08-03），package 2.1.0 | MIT | WebSocket／REST client、task builder、events、glossary／voice management、audio helpers | 否 |
| [palabra-ai-javascript](https://github.com/PalabraAI/palabra-ai-javascript) | commit d268021a…（2025-11-19），package 0.0.9 | MIT | Browser WebRTC／LiveKit client、pipeline config、playback 與 timing events | 否 |
| [palabra-ai-java](https://github.com/PalabraAI/palabra-ai-java) | public v1.0.0 | MIT | Java client、CLI、device／file adapters | 否 |
| [twilio-demo](https://github.com/PalabraAI/twilio-demo) | public alpha example | pyproject 宣告 MIT，但 repository 未見完整 LICENSE text | Twilio 8 kHz μ-law ↔ 24 kHz PCM bridge | 否；且不宜直接當 production code |

兩個主 SDK 的 dependencies 也支持上述結論：JavaScript 只有 LiveKit、event／merge 類 client dependencies；Python 只有 HTTP、WebSocket，加上可選 audio/device helpers，沒有模型 inference framework、權重或訓練碼。**Public source**

公開碼中最值得合法重用或獨立重做的是：

- prepareConnection 預熱 LiveKit signal path。
- WebRTC publish：DTX off、RED off、32 kbps、high priority。
- server 回來的 RemoteAudioTrack 直接 attach 播放，不再建立大型 application buffer。
- set_task live update、partial／final events、pipeline timing schema。
- WebSocket 320 ms pacing、stream health warnings、flush_task session control。
- glossary 的三層資料模型與 session-scoped IDs。

**Not public**：真正決定 Palabra 翻譯品質與速度的 ASR、predictive translation、TTS inference、模型權重、訓練資料／程式、服務拓樸與 scheduler 並未出現在這些 repositories。Palabra 官網稱其使用自有 proprietary LLM／models，這反而證實 SDK 不是核心後端。[Palabra product page](https://www.palabra.ai/voice-translation-api)

## 2. Palabra feature／spec survey

| 能力 | 公開規格 | 證據層級 | 對本案的意義 |
|---|---|---|---|
| Speech-to-speech pipeline | ASR → translation → TTS，串流輸出翻譯音訊 | Official | 不是單一模型 API，而是完整媒體 pipeline |
| Transport | Client/browser/mobile 用 WebRTC＋LiveKit；server 用 WebSocket | Official | 本機先 WebRTC；電話後換 media adapter |
| Two-way | 產品明載 two-way；每 session 只有一條 input track | Official＋Inference | 真 full duplex 應建立 A→B、B→A 兩條獨立 lane/session |
| Partial ASR／translation | 可回 partial transcription；可選翻譯未確認 partial | Official | 首音不必等句尾，但會增加 revision／wrong-start 風險 |
| Sentence splitter | 長句拆成小段以加速；文件承認可能輕微改寫 | Official | 降延遲有效，但 critical terms 必須另做 gate |
| Silence threshold | 0.3–2.0 秒，預設 0.7，建議 0.5–0.9 | Official | 影響 finalization；不等同首音固定延遲 |
| Translation queue | desired/max backlog、auto-tempo、drop older audio | Official | 避免 lag 無限累積；5,000 ms 是 backlog target，不是 startup wait |
| Barge-in | flush_task 取消 current phrase 的 ASR、翻譯與 speech | Official | 還要 client 清 playout queue；已到 sound device 的音訊無法收回 |
| Glossary | asr_hot、asr、translation 三種 | Official＋Public source | 最值得複製的產品邏輯 |
| Voice | fixed/default voices、timbre selection、experimental cloning | Official | POC 優先固定 voice；先保術語與延遲 |
| Auto language／multi-target | 自動偵測、conditional routing、同時多目標 | Official | 首版固定 source/target，避免把 experimental detection 加入風險 |
| Diagnostics | partial/final events、chunk_generation_delta、pipeline timings | Official＋Public source | 應照做 stage-level telemetry，不只量總平均 |
| Formats | WS input Opus/PCM16/WAV、16–48 kHz；output 24 kHz mono PCM16/zlib | Official | canonical internal audio 建議 24 kHz PCM16 mono |
| Latency | S2S <1s；TTS P90 約 35 ms（不含 network） | Vendor claim | 不能當 POC 保證；S2S 與 standalone TTS 不可混為一談 |
| Deployment/privacy | cloud、private cloud/on-prem、zero retention、99.9% SLA | Vendor claim | 商務評估項；需合約、DPA 與實測確認 |

主要官方來源：[Streaming API](https://docs.palabra.ai/docs/streaming_api)、[translation settings](https://docs.palabra.ai/docs/streaming_api/translation_settings_breakdown)、[management API](https://docs.palabra.ai/docs/streaming_api/management)、[publishing/receiving audio](https://docs.palabra.ai/docs/streaming_api/publishing_and_receiving_audio)、[product/API page](https://www.palabra.ai/voice-translation-api)。

目前公開價格頁列 S2S US$0.04／分鐘、新帳號 US$50 credits、每帳號 10 concurrent sessions。若 full-duplex call 需要兩條 session，可先用「約五通並行」作容量假設，但計費與 concurrency 定義仍需向 Palabra 書面確認。[Palabra pricing](https://www.palabra.ai/pricing)

## 3. 公開 playground 與 client 的實際低延遲路徑

2026-08-06 檢查 [Palabra public realtime S2S playground](https://platform.palabra.ai/iframe/playground/realtime-sts?debug=1) 的可見 API Config，目前為：

~~~json
{
  "input_stream": { "source": { "type": "webrtc" } },
  "output_stream": { "target": { "type": "webrtc" } },
  "pipeline": {
    "transcription": {
      "source_language": "en",
      "segment_confirmation_silence_threshold": 0.7,
      "sentence_splitter": { "enabled": true },
      "verification": { "auto_transcription_correction": false }
    },
    "translations": [{
      "target_language": "es",
      "translate_partial_transcriptions": true,
      "speech_generation": { "voice_cloning": false, "voice_id": "default_low" }
    }],
    "translation_queue_configs": {
      "global": {
        "desired_queue_level_ms": 5000,
        "max_queue_level_ms": 20000,
        "auto_tempo": true,
        "min_tempo": 1.15,
        "max_tempo": 1.45
      }
    }
  }
}
~~~

有一個重要差異：官方 generic recommended config 的 translate_partial_transcriptions 是 false，但目前 public playground 是 true。[Recommended settings](https://docs.palabra.ai/docs/streaming_api/recommended_settings) 因此使用者感受到的近乎即時效果，最可能是 playground 的 aggressive partial profile，而不是保守 default。

公開 JS SDK 顯示的 browser path：

~~~text
create streaming session
  → construct LiveKit Room
  → prepareConnection(url, token)
  → connect + autoSubscribe
  → publish microphone (DTX off, RED off, 32 kbps, high priority)
  → set_task over data channel
  → receive RemoteAudioTrack
  → attach track directly for playback
~~~

**Observed**：debug playground 會顯示 partial、translated、validated event 的時間序列並可匯出 JSON；本輪沒有啟動麥克風，因此沒有偽造「實測 Palabra p50/p95」。實際 benchmark 應用固定 prerecorded corpus 透過 virtual input 重複至少 30 次，並由外部 loopback 記錄 translated audio onset。

## 4. 為什麼它看起來幾乎沒有延遲

| 機制 | 公開證據 | 如何省時間 | 我們是否照做 |
|---|---|---|---|
| WebRTC／LiveKit media track | docs、JS SDK | 避免 browser app 自己 base64、pacing、decode 大包音訊 | 是；local profile 直接 WebRTC |
| Connection prewarm | JS SDK prepareConnection | 使用者開始前先做 signal/DNS/TLS/ICE 的一部分 | 是 |
| Partial translation | playground true | ASR 未 final 就開始 MT | 是，但只 commit stable prefix |
| Sentence splitting | playground／docs | 長句拆短，提早送 TTS | 是；保護詞 span 不可被拆斷 |
| Streaming TTS | output chunks；Palabra TTS 宣稱 2–3 words 啟動 | 不等完整句子／完整 waveform | 是；provider bake-off |
| Direct remote-track playout | JS SDK RemoteAudioTrack.attach | 少一層應用 buffer／轉碼 | 是 |
| Queue＋auto-tempo | docs | backlog 過大時加速或 drop，避免 lag 越積越多 | 是；上限要比 broadcast profile 更緊 |
| Explicit source language | recommended config | 省掉 auto-detection 並降低切換錯誤 | 是 |
| Predictive pair models／own full stack | Palabra product page | 廠商稱可依語言對預測並最佳化 | Vendor claim，無法驗證或複製 |
| Regional/private deployment | Palabra product page | 減少 network hop | 視商務；POC 先選最近 region |

因此「幾乎零延遲」不是某一個可下載的 model name，而是**提早工作、提早 commit、提早播放**。我們要複製的是 timing decisions，而不是猜測 Palabra 的私有權重。

## 5. Palabra 的三層 glossary，以及它還沒有證明什麼

Palabra 官方 API 允許三種 glossary type：[Create glossary API](https://docs.palabra.ai/api/create-a-new-glossary)、[Glossary guide](https://docs.palabra.ai/docs/glossaries)。

1. **asr_hot／SDK hotwords**
   - 一列一個 term。
   - 讓 ASR 特別注意罕見字、品牌、縮寫。
   - 是 bias，不應當作 deterministic guarantee。
2. **asr／SDK verification**
   - 同語言的 recognized form → canonical form。
   - 用於 post-ASR replacement，例如常見近音誤辨識統一成核准拼法。
3. **translation**
   - canonical source → approved target。
   - 用於指定產品名、機台名與技術詞的唯一譯法；不翻譯品牌可做 identity mapping。

Python SDK 2.1.0 又提供 session-level hotwords_glossaries、verification_glossaries、translation_glossaries，可指定 exact glossary IDs；這比依賴「帳號所有 enabled glossary」更可重現。**Public source**

但是 **Not public**：Palabra 沒公開 exact-match 邊界、大小寫／標點／詞形、重疊詞優先序、衝突處理、phoneme 規則、命中率 SLA 或多口音 benchmark。官網「exactly as defined」仍是產品承諾，不是形式化證明。POC 必須分別量：

- spoken source → ASR canonical exact match；
- canonical source → target approved form exact match；
- target text → spoken pronunciation reviewer pass。

## 6. OpenAI GPT Live／Realtime 能力與硬限制

### 6.1 gpt-realtime-translate：最低延遲基線

OpenAI 官方說明此模型針對 live interpretation 訓練，可在來源音訊仍持續時同時輸出 translated audio 與 transcript delta；使用專用 /v1/realtime/translations endpoint，沒有一般 assistant 的 response.create turn lifecycle。[Realtime Translation guide](https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide)、[model page](https://developers.openai.com/api/docs/models/gpt-realtime-translate)

- Browser/client media：WebRTC，翻譯音訊以 remote track 回傳。
- Server/telephony：WebSocket。
- WS input：24 kHz PCM16 mono，持續傳音訊與 silence。
- Output：200 ms PCM16 chunks，加 target transcript delta。
- 目前 70+ input、13 target languages。
- 不支援 custom prompting、glossary、pronunciation guide 或固定 voice。

結論：它是 native_live benchmark 與一般語句低延遲參考，但不能作為 critical-term hard guarantee。

### 6.2 gpt-live-transcribe：術語偵測的 streaming STT

官方 model page 明載它提供低延遲 transcript deltas、tunable latency、unstructured context、keyword hints 與多語言 hints。[GPT Live Transcribe](https://developers.openai.com/api/docs/models/gpt-live-transcribe)

它適合作為 term_guarded 的第一段或 native path 的 shadow evaluator；但 keyword 仍是 hint，真正 hard guarantee 必須由本地 canonicalizer／validator 完成。

### 6.3 gpt-realtime-2.1：不是預設翻譯主路徑

它是通用 realtime voice agent，instruction following、alphanumeric recognition、silence/noise 與 interruption 行為更強，但 OpenAI 對「人類彼此翻譯」仍建議專用 gpt-realtime-translate。[GPT Realtime 2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)

可將 2.1 當 promptable translator 實驗組；風險是 turn-based 行為、可能回答內容而不是純翻譯，且 glossary 不能在已生成音訊前作我們自己的 exact assertion。

## 7. 其他能接近 Palabra 延遲的方法

所有廠商毫秒數都使用不同口徑；下表只用來決定 A/B 候選，不可直接當端到端承諾。

| Stack／元件 | 公開能力 | 術語控制 | 判斷 |
|---|---|---|---|
| Deepgram Nova-3 STT | streaming；官方估計 partial 約 150–300 ms | keyterm prompting＋Find/Replace；支援 zh-TW／zh-Hant | 最值得和 GPT Live Transcribe 對照 |
| Cartesia Sonic 3.5 TTS | vendor claim sub-90 ms | phrase、IPA、sounds-like pronunciation dictionary；支援中文 | 術語發音控制最完整的 TTS 候選 |
| ElevenLabs Scribe＋Flash 2.5 | vendor claim 約 150 ms partial／75 ms inference | STT keyterms；TTS alias pronunciation | 與現有系統最容易接；仍需本地 commit gate |
| Azure Speech | streaming STT/TTS | Phrase List、SSML、PLS lexicon，原生 zh-TW | 台灣區域候選；延遲需實測 |
| NVIDIA Speech NIM／Riva | streaming ASR → NMT → TTS；zh-TW | ASR hotwords/OOV；NMT source##target 強制翻譯與 DNT | 最完整的商業自部署對照；需 NVIDIA 授權／GPU |
| WeNet／sherpa-onnx＋M2M-100＋CosyVoice3 | ASR/TTS 串流，MT 用增量短句 | 可完全自建 deterministic gate | 最自主；整鏈工程量與 GPU 風險最高 |
| Meta SeamlessStreaming | true simultaneous S2ST，官方約 2 秒 | 無成熟 glossary | 權重 CC-BY-NC；只作研究基準，不進商業產品 |

Primary sources：[Deepgram Keyterm](https://developers.deepgram.com/docs/keyterm)、[Deepgram Find/Replace](https://developers.deepgram.com/docs/find-and-replace)、[Cartesia custom pronunciation](https://docs.cartesia.ai/build-with-cartesia/capability-guides/custom-pronunciations)、[Cartesia Sonic](https://docs.cartesia.ai/build-with-cartesia/tts-models/latest)、[ElevenLabs keyterms](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/batch/keyterm-prompting)、[NVIDIA Speech Translation](https://docs.nvidia.com/nim/speech/latest/nmt/speech-to-speech-translation.html)、[NVIDIA dictionaries](https://docs.nvidia.com/nim/speech/latest/nmt/custom-dictionaries.html)、[WeNet](https://github.com/wenet-e2e/wenet)、[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)、[CosyVoice](https://github.com/QwenAudio/CosyVoice)、[Meta Seamless](https://github.com/facebookresearch/seamless_communication)。

推薦 bake-off：

1. **OpenAI native**：gpt-realtime-translate，建立最低延遲 floor。
2. **OpenAI controlled**：gpt-live-transcribe → local glossary gate → text MT → streaming TTS。
3. **Best-of-breed controlled**：Deepgram Nova-3 → same local glossary gate → Cartesia Sonic 3.5。
4. 若 on-prem／資料控制成為硬條件，再測 NVIDIA NIM；OSS chain 留作中長期成本與自主性對照。

## 8. Design-it-twice：三種產品架構

| Design | 資料流 | 首音延遲 | 術語保證 | 複雜度 | 判斷 |
|---|---|---:|---|---:|---|
| A. Native S2S | media → gpt-realtime-translate → playout | 最低 | 無 hard guarantee | 低 | 必做 baseline，不作最終術語方案 |
| B. Full glossary cascade | streaming STT → normalize → text MT → validate → streaming TTS | 較慢 | 可在 TTS 前 fail-closed | 中 | 可交付、最容易驗收 |
| C. Selective-commit cascade | stable partials；一般 span 早送，保護詞 span 局部 hold／assert | 接近 B，但術語外更快 | 可 hard-gate | 中高 | **推薦 production POC** |

不推薦以 native S2S 音訊為前景、事後用 shadow STT「修正」已播放術語。人的耳朵已經聽到錯字後，字幕修正或下一句補救不等於正確；要保證就必須在 TTS commit 前攔住。

## 9. 推薦模組化 system design

~~~mermaid
flowchart LR
    A["MediaIngress<br/>local WebRTC | Twilio | SIP"] --> B["AudioNormalizer<br/>20 ms PCM frames"]
    B --> C["DuplexSession<br/>A→B / B→A lanes"]
    C --> D{"TranslationProfile"}
    D -->|native_live| E["GPT Realtime Translate"]
    D -->|term_guarded| F["Live STT"]
    F --> G["StablePrefixAssembler"]
    G --> H["TerminologyGuard<br/>alias + phonetic + trie"]
    H --> I["Incremental MT<br/>opaque term IDs"]
    I --> J["Exact Target Validator"]
    J --> K["Streaming TTS<br/>lexicon / cached term audio"]
    E --> L["Generation-aware Playout"]
    K --> L
    L --> M["MediaEgress<br/>local speaker | Twilio | SIP"]
    C --> N["Metrics + Replay Harness"]
~~~

### 9.1 Deep module boundaries

~~~ts
interface MediaPort {
  frames(): AsyncIterable<AudioFrame>;
  play(chunks: AsyncIterable<PlayoutChunk>, signal: AbortSignal): Promise<void>;
  clear(generation: number): Promise<void>;
}

interface TranslationPort {
  translate(frames: AsyncIterable<AudioFrame>, ctx: LaneContext):
    AsyncIterable<TranslationEvent>;
  cancel(generation: number): Promise<void>;
}

interface TerminologyGuard {
  observe(partial: TranscriptRevision): CommitDecision[];
  validate(target: TargetChunk): ValidatedTarget | BlockedTarget;
}

interface PlayoutPort {
  enqueue(chunk: PlayoutChunk): void;
  cut(generation: number): void;
}
~~~

核心 invariants：

- A→B 與 B→A 各自有 session、clock、sequence、bounded queue、generation fence 與 metrics。
- canonical internal audio 為 20 ms PCM16 mono frames；provider adapter 可聚合成 OpenAI／Palabra 所需格式，不把 provider chunk size 洩漏到 core。
- cut generation N 後，所有舊 generation 的 late audio 永遠不得播放。
- queue 超過 latency budget 時丟 stale audio，不用無限 buffer 假裝可靠。
- metrics、logging、caption UI 都不能阻塞 media loop。

### 9.2 Post-research implementation: approved profile and session contract

The former provider/mode environment setup was a research sketch, not a
supported runtime route. Deployment now supplies an approved profile location
and canonical pin (`PROCESSING_PROFILE_PATH` and
`PROCESSING_PROFILE_SHA256`). The loader verifies the canonical profile-body
SHA before accepting an `ApprovedSessionProcessingProfile`.

The approved profile pins the provider, default mode, allowed modes, service
endpoints, model identifiers, voice, and the accompanying glossary egress,
fallback, evidence, retention, consent, and assurance controls. At session
creation, the only translation choice is a mode contained in that profile's
`allowedModes`; the resulting manifest records both the selected mode and the
profile identity. A session cannot change provider, endpoint, model, voice, or
profile route at runtime, and there is no profile-name or legacy environment
variable compatibility path. A glossary can be attached only when the approved
profile and selected mode pass the implemented glossary policy checks.

The runtime additionally pins each service's ordered `dataCategories` in the
manifest and exposes only that safe projection before consent. It treats
unverified selected-service `trainingUse` or `serviceRetention` as
`synthetic_only`: human session creation is refused before relay/grant. The
checked-in `manufacturing-poc` profile deliberately has this restriction, so
its `NOT_RUN` assurances are not evidence of Palabra/OpenAI terms or product
acceptance. Profile fallback is only `none` or approved `same_route_fail_open`,
never a cross-provider automatic substitute.

Harness glossary persistence is separate from a provider's account glossary:
it is encrypted using purpose-separated subkeys of `EVIDENCE_ROOT_KEY_BASE64`.
An owner may delete only an unleased immutable version with an idempotent UUID
command and bounded reason; deletion leaves a signed content-free tombstone,
blocks resurrection of that version, and never reads/migrates legacy plaintext
glossary files.

The implemented sealed-evidence review boundary is also provider-independent.
Deployment assigns distinct data-owner and bilingual-reviewer identities; the
server freezes them into each session grant, and only the matching bearer can
make the audited metadata `POST /api/sessions/:sessionId/evidence/review`, the
bounded 20 ms-aligned 24 kHz mono WAV `POST /api/sessions/:sessionId/evidence/review/audio-window`,
or the audited retention-summary request. These responses are `no-store` and
contain no archive path/ID, raw manifest, or evidence reference. An encrypted,
content-free authenticated audit chain is detached from the evidence and remains
after deletion; it does not establish any Palabra/OpenAI privacy, retention, or
product assurance. The reference POC stays synthetic-only/`NOT_RUN`, and its
mandatory owner-led encrypted-master-glossary closeout remains required.

DuplexSession、TerminologyGuard、TranslationPort 與驗收 harness retain these
provider-independent boundaries. Phone-media material (Twilio/SIP 8 kHz
μ-law/A-law、RTP、call SID) remains research for a future adapter. The current
`fake_telephony` path is only an in-process G.711 μ-law fixture using
`fake-telephony://` addresses; it neither provisions a number nor connects to
Twilio, SIP, PSTN, or a carrier, and must not be treated as phone acceptance.

## 10. Selective Commit：怎麼做到「稍慢，但專有名詞完全可控」

### 10.1 Glossary schema

每個 term 不只存 source/target 兩欄：

~~~text
term_id
source_language
source_canonical
source_aliases[]
source_phonetic_aliases[]
target_language
target_exact
target_pronunciation
criticality
case_policy
allow_inflection
~~~

編譯成四個 runtime artifacts：STT keyword hints、source alias trie／phonetic matcher、source→opaque term-ID map、TTS pronunciation lexicon／audio cache。

### 10.2 Partial transcript 穩定前綴

- 不因一個 partial 就播放；比較連續 revisions，只 commit 重複出現的 stable prefix。
- 一般詞可在 2 次一致或約 80–160 ms 穩定後前進。
- 若尾端是任何保護詞的可能 prefix，僅 hold 該 span 約 120–350 ms；其前面的普通文字仍可進 MT/TTS。
- 多字詞用 longest-match；重疊詞與衝突在 glossary build 時即拒絕，而不是 production 隨機挑一個。

### 10.3 Opaque placeholder translation

來源：

    Please inspect the Abel Ng torque controller.

送 MT 前：

    Please inspect ⟦TERM_0042⟧.

MT output 必須仍包含且只包含一次 TERM_0042；再以 approved target 替回。placeholder 遺失、重複或次序錯誤就 fail closed：不送 TTS，對該 micro-clause 快速 retry／fallback。

### 10.4 TTS 前 exact assertion 與發音

- critical term 的 target text 必須 normalized exact match 核准型態。
- provider 有 pronunciation dictionary／SSML 時由 adapter 套用。
- 若某詞仍常念錯，可用固定 production voice 預先合成並審核 term audio atom；runtime 在 segment boundary 使用 cache。這會犧牲少量韻律自然度，但可把術語發音變成版本化資產。
- Dynamic voice cloning 與「每個 critical term 都可重現」互相衝突；POC 先用固定 voice。

### 10.5 「100%」可承諾的正確說法

不能對世界上任何口音、噪音與未收錄詞宣稱無條件 100%。可以承諾：

- agreed glossary + pronunciation variants + test corpus 中，critical terms source canonical、target text、spoken reviewer 三層各自 100%；
- runtime 對已偵測的 critical term 採 fail-closed，未通過 exact validator 就不播放錯誤版本；
- 未偵測 miss、低信心與 timeout 必須獨立報表，不能藏在一般 BLEU／WER 平均值裡。

## 11. Latency engineering budget 與成功門檻

下表是工程 budget，不是 provider guarantee；各階段部分重疊，不能直接把最大值相加當實際延遲。

| Stage | 一般 span budget | 保護詞額外 budget | 做法 |
|---|---:|---:|---|
| Capture＋DSP | 10–30 ms | 0 | AudioWorklet／native callback；AEC/NS 不超過一 frame |
| Edge transport／jitter | 40–120 ms | 0 | WebRTC；最近 region；bounded adaptive buffer |
| STT first stable prefix | 150–350 ms | 0–150 ms | keywords＋固定 source language＋revision stability |
| Terminology decision | 0–80 ms | 120–350 ms | trie/phonetic candidate only holds local span |
| Incremental MT first chunk | 80–250 ms | 0–100 ms retry reserve | warm session；short micro-clauses；opaque IDs |
| TTS first audio | 50–250 ms | 0–100 ms | streaming input/output；warm connection；term cache |
| Playout buffer | 60–160 ms | 0 | generation-aware bounded queue |

### 同場相對門檻

用同一 prerecorded 音源、virtual microphone、輸出 loopback、裝置與網路比較 Palabra public playground、OpenAI native 與本產品 term-guarded：

| Metric | 建議 POC gate |
|---|---|
| Ordinary speech onset → first semantically aligned audio | p50 ≤ Palabra +250 ms；p95 ≤ Palabra +400 ms |
| Protected-term speech onset → first aligned audio | p50 ≤ Palabra +500 ms；p95 ≤ Palabra +800 ms；absolute p95 起始上限 2.0 s |
| Stable source text → first playable term-guarded audio | p50 目標 650–900 ms；p95 1.2–1.6 s |
| Steady-state lag | p95 ≤ 2.0 s；不得隨通話時間持續成長 |
| Critical source canonical exact match | 100% agreed corpus |
| Critical target exact approved form | 100% agreed corpus |
| Critical spoken pronunciation | 100% bilingual reviewer pass |
| Wrong committed critical term | 0；validator 不通過即 fail-closed |

每次 run 記錄：capture onset → post-DSP → provider send → first/stable transcript → MT first token → term validation → TTS first byte → first decoded sample → device playout，報 p50/p95/p99，不只平均。

## 12. Full duplex 與 barge-in

Palabra 的 flush_task 會取消 current phrase 的 transcription、translation 與 speech，官方直接把「對方插話」列為用途。[Management API](https://docs.palabra.ai/docs/streaming_api/management) 公開 playground 的 Stop 是 session teardown，不等於 barge-in 測試。

我們的插話不能只依賴 provider：

1. 接收方 local VAD 偵測 speech_start。
2. 當下增加 opposite lane 的 generation。
3. 同步執行 speaker duck/mute、清 application playout queue。
4. provider 支援時送 cancel/flush；不支援時繼續收，但 generation fence 丟棄 late chunks。
5. 新 generation 的 translation lane 不等待舊 generation 關閉。

建議 gate：

- speech onset → local mute/clear command p95 ≤100 ms；
- speech onset → speaker 實際停止 stale audio p95 ≤150 ms，hard ceiling 250 ms；
- generation cut 後播放的舊 chunk 數量為 0；
- 2 秒 overlap 後兩方向都在 1 秒內恢復有效輸出；
- headset 先驗證功能，再以 speaker mode 測 AEC／echo-only false turns。

## 13. Local-first POC 與 A/B 實驗

### Phase 0 — deterministic corpus

- 客戶提供 50–100 個製造 critical terms，含 approved translations、常見誤辨識、口語變體、發音、大小寫與不可翻譯品牌。
- 建 100–200 句 corpus：短句、長複句、數字、料號、單位、否定、近音、多字詞、code-switch、200/500/900 ms 人工停頓。
- 每語言至少 3 位 speaker；clean、far-field noise、8 kHz μ-law 三套 fixture。

### Phase 1 — WAV-in/WAV-out

- 同一 input 依序跑 native_live、term_guarded_selective、Palabra benchmark。
- 先驗證 source text、target text、audio artifact 與 timestamp；不讓麥克風／喇叭變異掩蓋模型問題。
- A/B：partial on/off、stable window、term hold 120/200/350 ms、sentence split、TTS provider、fixed voice／pronunciation cache。

### Phase 2 — 本機 live

- Browser microphone → local edge → selected speaker/headset。
- Dashboard 同時顯示 live captions、term candidate／commit、exact validator、first-audio latency、queue depth、generation cuts。
- 真雙向用兩台 browser devices 或兩組獨立 headset；單 laptop mic→speaker loop 不能證明 routing/full duplex。

### Phase 3 — 只建立 phone adapter contract，暫不接號碼

- 以 fake adapter 與 8 kHz μ-law fixture 驗證 resample、sequence、clear、hangup/reconnect。
- 本機 quality／latency／barge-in gate 通過後，才接 Twilio Media Streams 或 SIP；真人直接接聽、無 AI greeting、無 IVR、無來電者安裝。

### Palabra 可重現 benchmark

使用 [debug playground](https://platform.palabra.ai/iframe/playground/realtime-sts?debug=1)，固定 virtual audio input，外部錄 output loopback，每個 condition 至少 30 次：

- silence threshold 0.3／0.5／0.7／0.9；
- partial translation on/off；
- sentence splitter on/off；
- queue 2,000 vs 5,000 ms（量 steady-state backlog，不把它誤稱 startup buffer）；
- headphones/speaker echo path；
- API key 可用後再測 flush_task stale-audio duration。

## 14. 風險與決策

| 風險 | 判斷與緩解 |
|---|---|
| Direct GPT translation 無 glossary | 只作 latency baseline；critical path 走 selective cascade |
| Partial ASR revision 導致早播錯詞 | stable-prefix＋term-prefix hold＋TTS pre-commit barrier |
| 關鍵詞漏偵測 | STT keywords＋alias trie＋phonetic/KWS shadow；miss 另列，不用平均掩蓋 |
| Placeholder 被 MT 改寫 | deterministic count/order assertion；micro-clause retry；fail closed |
| TTS 念錯但文字正確 | pronunciation lexicon／SSML；必要時固定 voice 的 reviewed audio atom |
| Cascade 延遲過高 | connection prewarm、所有階段 streaming、ordinary/protected span 分流、最近 region |
| Barge-in 後還播舊聲 | local generation fence 是權威；provider cancel 只作最佳努力 |
| 動態 voice cloning 拖延／不穩 | POC 關閉；術語與延遲通過後才單獨評估 |
| WebRTC 好、電話 8 kHz 壞 | Phase 0 就加入 μ-law fixture；買 PBX 前先做 phone adapter benchmark |
| 公開 sample code 被誤當 production | pin versions、contract tests、獨立 adapter；只重用有明確 license 的部分 |

## 15. 建議下一個工程切片

本輪只完成 survey。下一輪若批准實作，建議只做：

1. TypeScript workspace、validated config 與 provider-independent audio/event contracts。
2. LocalWebRtcAdapter、FakeMediaAdapter、OpenAIRealtimeTranslateAdapter。
3. LiveTranscribeAdapter、StablePrefixAssembler、TerminologyGuard、placeholder validator。
4. 一個可替換的 streaming TTS adapter；至少兩家同 corpus bake-off。
5. WAV replay harness、latency／term exactness dashboard、generation-aware playout。
6. Phone/Twilio 只做 fake contract；不申請號碼、不改 PBX。

Go/no-go 順序：先證明 critical term 三層 100% → 再證明 latency relative gates → 再證明 barge-in → 最後才進入 Twilio/SIP media-adapter POC。

## 16. 主要來源

### Palabra

- [Streaming API overview](https://docs.palabra.ai/docs/streaming_api)
- [Translation settings breakdown](https://docs.palabra.ai/docs/streaming_api/translation_settings_breakdown)
- [Recommended WebRTC/default settings](https://docs.palabra.ai/docs/streaming_api/recommended_settings)
- [Management API, flush, partial events, 320 ms pacing](https://docs.palabra.ai/docs/streaming_api/management)
- [Publishing and receiving audio](https://docs.palabra.ai/docs/streaming_api/publishing_and_receiving_audio)
- [Create glossary API](https://docs.palabra.ai/api/create-a-new-glossary)
- [Glossaries guide](https://docs.palabra.ai/docs/glossaries)
- [Public realtime S2S playground/debug](https://platform.palabra.ai/iframe/playground/realtime-sts?debug=1)
- [Voice Translation API/product claims](https://www.palabra.ai/voice-translation-api)
- [Streaming TTS claims](https://www.palabra.ai/text-to-speech)
- [Pricing](https://www.palabra.ai/pricing)
- [JavaScript SDK](https://github.com/PalabraAI/palabra-ai-javascript)
- [Python SDK](https://github.com/PalabraAI/palabra-ai-python)
- [Java SDK](https://github.com/PalabraAI/palabra-ai-java)
- [Twilio demo](https://github.com/PalabraAI/twilio-demo)

### OpenAI

- [Build Live Translation Apps with gpt-realtime-translate](https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide)
- [gpt-realtime-translate model](https://developers.openai.com/api/docs/models/gpt-realtime-translate)
- [Realtime translation client events](https://developers.openai.com/api/reference/resources/realtime/translation-client-events)
- [Realtime translation server events](https://developers.openai.com/api/reference/resources/realtime/translation-server-events)
- [gpt-live-transcribe model](https://developers.openai.com/api/docs/models/gpt-live-transcribe)
- [gpt-realtime-2.1 model](https://developers.openai.com/api/docs/models/gpt-realtime-2.1)

### Alternative components

- [Deepgram Keyterm Prompting](https://developers.deepgram.com/docs/keyterm)
- [Deepgram Find and Replace](https://developers.deepgram.com/docs/find-and-replace)
- [Cartesia custom pronunciations](https://docs.cartesia.ai/build-with-cartesia/capability-guides/custom-pronunciations)
- [Cartesia Sonic](https://docs.cartesia.ai/build-with-cartesia/tts-models/latest)
- [ElevenLabs keyterm prompting](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/batch/keyterm-prompting)
- [NVIDIA Speech-to-Speech Translation](https://docs.nvidia.com/nim/speech/latest/nmt/speech-to-speech-translation.html)
- [NVIDIA custom dictionaries](https://docs.nvidia.com/nim/speech/latest/nmt/custom-dictionaries.html)
- [WeNet](https://github.com/wenet-e2e/wenet)
- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
- [CosyVoice](https://github.com/QwenAudio/CosyVoice)
- [Meta Seamless Communication](https://github.com/facebookresearch/seamless_communication)
