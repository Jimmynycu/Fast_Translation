# Palabra API／SDK 整合調查

> 調查日期：2026-08-07（Asia/Taipei）
> 範圍：只查 Palabra 官方文件、API reference、官方 GitHub／SDK 原始碼與套件 metadata；未使用私有內容。
> 證據標記：**Official** 官方文件／schema；**Public source** 官方公開原始碼；**Vendor claim** 官網宣稱；**Inference** 公開證據推論；**Not public** 尚無公開保證。

## 結論

> **Current repository cutover (2026-08-09).** This is provider research, not
> deployment configuration. The runtime selects Palabra only through a
> hash-pinned approved processing profile; prewarm occurs automatically after
> consent/connect/preflight/arm and before `ready`, with truthful readiness
> rather than a vendor-acceptance claim. Each profile service has a
> manifest-bound ordered `dataCategories` egress list. Any unverified selected
> `trainingUse` or `serviceRetention` makes the profile `synthetic_only` and
> blocks human session creation. The checked-in `manufacturing-poc` sample has
> that status. Fallback is only `none` or approved same-route
> `same_route_fail_open`, never automatic cross-provider substitution.

目前 canonical path 是 server-side API key → direct WebSocket（server）或 POST streaming session → publisher JWT + LiveKit WebRTC（browser/mobile）。API key 不得放進 browser/mobile。單一 task/session 描述一條 input track，可有多個 target output；產品頁的 two-way 是 **Vendor claim**，protocol 沒有 duplex 欄位，真正雙向應建兩個 legs（**Inference**）。[Authentication](https://docs.palabra.ai/docs/auth) [Session management](https://docs.palabra.ai/docs/streaming_api/session) [Multi-language](https://docs.palabra.ai/docs/streaming_api/multi_language_translation)

WS input 支援 pcm_s16le、opus、wav，16–48 kHz、1/2 channels；output 支援 pcm_s16le 或 zlib_pcm_s16le，固定 24 kHz mono。約 320 ms 一塊、real-time pace。控制與事件均為同一 JSON envelope。[Publishing/receiving audio](https://docs.palabra.ai/docs/streaming_api/publishing_and_receiving_audio) [Management API](https://docs.palabra.ai/docs/streaming_api/management) **Official**

flush_task 取消（但不 finalize）server 正在處理的 phrase，但不能收回已播放聲音；client 必須清本地 playout queue。官方 Python SDK 明確不自動 reconnect；application 要自行 backoff、重建 task 與決定是否重送 audio。[Python reconnect](https://github.com/PalabraAI/palabra-ai-python#reconnection) **Official／Public source**

## 1. Auth 與 session lifecycle

| 情境 | 公開做法 |
|---|---|
| REST | Authorization: Bearer API_KEY（session、voice、glossary 等）。 |
| Direct WS | Authorization header 或 token query；server 以 API key 自動建立／清理 streaming session。 |
| WebRTC | server POST /session-storage/session，回 publisher JWT、webrtc_url、ws_url、id；client 用 publisher 連 LiveKit。 |

來源：[Authentication](https://docs.palabra.ai/docs/auth)、[Session management](https://docs.palabra.ai/docs/streaming_api/session)、[Create streaming session](https://docs.palabra.ai/api/create-streaming-session) **Official**。手動 session 有 expires_at；未連線前會失效，活動連線每分鐘延長，也可更新 ttl 或 DELETE 閒置 session。並行數按 plan 限制。

## 2. Transport、control 與 audio

Browser flow：後端建 session → client 取得 webrtc_url/publisher → LiveKit connect → publish mic → empty-topic data channel 傳 set_task → subscribe 每個 target 的 translated track。建議 DTX/RED 關閉、32 kbps、high priority。[WebRTC quick start](https://docs.palabra.ai/docs/quick-start/webrtc) [Recommended settings](https://docs.palabra.ai/docs/streaming_api/recommended_settings) **Official**

Server WS direct endpoint：

    wss://streaming.palabra.ai/streaming-api/{random_url_safe_hash}/v1/speech-to-speech/stream?token=API_KEY

或手動 session 的 ws_url?token=publisher。所有 message：

    {"message_type":"<string>","data":{...}}

典型 workflow：

    connect → set_task(start) → [input_audio_data ↔ events]*
            → set_task(update) / pause_task / flush_task
            → end_task({eos_timeout, force}) → eos → close

set_task 首次啟動、執行中可 live update；pause_task 停處理與計費、set_task 恢復；flush_task 取消（但不 finalize）目前 phrase，可指定 languages=global 或 target；end_task 的 eos_timeout 是 1–30 秒，force 跳過 finalization；tts_task 文字上限 2,048 字元。WS limits：connection 20/min/token；set_task/get_task 1/2 s；pause_task/end_task 1/3 s；tts_task 60/min；connection 超限 code 1008。[Management API](https://docs.palabra.ai/docs/streaming_api/management) **Official**

WS input declaration：

    input_stream.source = {type:"ws", format:"pcm_s16le|opus|wav",
                           sample_rate:16000..48000, channels:1|2}
    output_stream.target = {type:"ws",
                            format:"pcm_s16le|zlib_pcm_s16le"}

output 固定 24000 Hz、mono；audio chunks base64，input optimal 320 ms，單一 payload 約 1 KiB–512 KiB。過快／過慢／停滯會 warning：AUDIO_STREAM_TOO_FAST、AUDIO_STREAM_TOO_SLOW、AUDIO_STREAM_STALLED。[Audio docs](https://docs.palabra.ai/docs/streaming_api/publishing_and_receiving_audio) [Management audio](https://docs.palabra.ai/docs/streaming_api/management) **Official**\n\nPython SDK 對 zlib_pcm_s16le 是逐一 message 解壓的；這是 [公開 events.py 實作](https://raw.githubusercontent.com/PalabraAI/palabra-ai-python/main/src/palabra_ai/events.py) 的 **Inference**，不是官方 wire-level 的跨 message stream 保證。

WebRTC codec、sample-rate、Opus profile 與 renegotiation 沒有固定公開保證（**Not public**）；它們由 LiveKit 協商。WS 是 server 最穩定、最易測試的 application-level base64 transport。

## 3. Settings、languages 與 events

set_task 的 data 有 input_stream、output_stream、pipeline、translation_queue_configs、allowed_message_types。source_language 可指定 code 或 auto，可用 detectable_languages；translations array 每項有 target_language、translate_partial_transcriptions、speech_generation。多 targets 同一 session 可同時產生多條輸出；conditional routing 用 allowed_source_languages。[Translation settings](https://docs.palabra.ai/docs/streaming_api/translation_settings_breakdown) [Supported languages](https://docs.palabra.ai/docs/languages) **Official**

Response types：

    partial_transcription
    partial_translated_transcription
    validated_transcription
    translated_transcription
    output_audio_data
    current_task
    eos
    warning
    error

transcript data 公開含 transcription_id、language、text、segments/words、start/end timestamps；translated data 另有 translation_part_id。audio data 含 transcription_id、language、last_chunk、base64 data，可能有 chunk_generation_delta。[Management responses](https://docs.palabra.ai/docs/streaming_api/management) **Official**

Partial 會 revision，adapter/UI 應以 stable ids 重繪而非盲 append。官方未保證 audio 全域 sequence／ordering（**Not public**）。segment_confirmation_silence_threshold 0.3–2.0 s（預設約 0.7）、sentence splitter、queue desired/max、auto_tempo 可調。[Translation settings](https://docs.palabra.ai/docs/streaming_api/translation_settings_breakdown)

## 4. Glossary、voice 與 direction

官方 Python SDK 的 glossary 三類：[Python glossary docs](https://github.com/PalabraAI/palabra-ai-python#glossaries) **Public source**

| kind | 作用 | language key |
|---|---|---|
| hotwords／API asr_hot | ASR bias | source |
| verification／API asr | 同語言 ASR replacement | source |
| translation | 固定 term translation | source→target |

REST /saas/glossary 可建立（CSV max 1 MB）；task 以 allow_*_glossaries 與 allowed_*_glossary_ids 限定。上述 account-level matching 是本案選擇；它不是本地 pinned term 的 exact/accuracy guarantee。[Glossary guide](https://docs.palabra.ai/docs/create-a-glossary-using-api) [Glossary API](https://docs.palabra.ai/api/create-a-new-glossary) **Official**

公開資料沒有 matching precedence、normalization、衝突規則或 accuracy guarantee（**Not public**）；把 glossary 當 bias/hint/replace pipeline，不當 100% assertion。voice_id、timbre detection 與 experimental voice cloning 是 target speech_generation 設定。

session schema 只有一個 input_stream.source，沒有 duplex、speaker routing、turn-taking 或 barge-in local playback 欄位。故 full duplex 需兩個 legs（**Inference**）；echo control、speaker routing、計費由應用層負責。產品頁的 two-way、<1 s、60+ languages 是 **Vendor claim**，不是 wire guarantee。[Voice Translation API](https://www.palabra.ai/voice-translation-api)

## 5. Barge-in、reconnect、errors

插話：送 flush_task → 清 target playout queue → 遞增 generation → 丟棄舊 output_audio_data。server flush 只取消 current phrase 的處理（不會把它 finalize），已播放音訊無法撤回（**Inference from media semantics**）。translation_queue_configs 控制 backlog，不是固定 startup wait。

Python 2.x SDK 說明沒有 automatic WebSocket reconnect；drop 時 iteration 結束或 SessionError，因透明 resume 會遺失 in-flight audio/context。WebRTC LiveKit ICE reconnect 也不等於 pipeline state resume；browser SDK 重播 task/partial context 未公開（**Not public**）。[Python SDK reconnect](https://github.com/PalabraAI/palabra-ai-python#reconnection)

Wire error 是 envelope message_type=error；欄位是 data.code、data.desc，並可有 data.param（不要把 desc 誤當 description）。REST 常見 401/403/404/422/402/504 類別（auth、validation、audio/language、funds、timeout）。保留 raw code/desc/param、warning、session/leg id 與 timing；不要把所有錯誤扁平成一種 Exception。[Error codes](https://docs.palabra.ai/docs/error_codes) **Official**

## 6. SDK／package 風險

| SDK | public metadata | 注意 |
|---|---|---|
| Python | palabra-ai，GitHub pyproject 2.1.0，Python ≥3.10，MIT；API key + region、direct WS、typed events | GitHub __version__／registry 可能落後；pin source/package。 [pyproject](https://raw.githubusercontent.com/PalabraAI/palabra-ai-python/main/pyproject.toml) [LICENSE](https://raw.githubusercontent.com/PalabraAI/palabra-ai-python/main/LICENSE) |
| JavaScript | @palabra-ai/translator 0.0.9、livekit-client 2.13.0、MIT metadata | public source 仍有 clientId/clientSecret／舊 userToken；與 current API-key docs drift，不可把 secret 放 browser。 [package](https://raw.githubusercontent.com/PalabraAI/palabra-ai-javascript/main/packages/lib/package.json) |
| Java | build ai.palabra 0.1.0、Java 17、MIT；README 另宣稱 artifact 1.0.0 | source/tests 仍讀 PALABRA_CLIENT_ID/SECRET；README、build、Maven 發布狀態不一致。 [build](https://raw.githubusercontent.com/PalabraAI/palabra-ai-java/main/build.gradle.kts) |

以 current docs 為準，對 JS/Java 做 compatibility smoke test 後才採用。

## 7. Verified boundary

**可依賴（Official／Public source）**：Bearer API key；WebRTC publisher JWT；direct WS；JSON envelope；set_task/pause/flush/end；WS formats/rate/channels；24 kHz mono output；320 ms pacing；partial/final event names 與 stable IDs；glossary kinds/allow-id controls；rate limits 與 error codes。

**不可假設（Not public／Vendor claim）**：固定 WebRTC codec/rate；同 session full duplex；partial 不 revision；flush 能消除已播放聲音；重連後 replay/context resume；glossary precedence/accuracy；固定 latency、<1 s、SLA、zero retention 或永久 region availability。

### 7.1 Implemented POC sealed-evidence review boundary

This repository's sealed-evidence review is not a Palabra API capability or
assurance. Deployment assigns separate data-owner and bilingual-reviewer
identities, then freezes them into each session's review grant. Only a bearer
matching that role and identity may use the audited metadata
`POST /api/sessions/:sessionId/evidence/review`, bounded 20 ms-aligned 24 kHz
mono WAV `POST /api/sessions/:sessionId/evidence/review/audio-window`, or the audited sealed
retention summary. The review responses are `Cache-Control: no-store` and never
contain an archive path/ID, raw manifest, or evidence reference. A detached,
content-free authenticated audit chain remains after evidence deletion; it is a
durable record of authorization disclosure, not proof that data was consumed.
This does not change the checked-in profile's synthetic-only/`NOT_RUN` external
assurances or the mandatory owner-led encrypted-master-glossary closeout.

## 8. 建議最小 adapter contract

將 raw envelope 隱藏在 provider adapter 後：

    interface SpeechTranslationAdapter {
      start(config: {
        sourceLanguage: string;
        targetLanguages: string[];
        input: {
          transport: "webrtc" | "websocket";
          format?: "pcm_s16le" | "opus" | "wav";
          sampleRateHz?: number;
          channels?: 1 | 2;
        };
        output?: { format?: "pcm_s16le" | "zlib_pcm_s16le" };
        glossary?: {
          hotwordIds?: string[];
          verificationIds?: string[];
          translationIdsByTarget?: Record<string, string[]>;
        };
        partialTranslations?: boolean;
      }): Promise<RunningSession>;
    }

    interface RunningSession {
      sendAudio(frame: Uint8Array, timestampMs: number): Promise<void>;
      events(): AsyncIterable<{
        type: "partial_transcript" | "partial_translation" |
          "final_transcript" | "final_translation" | "audio" |
          "warning" | "error" | "ready" | "eos";
        sessionId: string;
        legId: string;
        sequence?: number;
        language?: string;
        text?: string;
        audio?: Uint8Array;
        transcriptionId?: string;
        translationPartId?: string;
        lastChunk?: boolean;
        sourceTimestamps?: { start: number; end: number };
      }>;
      update(patch: unknown): Promise<void>; // set_task
      pause(): Promise<void>;
      flush(languages?: string[]): Promise<void>;
      stop(options?: { eosTimeoutSec?: number; force?: boolean }): Promise<void>;
      close(): Promise<void>;
    }

Implementation rules: partial→final is replace semantics keyed by (sessionId, legId, transcriptionId, translationPartId); audio has bounded queue plus generation/sequence; flush clears local queue; full duplex means two RunningSession legs; reconnect is explicit policy and must report lost context; retain raw codes/warnings/timings.

## Primary source index

- [Authentication](https://docs.palabra.ai/docs/auth)；[Session management](https://docs.palabra.ai/docs/streaming_api/session)；[Create session API](https://docs.palabra.ai/api/create-streaming-session)
- [Management](https://docs.palabra.ai/docs/streaming_api/management)；[Audio](https://docs.palabra.ai/docs/streaming_api/publishing_and_receiving_audio)；[Settings](https://docs.palabra.ai/docs/streaming_api/translation_settings_breakdown)
- [Recommended settings](https://docs.palabra.ai/docs/streaming_api/recommended_settings)；[Multi-language](https://docs.palabra.ai/docs/streaming_api/multi_language_translation)；[Languages](https://docs.palabra.ai/docs/languages)
- [Glossary guide](https://docs.palabra.ai/docs/create-a-glossary-using-api)；[Glossary API](https://docs.palabra.ai/api/create-a-new-glossary)；[Error codes](https://docs.palabra.ai/docs/error_codes)
- [WebRTC quick start](https://docs.palabra.ai/docs/quick-start/webrtc)；[WebSocket quick start](https://docs.palabra.ai/docs/quick-start/websockets)
- [Python SDK](https://github.com/PalabraAI/palabra-ai-python)；[JavaScript SDK](https://github.com/PalabraAI/palabra-ai-javascript)；[Java SDK](https://github.com/PalabraAI/palabra-ai-java)
- [Product page](https://www.palabra.ai/voice-translation-api)（Vendor claim only）
