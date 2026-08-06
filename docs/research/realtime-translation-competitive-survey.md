# 即時雙向語音翻譯：競品 Survey 與本機 POC 架構

> 調查日期：2026-08-05（Asia/Taipei）
> 範圍：真人對真人語音翻譯；先做本機麥克風／喇叭 POC，再接單一虛擬號碼或 SIP。
> 證據原則：只採官方產品頁、官方文件與官方 API reference；行銷用語不視為效能保證。

## 1. 建議結論

1. 低延遲基線採 OpenAI **gpt-realtime-translate**。它是專用的連續 speech-to-speech 翻譯模型，可在輸入仍抵達時輸出翻譯音訊與文字。
2. 不能宣稱它原生解決自訂詞彙表。OpenAI 官方明載目前不支援 custom prompts、glossaries 或 pronunciation guides。
3. 應提供三個可切換 profiles：
   - **native_realtime**：最低延遲與連續翻譯。
   - **glossary_guarded**：streaming STT → 術語約束翻譯 → streaming TTS，優先可控性。
   - **hybrid_shadow**：native 音訊主路徑 + hinted STT shadow，提供字幕、術語命中與 QA；不能回頭修正已播放音訊。
4. 插話是產品媒體政策。專用 translation client reference 只列 update、append audio、close，沒有逐段 cancel/clear；duck、playback clear 與 stale-audio 上限要由本產品實作。
5. 本機與電話共用一個 deep Session module，transport 由 adapter 更換。核心不得看見 Twilio JSON、SIP/RTP、WebRTC track 或 OS audio callback。
6. Palabra 是最接近需求的技術競品：官方同時明載 WebRTC/WebSocket、two-way、70+ 語言與 business glossary；但沒有公開可驗收的 p95 latency、barge-in cutoff 或原生 PSTN 規格。
7. 會議型競品多不符合「撥號即真人、來電者不裝 App」。LanguageLine 最像電話入口，但官方流程是 IVR-compatible、pre-call message、consecutive interpretation，與客戶原則衝突。
8. 原需求的「6 月底上線」若指 2026-06-30，截至本調查日已過期，必須重排絕對日期與 go/no-go 點。

## 2. 現況與可驗收語言

Repo 是 greenfield：tracked product file 只有一行 README，沒有 source、runtime config、dependency manifest、測試或語音資料流。

| 客戶痛點 | 不足以驗收的說法 | 可驗收問題 |
|---|---|---|
| 製造術語表 | 支援 prompt | critical term 在 source text、target text、spoken output 各自的 recall？ |
| 正確率 | 模型更大 | 數字、單位、料號、否定詞與專名是否保真？ |
| 1–2 秒延遲 | realtime | capture→first audio、steady-state lag 的 p50/p95/max？ |
| 插話 | full duplex | 另一方開口後幾 ms duck/clear？重疊後兩路是否恢復？ |
| 真人直接接聽 | 支援電話 | 是否直接響真人，無 AI greeting、無 IVR/語言問答？ |
| 零下載 | 有 mobile app | 來電者是否只撥號；本機 Demo 是否只需瀏覽器？ |
| 可換電話/PBX | API-first | 是否只換 composition profile，不改翻譯核心？ |

Full duplex 必須拆成三層：

1. **模型串流**：邊收音訊邊送翻譯音訊。
2. **雙向媒體**：A→B、B→A 是兩條獨立並行 translation legs。
3. **人類體感**：重疊時的 duck/clear、echo control、routing 與恢復。

缺任一層，都不能宣稱完整 full duplex。

## 3. 競品 spec matrix

標記：**官方明載**、**推論**、**未公開**。未公開不代表沒有，只代表不足以承諾。

