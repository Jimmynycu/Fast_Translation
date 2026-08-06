# Palabra 與候選管線同場基準測試協議

> 狀態：planning prototype v1。這是 issue 4 與 issue 13 已關閉決策的操作化草稿，不是產品程式或實測結果。
>
> 目的：以相同 fixture、裝置、網路時窗及評分規則，比較三個固定 arms，產生可重算的品質、延遲、插話與連續運行證據。

## 三個 HITL 建議套件

### HITL-A：Arms

建議固定且只比較 **PALABRA_REFERENCE、OPENAI_NATIVE_TRANSLATE、GLOSSARY_CONTROLLED** 三個 arms；HITL 核准各 arm 的 freeze tuple、Palabra account/enabled-glossary snapshot 與同場公平性限制。block 中任何 arm state 變更均不沿用結果。

### HITL-B：Workload／healing

建議採已關閉 workload：每方向約 100 個 discovery candidates ×3，只保留 wrong ≥2/3 的 10 個 term families；freeze 後每方向 20 unseen positives＋10 confuser negatives＋10 ordinary smoke。Healing 只讀 discovery/open regression，每 family 在 3 iterations、30 分鐘、US$25 中先到即停，完整 diff 仍由 Owner 核准；runtime 維持 Observable Fail-Open。

### HITL-C：Evidence／verdict

建議採本稿 monotonic timestamp、forced-alignment、queue 與 immutable evidence contract；formal semantics headline 固定 **240 unique runs**，interruptions 固定每 arm 20／總 60，並採 14 天預設／30 天上限 retention。唯一 verdict vocabulary 是 PASS、CONDITIONAL_PASS、FAIL、INVALID_RUN、PENDING_REVIEW。
## 固定 candidate arms 與 current-provider facts

| Arm | 固定角色 | Freeze tuple |
|---|---|---|
| **PALABRA_REFERENCE** | 外部相對延遲 reference | transport、account、region、voice、task settings、enabled-glossary snapshot/hash、SDK/API version |
| **OPENAI_NATIVE_TRANSLATE** | GPT-native discovery 與 formal native baseline | model=`gpt-realtime-translate`、endpoint/transport、target locale、voice/audio config、SDK/API version |
| **GLOSSARY_CONTROLLED** | 唯一受控候選；Observable Fail-Open | base pipeline、system prompt、background harness、glossary、binder/validator、voice/audio config 的版本與 hashes |