| 產品 | 即時語音 | 術語／glossary | Full duplex／插話 | 接入 | 判讀 |
|---|---|---|---|---|---|
| **Palabra API** | **官方明載** real-time STS、WebRTC/WebSocket、two-way、70+ languages | **官方明載** business glossary/session rules | two-way 明載；barge-in cutoff/p95 **未公開** | Browser/mobile/server；原生 PSTN/SIP **未公開** | 最接近完整能力；ultra-low 只有行銷描述 |
| **Zoom Voice Translator / ZCC Interpreter** | Meeting translator；ZCC **官方明載** bidirectional STS | 專屬 glossary contract **未公開** | barge-in **未公開**；長段 speech 在 pause 後播放 | Zoom desktop；ZCC 有 web app | 平台綁定；meeting 版公開 5 語言 |
| **Microsoft Teams Interpreter** | **官方明載** real-time STS、多說話者、mixed-language | **未公開** | UI 會提示他人仍在聽翻譯並建議等待；cutoff **未公開** | Teams + M365/Copilot | 不是 PSTN-neutral translator |
| **Google Meet Speech Translation** | **官方明載** Meet real-time speech translation | **未公開** | **未公開** | 特定 Workspace editions 的 Meet | 平台功能，不等同通用電話/SIP |
| **KUDO AI** | **官方明載** one-way live、70+ languages | **官方明載** custom glossary | **官方明載 one-way**，不可推論成對話 full duplex | KUDO meeting/event | 術語強，偏單向活動 |
| **Interprefy AI** | **官方明載** speech + captions、80 languages | **官方明載** custom vocabulary | 官方 best practice 要求 one speaker at a time、交棒等數秒 | Smartphone/event modes | 官方建議與 overlap 目標相反 |
| **Wordly** | Real-time audio/captions，偏 presenter→audience | **官方明載** custom glossary；舊官方指南列 5,000 terms | 對話 barge-in **未公開** | URL/QR；瀏覽器可免下載/帳號 | 零下載佳，但不是撥號真人客服 |
| **LanguageLine AI** | **官方明載** back-and-forth consecutive；10+ AI languages | **未公開** | simultaneous/barge-in **未公開** | Freephone、cloud、IVR-compatible | 電話接入最像；流程衝突且仍 limited pilot |

市場判讀：

- Palabra 是功能標竿；我們必須靠電話入口、真人流程、插話指標與可觀測性差異化。
- KUDO、Interprefy、Wordly 證明 custom glossary 已是市場預期，不是額外加分。
- Teams、Zoom、Meet 的弱點是平台綁定；我們的價值是任何電話與既有真人客服流程。
- 各家很少公開 p95 audio latency、overlap recovery、term recall、barge-in cutoff；Demo 應用自有量測勝出。

## 4. Twilio 現有路線

ConversationRelay 官方明載：

- 通話 STT prompt 經 WebSocket 給應用程式，應用回 text tokens，Twilio 做 TTS。
- hints bias STT；interruptible、interruptSensitivity、reportInputDuringAgentSpeech、ignoreBackchannel、preemptible 控制 voice-agent playback。
- speechTimeout 可設 600–5000 ms；TTS 可選 Google、Amazon、ElevenLabs；部分 SSML 可控制 pronunciation。
- ConversationRelay 不是翻譯模型，translation 仍由應用程式完成。

對本案的判斷：

- 截圖中的 STT hints 可改善辨識，但不等同 target translation 強制使用 approved term。
- ConversationRelay barge-in 是 caller 對 agent TTS；真人雙向翻譯仍需兩方向、個別 playback queue 與 routing。
- 客戶拒絕前端 AI Agent/IVR，不能用 welcome prompt 或問答收集語言。
- Phone POC 優先採 bidirectional Media Streams 或等價 media bridge；翻譯核心不依賴 ConversationRelay schema。
- 單一號碼仍可 direct-human：inbound leg 立即撥 human-agent leg，正常響鈴後橋接；不先收集資料、不播 AI greeting。

## 5. OpenAI 最新能力

### gpt-realtime-translate

官方明載：

- 專用 /v1/realtime/translations；input audio，output audio + transcript deltas。
- 來源仍在說話時持續輸出，沒有一般 assistant 的 turn lifecycle。
- Browser 建議 WebRTC；telephony/media worker 建議 WebSocket。
- WebSocket input 是 24 kHz PCM16 mono little-endian；最佳為 200 ms chunks，active session 要持續送 silence；output 也是 200 ms PCM16 frames。
- 70+ input languages、13 target languages；target 只列 Chinese，沒有公開承諾繁中／台灣華語文字形態。
- Dynamic voice adaptation；不可選固定 voice；可設 near_field/far_field noise reduction。
- 公開價格 audio output **US$0.034/minute**。雙向通常要兩 sessions，shadow STT 另計；完整每通成本須查實際帳單。

限制：

- 目前不支援 custom prompts、glossaries、pronunciation guides。
- Same-language/code-switch 片段可能保持安靜；完全 mute original audio 會像斷線，應保留 mix/ducking。
- Current client event 清單沒有逐段 cancel/clear；這是 current-doc inference，不代表未來不會新增。

### gpt-live-transcribe

官方明載：

- Streaming STT，支援 prompt、keywords、多個 languages hints、delay tuning。
- Language hints 支援 zh-tw、zh-hk、cmn 等格式。
- Delay 有 minimal/low/medium/high/xhigh；毫秒值不固定，要用真實音訊 benchmark。
- Keywords 是 hints，不保證輸出。
- 無 word-level timestamps、speaker labels、confidence scores。
- 公開價格 **US$0.017/minute**。

用途是 shadow QA，或 glossary cascade 的 STT。Translation session 的 optional transcript schema 只公開 model；需要 keywords 時應開獨立 transcription session。

### 一般 Realtime voice model

gpt-realtime-2.1 適合 assistant/tool-calling。標準 conversation 在 VAD 下可處理 interruption；WebRTC/SIP server 可自動截斷未播放音訊，WebSocket 要由 client 停播放並 truncation。

它能作 promptable translator 對照組，但官方 translation guide 把「翻譯人類」導向專用 model。一般 voice model 是 turn-based，且可能回答而非純翻譯；不作預設主路徑。

## 6. 三個 translation profiles

| Profile | Flow | 優點 | 缺點 | Demo 目的 |
|---|---|---|---|---|
| **native_realtime** | audio → dedicated translator → audio | 路徑最短、continuous | 無 glossary/prompt | latency、自然度、overlap |
| **glossary_guarded** | audio → live STT → term-locked translation → TTS | 可強制料號/單位/專名 | 多階段、延遲/複雜度高 | 製造術語可控性 |
| **hybrid_shadow** | native audio + hinted STT/evaluator | 不拖慢主音訊、有 evidence | 不能修正已播 audio、增加成本 | 同場量測 trade-off |

先做 native_realtime + hybrid_shadow。只有 spoken-term recall 未過 gate，才完成 cascade 聲音輸出。

## 7. 建議 system design

三個獨立 interface 設計比較後，建議採「最小 runtime + 簡單 profile」混合案；高彈性的 policy-driven event stream 保留在 implementation，不先暴露給 POC caller。

External interface：

    interface DuplexTranslationRuntime {
      run(plan: DuplexPlan, until: AbortSignal): Promise<RunReport>;
    }

    interface RunningSession {
      events(): AsyncIterable<SessionEvent>;
      stop(reason?: string): Promise<void>;
    }

External interface 只描述 A/B language、translation profile、glossary ID、interruption/observability policy；不得包含 provider raw events。

Internal flow：

    A endpoint → A→B leg → translation adapter → B playback
                         ↘ optional shadow transcription/eval

    B endpoint → B→A leg → translation adapter → A playback
                         ↘ optional shadow transcription/eval

Invariants：

- A→B、B→A 各自有 bounded queue、clock、sequence、generation fence、metrics；一邊重連不可阻塞另一邊。
- Canonical audio 是 PCM16LE mono、固定 internal sample rate/frame duration、monotonic timestamp、sequence、session/leg IDs。
- 超過 latency budget 時 drop stale audio，不能用無限 queue 掩蓋。
- PlayoutCut(generation) 後，遲到的舊 audio 永不得播放；provider 不支援 cancel 也能在 transport 端立刻停。
- Close 必須 idempotent；metrics/exporter 不得阻塞 media。

Seams/adapters：

| Seam | Adapters |
|---|---|
| Media | LocalAudio、BrowserWebRtc、TwilioMediaStreams、SipRtp、FakeMedia |
| Speech translation | OpenAIRealtimeTranslate、GlossaryCascade、FakeSpeech |
| Clock/metrics | production monotonic clock、fake clock、OTel/JSONL sinks |

GlossaryCascadeAdapter 內部再組 STT/text/TTS；不要把三個 SDK 直接暴露給 Session module。

Config-only swap：

    APP_PROFILE=local
    TRANSLATION_PROFILE=native_realtime

Phone phase：

    APP_PROFILE=twilio
    TRANSLATION_PROFILE=native_realtime

只有 composition root 分支；core 不改。各 profile startup 驗證必填設定，secret 只由環境或 secret store 注入。