OpenAI 官方文件確認 `gpt-realtime-translate` 使用 dedicated realtime translation session，會在 source audio 持續到達時輸出 translated audio 與 transcript deltas；官方目前也明載它不支援 custom prompts、glossaries 或 pronunciation guides。因此 OPENAI_NATIVE_TRANSLATE 不得暗藏術語控制，控制能力只屬 GLOSSARY_CONTROLLED。[Realtime translation guide](https://developers.openai.com/api/docs/guides/realtime-translation)；[official terminology limitation](https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide#test-terminology-and-names-directly)

Palabra 官方文件確認 browser/client 可走 LiveKit-backed WebRTC，server integration 可走 WebSocket；兩者都可收送 audio/control。[API overview](https://docs.palabra.ai/docs/streaming_api)；[publishing and receiving audio](https://docs.palabra.ai/docs/streaming_api/publishing_and_receiving_audio) `allowed_message_types` 可選 partial/final transcription/translation events，`flush_task` 可取消 current phrase 而不停止後續 phrase。[management API](https://docs.palabra.ai/docs/streaming_api/management)

Palabra glossary 是 CSV，啟用後會自動套用到該 account 的每條 translation pipeline；UI 也允許 edit/delete/enable。公開文件沒有 per-session glossary version pin。因此這是 protocol requirement：每個 block 開始與結束都要 snapshot 並 hash account 全部 enabled glossary state；block 中若有任何變更，該 block 是 INVALID_RUN。[glossary API guide](https://docs.palabra.ai/docs/create-a-glossary-using-api)；[glossary UI guide](https://docs.palabra.ai/docs/create-a-glossary-using-the-web-ui)

Palabra 尚未由上述公開文件建立的 profile/build pin、provider clock accuracy、glossary propagation timing 與 flush acknowledgement semantics，維持 UNKNOWN 並寫入 limitations。OpenAI translation-specific contract目前沒有 documented cancel/VAD/flush；即使 PALABRA_REFERENCE 可送 `flush_task`，三個 arms 的 stale-audio 判定都以 Harness generation fence 為權威。

## Runtime contract：Observable Fail-Open

- `translation_ready`：base translation 已可供 controlled path 使用。
- `term_bound`：某 protected term 已綁定到核准 target form。
- `target_committed`：對外 canonical target text 已提交。
- `target_validated`：受控檢查完成；無論成功、bypass 或 timeout 都留下 outcome。
- binder/validator/background harness timeout 或 error 時，系統繼續輸出 best available translation，同時送 `glossary_control_bypassed` alert 與完整 evidence；不得靜音、阻塞或假裝成功。
- `target_exact` 硬閘只適用於**同時已 committed 且已 bound**的 target text。partial preview、未綁定文字與 discovery sample 不進 exact denominator。
- committed/bound target_exact breach 是產品 FAIL。Formal hidden positives 必須每方向 **20/20**；任何 positive binding miss 或 positive quality miss 都是 FAIL，即使 Observable Fail-Open 已持續輸出且 alert 完整。Fail-Open 是 runtime continuity，不是 acceptance waiver。
- confuser negative 不得被錯綁；false bind 造成錯誤 committed output 是 FAIL。
- spoken pronunciation 只做 diagnostic 與 reviewer note，永遠不是 hard gate，也不因單獨的 pronunciation finding 改變 verdict。

## Discovery、failure mining 與 freeze

每方向獨立執行：

1. 約 100 個候選術語各建立一個可判定 source case，交 OPENAI_NATIVE_TRANSLATE 跑 3 次。
2. 自動檢查 wrong language、entity/number/unit/polarity、核准 target form；bilingual reviewer 確認是否真的譯錯。
3. 只有 wrong ≥2/3 的 term family 可入選；保留 10 個。所有 run 與淘汰理由均留 lineage，避免 cherry-picking。
4. 對每 family 自動最小化 failure、建立 open regression、提出明確 change set；語意模型只能 triage，不能自動核准。
5. Healing budget 為每 family 最多 3 iterations、30 分鐘或 US$25，**先到即停**。Owner 核准每個 base-hash＋diff 後才產生新 profile hash。
6. Freeze 前須通過全部 open regression；Freeze 後 GLOSSARY_CONTROLLED 只有一個 immutable profile。任何內容變更都要新 suite，不得讀 sealed proof 後原地修補。

## Formal proof corpus

每方向在 freeze 後才解封：

- **20 unseen positives**：建議每個 retained family 兩個未見 context；hard gate 是每方向 **20/20** positive passes。
- **10 confuser negatives**：建議每個 family 一個近形、近音或語境 confuser。
- **5–10 ordinary smoke**：建議固定 **10** 個不含 protected-term intent 的一般翻譯案例。

Discovery cases 全數排除。當採建議值時，每方向有 40 個 unique semantic cases；denominators 分開報 positives=20、confusers=10、ordinary=10。每個 case 都有 clean 與 pinned representative factory-noise render；case 必須在兩種 render 都完成，但音訊 render、arms 與 latency repeats **不得增加 semantic denominator**。8 kHz/μ-law 留給後續 phone gate，不屬本次 acceptance。

每個 fixture 必含 source/target locale、approved meaning/forms、positive/confuser label、critical facts、音訊與 noise hashes、speech onset/end annotation；只用核准合成或重錄音訊，不用參與者原音。

## Operator flow

1. **Prepare**：載入三個 immutable manifests、formal corpus hashes、randomization seed、兩種 audio conditions 與 reviewer rubric；credentials 不得進 evidence。
2. **Snapshot**：記錄 Palabra account enabled-glossary state/hash；驗三個 arms 的 freeze tuple。
3. **Discovery/heal**：只在 open data 跑 mining、budgeted healing、Owner approvals 與 zero-regression；完成後 freeze。
4. **Formal semantic run**：用相同 fixture bytes 與 balanced randomized arm order跑 sealed positives、confusers、ordinary smoke。
5. **Latency run**：依下列固定 repetition unit 執行；所有 headline timestamps 由 Harness monotonic ns 產生。
6. **Duplex run**：執行 20 個 interruption scenarios 與每 arm 一次 10 分鐘 continuous full-duplex soak。
7. **Blind review**：reviewer 不看 arm 名稱，審核語意、forced alignment 與 disputed outcomes；未完成前標 PENDING_REVIEW。
8. **Close**：再次 snapshot Palabra glossary state；產生 per-arm verdict、limitations、checksums 與 immutable evidence bundle。

## 固定 test matrix

| Stage | 定義 | Physical observations/executions | Semantic denominator |
|---|---|---:|---:|
| Discovery | 約100 terms/direction ×3，只跑 OPENAI_NATIVE_TRANSLATE | 約600 | 0；排除於 proof |
| **Formal semantics（headline）** | 40 unique cases/direction ×3 arms | **240 unique runs** | 每方向 20 positive＋10 confuser＋10 ordinary |
| Clean/noise renders（diagnostic executions） | 240 canonical runs ×2 pinned renders | 480 physical executions；**不得稱為 formal runs** | 不增加 denominator |
| Latency | 每 arm×direction×condition：6 stratified probes ×5 repeats=30 | 360 | 不增加；建議 probes 為 positive/confuser/ordinary 各2 |
| Interruptions | 每 arm：5 A-interrupts-B＋5 B-interrupts-A＋5 A→B two-second overlap＋5 B→A two-second overlap | **20/arm；60 total** | 20 unique scenarios/arm |
| Continuous duplex | 每 arm 一次 10 分鐘 | 3 sessions／共30分鐘 | 不適用 |

每個 arm 恰有 **20** 個 interruption runs：5 A-interrupts-B、5 B-interrupts-A、5 A→B two-second overlap、5 B→A two-second overlap；三個 arms 合計 **60**。Harness generation fence 必須記 `generation_cut`、`playout_clear` 與所有 cut 後 samples；provider cancel/flush 只是附加診斷。

## Timestamp、alignment 與 queue schema

每個事件一行 JSONL，至少含 `suite_id/block_id/run_id`、arm/profile hash、fixture/noise hash、direction/condition/repeat、generation/sequence、event_name、`harness_mono_ns`、UTC audit time、payload hash 與 source。Harness monotonic ns 是唯一 headline clock。

受控事件至少含：`speech_onset`、`source_text_stable`、`translation_ready`、`term_bound`、`target_committed`、`target_validated`、`playout_first_sample`、`aligned_target_audio_onset`、`queue_sample`、`barge_in_speech_onset`、`generation_cut`、`playout_clear`、`valid_output_resumed`、`provider_error`、`recording_closed`。

- `aligned_target_audio_onset`：從 output loopback recording 對 committed target 做 target forced alignment；每個 headline marker 都須有 blinded reviewer 的 accepted/corrected audit 才能 final。
- `speech_to_aligned_ms = aligned_target_audio_onset − speech_onset`。
- `stable_source_to_playable_ms = playout_first_sample − source_text_stable`。
- `glossary_overhead_ms = target_validated − translation_ready`，只在相同 input/seed 的 paired GLOSSARY_CONTROLLED replay 計算。
- `queue_age_ms` 在 continuous run 形成 time series；任一 sliding 5-minute window 的 Theil–Sen slope **>50 ms/min**，或任何 queue age **>2,000 ms**，即 FAIL。

## Closed latency gates

Headline latency 只使用 clean fixtures，並對每個 direction×scenario_class（ordinary/protected）分別判定，不跨方向或 scenario class 平均；factory-noise 只作 diagnostic strata：

| Gate | 門檻 |
|---|---|
| Palabra-relative speech→aligned | 每個非-reference arm：paired delta p50 ≤+250 ms，p95 ≤+400 ms；ordinary/protected 同一門檻 |
| Stable source→playable | p50 ≤900 ms，p95 ≤1,600 ms |
| Glossary overhead | GLOSSARY_CONTROLLED paired replay p95 ≤100 ms |
| Absolute speech→aligned | p95 ≤2,000 ms |
| Queue trend | Theil–Sen 規則與 2,000 ms queue-age ceiling 均不得觸發 |

缺少預期 output、provider error 或無法產生產品結果是 FAIL，不得當成 INVALID_RUN。Palabra paired output 不足以算相對 gate 時，該結果先 PENDING_REVIEW；reviewer 決定是否需有效重跑，不能自動宣告通過。

## Deterministic verdict algorithm

只使用以下五種狀態，依序判定：

1. **INVALID_RUN**：只限 protocol/clock/input/recording/evidence integrity，例如 fixture/hash 不符、monotonic clock 中斷、loopback recording 損壞、mandatory evidence 遺失、arm freeze tuple 或 Palabra glossary snapshot 在 block 中改變。保留原紀錄並用同一 frozen profile 重跑。
2. **PENDING_REVIEW**：integrity 有效，但 bilingual semantic review、blinded forced-alignment audit或必要 adjudication 尚未完成。
3. **FAIL**：任何產品 hard failure，包括 hidden positives 未達 20/20、任何 positive binding/quality miss、committed/bound target_exact breach、confirmed Major/Critical semantic error、confuser false bind、missing output/provider error、任一 closed latency/queue gate、或 generation fence 後仍播放舊 generation sample。
4. **CONDITIONAL_PASS**：只限所有 quality gates（含 hidden positives 20/20 與 target_exact）、所有 absolute latency/overhead/queue/generation gates均通過，paired hidden-term comparison 已建立 term advantage，但唯一未達 green 的項目是 Palabra-relative p50 +250 ms／p95 +400 ms 且僅為略 miss。必須列 exact delta、case IDs、限制與 Owner condition；不得包裝任何 positive miss、quality、absolute 或 evidence failure。
5. **PASS**：review 完成，所有 quality、absolute、queue、generation gates 與 Palabra-relative green targets 全部通過。Observable Fail-Open events 不阻擋 PASS，仍須在 metrics/alerts 依 type、case 與 direction 分報。

Spoken-pronunciation diagnostic 不進上述分支。Suite 有任何 unresolved INVALID_RUN 或 PENDING_REVIEW 時不能給 final PASS；三個 arms 各自出 verdict，GLOSSARY_CONTROLLED 是本 ticket 的產品判定 arm。

## Evidence outputs 與 retention

Immutable bundle 至少包含：`manifest.json`、三份 arm manifests、Palabra before/after glossary snapshots＋hashes、corpus/noise manifest、`events.jsonl`、loopback index、forced-alignment results/audits、automatic checks、human ratings/adjudications、failure-mining lineage、change sets、healing time/cost ledger、queue series、metrics summary、per-arm verdict、limitations、`checksums.sha256`。

Raw audio、transcripts、events、provider payloads與 reviewer packets 預設保留 **14 天**；Owner 有明確理由時可延長，但硬上限 **30 天**，到期刪除並記 deletion receipt。非敏感 aggregate verdict 與 checksums 可留在 ticket；credentials/secrets 永不進 bundle。不得設定 90 天 retention。