## 8. Barge-in policy

本案不是 AI front desk。Barge-in 定義：A 的翻譯仍在 B 端播放時 B 開口；B 端立即 duck/clear A→B queue，B→A 不等待，重疊結束後兩路恢復，speaker output 不回灌 input。

建議比較：

- **natural_duplex**：兩路可播，但 local speaker active 時遠端翻譯降至 15–25%。
- **interrupt_wins**：確認 local speech 後清掉遠端未播放 audio，只留很短 jitter buffer。
- **listen_priority**：只 duck 不 clear，適合重要說明但插話體感較差。

## 9. Local-first POC

### Phase 0 — deterministic audio

- 匯入製造術語 CSV：source term、approved target、aliases、pronunciation、critical flag。
- 建 30–50 句 corpus：料號、縮寫、數字、單位、否定、近音；至少 3 speakers、兩方向。
- WAV-in/WAV-out，確保 profiles 使用完全相同音訊。
- Fixtures：24 kHz clean、far-field noise、8 kHz μ-law telephony。

### Phase 1 — one-way local live

- Browser/local adapter：mic → translation → selected headset/speaker。
- UI 顯示 source/target transcripts、glossary hit/miss、first-audio latency、queue depth。
- 比較 near-field/far-field noise reduction。

### Phase 2 — true duplex local

- 用兩台 browser devices 或兩組 headset/audio devices；單 laptop mic→speaker loop 不能證明 routing，且易 echo。
- 兩條獨立 translation legs，跑 scripted overlap/barge-in。
- Native + shadow evaluator 同步記 p50/p95/max。

### Phase 3 — telephone adapter

- 單一 Twilio number；customer leg 直接 ring/originate human-agent leg，無 AI greeting、無資訊/語言收集。
- 兩條人聲軌分開接 A→B/B→A sessions。
- 驗證 μ-law 8 kHz ↔ PCM16 24 kHz、playback clear、ring/no-answer/hangup、reconnect、cost。
- Demo 過 gate 後才決定 PBX replacement/SIP topology。

## 10. Proposed success gates

以下是**建議值，不是 provider guarantee**；正式前須與客戶共同簽定 corpus、網路、硬體條件。

Quality：

- Critical terms：agreed corpus 的 source/target text **100% exact approved-form recall**。
- Spoken critical term：雙語 reviewer 確認；零錯料號、數字、單位、否定極性。
- Non-critical glossary recall 起始建議 ≥95%。
- Clean/far-field/telephony 分欄；source STT、target text、spoken audio 分開計分。

Latency：

- native local capture→first audio：p50 ≤1.0 s、p95 ≤2.0 s。
- Steady-state lag p95 ≤2.0 s。
- glossary_guarded 另訂 p95（起始建議 ≤2.5 s），不得拿 native 指標冒充。
- 分段報 network/provider/playout，不只總平均。

Interruption：

- Local speech start → duck/clear command p95 ≤150 ms。
- Command 後 stale audio ≤250 ms（含 device buffer）。
- 2 秒 overlap 後，兩路均在 1 秒內恢復有效 output。
- 30 分鐘 scripted session：零 echo-only false turn；double-talk 仍處理 near-end speech。

Reliability/access：

- 30 分鐘雙向 session 無 crash、無無限 queue；dropped/corrupt frames <0.1%。
- Monotonic milestones：capture、provider send、first transcript/output、playback、clear。
- Raw audio/transcript 預設不持久化；Demo 錄音需同意與 retention policy。
- 來電者只撥一支號碼，不下載、不登入、不選單；直接響真人客服。

## 11. Demo agenda

1. 三層 full-duplex 定義與限制（5 分鐘）。
2. 同一 corpus A/B native 與 glossary/shadow（10 分鐘）。
3. 正常輪替、backchannel、中斷、2 秒 overlap（10 分鐘）。
4. APP_PROFILE 架構展示；當輪仍只跑 local（5 分鐘）。
5. 管理層自由對話，dashboard 顯示 latency/term hit/queue clear（10 分鐘）。
6. Go/no-go：決定 phone POC、PBX/SIP 與新上線日期（10 分鐘）。

## 12. 主要風險

| 風險 | 緩解 |
|---|---|
| 專用 model 無 glossary | 三 profiles；critical terms 未過就 cascade |
| Chinese 未承諾繁中 | 台灣華語 corpus；字幕繁簡正規化另做，spoken audio 另評 |
| 8 kHz phone degradation | 買 PBX 前先跑 μ-law fixtures/Twilio |
| Overlap 蓋音 | 每人獨立 track/session + ducking，拒絕 mixed single track 偽 full duplex |
| Echo feedback | Headset；local adapter AEC/playback reference |
| Shadow 正確但 spoken 已錯 | source/target/spoken 三層報告；不把 shadow 稱為修正 |
| 兩路 + shadow 成本 | per-session/leg metering，以真實帳單估每通 |
| Provider schema 污染 core | 只在 adapters 內 normalize |
| 舊時程失效 | Demo 決策會重排 absolute dates/owners |

## 13. 官方來源

### OpenAI

- [Realtime translation guide](https://developers.openai.com/api/docs/guides/realtime-translation)
- [gpt-realtime-translate model](https://developers.openai.com/api/docs/models/gpt-realtime-translate)
- [Translation cookbook：browser/Twilio/LiveKit/limits/evals](https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide)
- [Translation client events](https://developers.openai.com/api/reference/resources/realtime/translation-client-events)
- [Translation server events](https://developers.openai.com/api/reference/resources/realtime/translation-server-events)
- [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [gpt-live-transcribe model](https://developers.openai.com/api/docs/models/gpt-live-transcribe)
- [Interruption/truncation](https://developers.openai.com/api/docs/guides/realtime-conversations#interruption-and-truncation)
- [Realtime VAD](https://developers.openai.com/api/docs/guides/realtime-vad)
- [Pricing](https://developers.openai.com/api/docs/pricing)

### Twilio

- [ConversationRelay reference](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay)
- [ConversationRelay WebSocket messages](https://www.twilio.com/docs/voice/conversationrelay/websocket-messages)
- [ConversationRelay Insights](https://www.twilio.com/docs/voice/voice-insights/conversation-relay-insights-dashboard)
- [Media Streams](https://www.twilio.com/docs/voice/media-streams)
- [Elastic SIP Trunking](https://www.twilio.com/docs/sip-trunking)

### Competitors

- Palabra: [API](https://docs.palabra.ai/docs/streaming_api), [glossary/70+](https://docs.palabra.ai/), [two-way](https://www.palabra.ai/voice-translation-api)
- Zoom: [Voice Translator](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0084896), [ZCC Interpreter](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0084777)
- Microsoft: [admin spec](https://learn.microsoft.com/en-us/microsoftteams/interpreter-agent-teams), [user experience](https://support.microsoft.com/en-US/teams/copilot/interpreter-in-microsoft-teams-meetings-and-calls)
- Google: [Meet admin spec](https://knowledge.workspace.google.com/admin/meet/turn-speech-translation-on-or-off-for-meet), [announcement](https://workspace.google.com/blog/product-announcements/new-ways-to-do-your-best-work)
- KUDO: [plans/features](https://kudo.ai/pricing-plans-and-features/)
- Interprefy: [languages](https://knowledge.interprefy.com/what-languages-can-interprefy-ai-translate-from-and-to), [vocabulary](https://www.interprefy.com/solutions/access-modes/interprefy-now), [overlap guidance](https://knowledge.interprefy.com/rules-of-the-floor)
- Wordly: [custom glossary](https://www.wordly.ai/ai-interpretation), [no-download browser access](https://www.wordly.ai/real-time-translation), [5,000-term guide](https://offers.wordly.ai/hubfs/wordly-zoom-guide-04-19-2022.pdf?hsLang=en)
- LanguageLine: [phone/IVR/consecutive flow](https://www.languageline.com/en-gb/interpreting-services/ai-interpreting-services)

## 14. 下一個工程任務

只建 Phase 0 + Phase 1：

1. TypeScript workspace + validated config profiles。
2. Deep Session module；Local/Fake media adapters；OpenAI native + shadow transcription adapters。
3. Glossary CSV schema + deterministic WAV eval harness。
4. Local mic→speaker UI + latency/term-hit dashboard。
5. Contract tests 鎖定 seams；phone adapter 本輪只做 fake contract。

本機 terminology、latency、barge-in gates 通過後，才實作 Twilio number/SIP adapter 或更換 PBX。
