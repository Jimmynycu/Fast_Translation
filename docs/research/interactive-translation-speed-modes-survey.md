# Interactive translation speed modes survey

**Research date:** 2026-08-08 (Asia/Taipei)
**Scope:** Current Palabra public documentation, API reference, and official SDK source, official OpenAI Realtime translation/transcription documentation, plus first-party Google Cloud and Microsoft Azure speech-translation documentation where it gives a useful comparison. No private code, credentials, or secondary sources were used.

## PM decision summary (繁中)

整體結論：**YES（有條件）**。Palabra 的 black-box Speech-to-Speech E2E 是主路徑；OpenAI native 與 OpenAI controlled 是可在 TranslationPort 選擇的獨立替代 pipeline。Fast / Balanced / Accurate 三模式與 interruption contract 只代表外層行為契約，不代表 provider 內部同等；OpenAI dedicated translation 先定位為 Fast-capable，其他模式要等同一 corpus benchmark 驗證。

- **已存在**：Relay 已有 generation cut/fence 與 `media.clear`；目前設定可切換 profile。現有語意仍綁在 profile 名稱：`native_live_baseline` 是 continuous、`glossary_controlled` 是 final-sentence、`palabra_live` 是 final/per-utterance，尚無獨立 mode 設定（見 [architecture](../implementation-architecture.md)、[`src/config.ts`](../../src/config.ts)）。
- **需開發**：抽出 provider-independent `TranslationBehavior`（放入 `SessionSpec` / `LaneContext`）；把 `TranslationEvent` 改成 revision-aware 的 stable ID / replacement / final contract；加入 capability/parity tests；在 OpenAI adapter 實作 local holdback/commit、playout queue、generation fence。
- **供應商限制**：Palabra 原生提供 partial/silence/queue/tempo/flush；OpenAI dedicated translation 目前公開文件只承諾 continuous 200 ms streaming，沒有相同的 speed/granularity/glossary/cancel controls。`glossary_controlled` 與嚴格 per-utterance semantics 不能宣稱跨 provider parity，除非採用額外 chained capabilities 或本地 policy。

Palabra native Glossaries apply only to Palabra Speech-to-Speech pipelines, not OpenAI; Harness still owns glossary version/evidence governance ([Palabra Glossaries](https://docs.palabra.ai/docs/glossaries)).

## Executive decision

Palabra exposes the controls needed to build application-level speed modes, but it does not publish named Fast/Balanced/Accurate presets or an end-to-end latency SLA. The relevant controls are segment-confirmation silence, whether unconfirmed text is translated, sentence splitting, TTS queue targets/limits, tempo correction, and the set of events delivered over the stream ([settings reference](https://docs.palabra.ai/docs/streaming_api/translation_settings_breakdown), [recommended settings](https://docs.palabra.ai/docs/streaming_api/recommended_settings)). The mode values below are therefore product profiles to benchmark, not Palabra guarantees.

Recommended default: ship **Balanced** first, expose **Fast/Streaming** for users who value responsiveness, and keep **Accurate/Sentence** as an explicitly higher-latency experiment until corpus measurements show that its extra waiting improves final text or spoken-term accuracy.

For barge-in, use Palabra's `flush_task` with `pause_task: false`, clear any locally queued but unplayed translated audio for the affected lane, fence late events by their stable IDs, and continue that lane on its existing task/socket after a successful flush. Model the two Palabra directions as independent lanes/sessions; flush only the affected lane while both capture lanes remain live. Palabra documents flush as cancelling the current phrase without pausing subsequent phrases; it does not document a client-side audio-queue operation, so local playback clearing and stale-event fencing are application responsibilities ([management API](https://docs.palabra.ai/docs/streaming_api/management), [audio events](https://docs.palabra.ai/docs/streaming_api/publishing_and_receiving_audio)).

## What Palabra makes configurable

### Segment confirmation and finality

`segment_confirmation_silence_threshold` is the amount of silence, in seconds, used to confirm a segment. Palabra documents a valid range of **0.3-2.0 seconds**, a default of **0.7 seconds**, and a recommended range of **0.5-0.9 seconds**. Its guidance says a larger value tolerates pauses inside a phrase, while a value that is too low can split a sentence unexpectedly ([settings reference](https://docs.palabra.ai/docs/streaming_api/translation_settings_breakdown)).

`translate_partial_transcriptions` enables translation of unconfirmed transcription segments. The stream can separately request `partial_transcription`, `partial_translated_transcription`, `validated_transcription`, and `translated_transcription`; validated and translated messages represent completed segments ([settings reference](https://docs.palabra.ai/docs/streaming_api/translation_settings_breakdown), [management response schemas](https://docs.palabra.ai/docs/streaming_api/management)).

The official Python SDK exposes the distinction as partial versus validated `Transcript` events and warns that a segment's tail can be rewritten while it is still in progress; consumers should render the current full text rather than blindly append every partial delta ([official Python SDK](https://github.com/PalabraAI/palabra-ai-python#events)). This is the core speed/accuracy tradeoff: partial output can arrive earlier, but it is provisional.

Palabra also exposes an optional sentence splitter. The settings reference describes it as a way to split longer sentences into smaller parts to speed processing, sometimes with slight rephrasing while preserving meaning; it is not an accuracy guarantee ([settings reference](https://docs.palabra.ai/docs/streaming_api/translation_settings_breakdown)).

### Audio pacing and queue/tempo

For WebSocket audio, Palabra documents `pcm_s16le`, `opus`, and `wav` input, a 16-48 kHz input range, and one or two input channels. Output PCM is fixed at 24 kHz mono. The documented optimal input chunk is **320 ms**, and the server warns that sending audio faster, slower, or stopping mid-stream degrades quality ([audio publishing](https://docs.palabra.ai/docs/streaming_api/publishing_and_receiving_audio), [management API](https://docs.palabra.ai/docs/streaming_api/management)).

`translation_queue_configs` controls the unspoken TTS buffer, not the recognizer's segment-confirmation wait. Palabra documents:

- `desired_queue_level_ms`: target average TTS buffer, recommended 5,000-10,000 ms;
- `max_queue_level_ms`: upper limit; when exceeded, older queued audio is dropped back toward the desired level;
- `auto_tempo`: adjusts speech speed to follow queue state;
- `min_tempo` / `max_tempo`: allowed speaking-speed bounds; and
- `auto_tempo_max_delay_ms`: maximum delay used by tempo correction.

Without an explicit queue config, Palabra documents a global default of 5,000 ms desired, 20,000 ms maximum, `auto_tempo: true`, `min_tempo: 1.15`, and `max_tempo: 1.45` ([queue settings](https://docs.palabra.ai/docs/streaming_api/translation_settings_breakdown), [recommended settings](https://docs.palabra.ai/docs/streaming_api/recommended_settings)). A smaller queue can reduce playback backlog but leaves less jitter headroom; that tradeoff is an application hypothesis that must be measured under the target network and speaker conditions.

### Flush, interruption, and continuity

Palabra's documented command sequence is `set_task` -> audio/events -> optional `pause_task`, `flush_task`, or another `set_task` -> `end_task`. `flush_task` cancels processing of the current phrase without pausing later phrases; its `languages` value can be `global` or selected targets, and `pause_task: false` keeps the task running. `end_task` is different: the server closes the connection after finalization, with `eos_timeout` (1-30 seconds) and `force` controlling tail handling ([management API](https://docs.palabra.ai/docs/streaming_api/management)).

The audio response includes `transcription_id`, `translation_part_id`, `last_chunk`, and base64 audio. Transcript messages carry the same stable `transcription_id`, with translation parts where applicable ([audio receiving](https://docs.palabra.ai/docs/streaming_api/publishing_and_receiving_audio), [management response schemas](https://docs.palabra.ai/docs/streaming_api/management)). A client can therefore retain IDs from a flushed phrase, discard late transcript/audio events for those IDs, and avoid reconnecting after an otherwise successful barge-in. This ID fence is a client-side safety policy; Palabra does not publish a guarantee that no late event can arrive after `flush_task`.

Palabra's current Python SDK explicitly has **no automatic WebSocket reconnect**: a session is tied to one connection and server-side pipeline state, and transparent resume could lose in-flight audio and transcription context. Recovery is an application-level retry that decides what state to restore ([official Python SDK reconnection guidance](https://github.com/PalabraAI/palabra-ai-python#reconnection)).

## Feasibility matrix

The ranges in this table are proposed starting profiles. They stay within Palabra's documented parameter bounds where a bound exists; they are not vendor-prescribed presets. Every profile still needs the same corpus and network benchmark.

| Mode | Initial Palabra profile | Expected behavior | Accuracy/latency risk | Feasibility |
|---|---|---|---|---|
| **Fast / Streaming** | `segment_confirmation_silence_threshold`: test 0.3-0.5 s; `translate_partial_transcriptions: true`; request partial and final transcript/translation events; sentence splitter on; desired TTS queue 2-5 s with a conservative maximum; `auto_tempo: true`; send 320 ms input chunks at real-time pace. | Earliest provisional text/audio and shorter phrase commits. | More partial revisions and more short splits; a too-small queue can underrun during jitter. The 0.3-0.5 range is an intentional low-latency experiment, not a Palabra preset. | **Directly implementable** with `set_task`; quality must be measured. |
| **Balanced** | Threshold around the documented 0.7 s default; `translate_partial_transcriptions: false`; consume validated and translated finals; sentence splitter on; use the documented 5 s desired/20 s maximum queue defaults with `auto_tempo` and 1.15-1.45 tempo bounds. | Stable segment boundaries and predictable speech pacing without waiting for very long sentences. | More confirmation delay than Fast; queue backlog can still grow on slow networks or long output. | **Best first product default**; directly implementable and aligned with Palabra's recommended example. |
| **Accurate / Sentence** | Test 0.9-1.5 s threshold (within Palabra's 0.3-2.0 s limit, but above its usual 0.5-0.9 s recommendation); partial translation off; `sentence_splitter.enabled: false`; finals only; queue 5-10 s desired and a larger maximum; keep tempo correction on. Treat `auto_transcription_correction` as experimental because the reference labels it WIP. | Longer, more complete segments and fewer pause-induced splits before final translation/TTS. | Highest time-to-final-output; waiting longer does not prove better translation accuracy, and the range above 0.9 s is a hypothesis to validate. | **Feasible as a benchmark profile**, not an accuracy guarantee. |
| **Barge-in / persistent stream** | On opposite-side speech onset, immediately clear the interrupted output lane and increment a local generation without stopping either microphone or capture stream; send `flush_task` with `languages: ["global"]` and `pause_task: false`, then continue the affected lane on its existing task/socket; the other direction keeps its own independent task/socket. Both capture lanes remain live. Same-speaker continuation remains one Fast streaming lane. Drop events whose IDs belong to the flushed turn. | Fast recovery without a reconnect or task warm-up. | Already-played audio cannot be recalled; unknown late events without a usable ID remain uncorrelatable. Palabra's public docs do not promise a post-flush drain boundary. | **Feasible with an application fence**; verify cutoff and recovery with scripted overlap tests. |

## Shared outer contract: Palabra + OpenAI alternatives

Treat Palabra's black-box Speech-to-Speech E2E adapter as the primary path. OpenAI native and OpenAI controlled are independent alternative pipeline adapters selectable at the outer `TranslationPort`. They share only a provider-independent behavior contract: continuous canonical audio in, translated audio and text events out, local playout queue control, interruption, and explicit close. Provider envelopes, IDs, and unsupported knobs remain inside adapters; this outer contract does not claim identical internals or parity.

Provider boundaries are intentionally black-box:

- **Palabra**: `source audio -> Palabra Speech-to-Speech API -> translated audio` plus optional transcript/control events. Segmentation, translation, speech generation, queue, and tempo are vendor-managed settings inside one end-to-end API, not separate STT -> translation -> TTS integration calls ([Palabra Speech-to-Speech overview](https://docs.palabra.ai/docs/streaming_api), [settings breakdown](https://docs.palabra.ai/docs/streaming_api/translation_settings_breakdown)).
- **OpenAI native**: `source audio -> gpt-realtime-translate -> translated audio/transcript deltas` in one dedicated translation session ([Realtime translation guide](https://developers.openai.com/api/docs/guides/realtime-translation)).
- **OpenAI controlled**: a separate application-composed path using transcription, text translation, and TTS adapters; it is an alternative pipeline, not a hidden fallback inside native translation ([live transcription adapter](../../src/adapters/openai/live-transcribe.ts), [text translator](../../src/adapters/openai/text-translator.ts), [TTS adapter](../../src/adapters/openai/tts.ts)).

OpenAI's dedicated `gpt-realtime-translate` session streams source audio to `/v1/realtime/translations` and returns translated audio plus transcript deltas while speech continues. Its WebSocket client reference accepts 24 kHz PCM16 mono and recommends 200 ms append frames while continuously appending audio, including silence. The published dedicated translation `session.update` surface covers output language, optional input transcription, and noise reduction; it does not document Palabra-style silence thresholds, partial-translation toggles, TTS queue/tempo controls, glossary/prompt fields, or a mid-session flush event ([Realtime translation guide](https://developers.openai.com/api/docs/guides/realtime-translation), [translation client events](https://developers.openai.com/api/reference/resources/realtime/translation-client-events), [model reference](https://developers.openai.com/api/docs/models/gpt-realtime-translate)).

The dedicated translation server-event schema exposes event IDs, elapsed alignment, and 200 ms audio deltas, but not Palabra's `transcription_id` / `translation_part_id` pair. Treat local generation fencing and stable adapter IDs as mandatory rather than relying on a provider drain boundary ([translation server events](https://developers.openai.com/api/reference/resources/realtime/translation-server-events)).

### Shared profile mapping and parity matrix

In this matrix, **native** means the dedicated `gpt-realtime-translate` endpoint and **controlled** means the independent live-transcription -> text-translation -> TTS pipeline. Controlled delay, commit, and pacing choices are adapter policy and must be benchmarked separately from dedicated translation ([OpenAI Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription), [controlled adapters](../../src/adapters/openai/live-transcribe.ts)).

| Shared profile or contract | Palabra adapter mapping | OpenAI native / controlled mapping | Honest parity / degradation |
|---|---|---|---|
| **Fast / Streaming** | Low confirmation threshold experiment, partial transcription/translation enabled, sentence splitter on, short TTS queue, tempo correction, 320 ms input chunks. These are the proposed Palabra settings in the feasibility matrix above. | **Native:** Keep one continuous translation session; append 200 ms frames; consume audio/transcript deltas immediately; use local playout queue and generation fence. **Controlled:** Stream `gpt-live-transcribe` into the separate text-translation/TTS path, with local queue and pacing. | Both stream before a turn ends, but OpenAI has no documented provider queue/tempo or partial-toggle control. First-audio and revision behavior must be benchmarked; local pacing is the only shared control. |
| **Balanced** | Around the documented 0.7 s confirmation default, partial translation off, validated/final events, recommended queue defaults, and tempo correction. | **Native:** Keep the same continuous session, but assemble append-only deltas under a local holdback/commit policy. `session.update` may enable input transcription or noise reduction, but no dedicated finality knob is published. **Controlled:** Use a benchmarked live-transcription delay and local commit/TTS pacing in the composed pipeline; do not claim native finality. | Finality is native on Palabra and policy-defined on OpenAI. Do not report identical capture-to-final latency until both are measured on the same corpus. |
| **Accurate / Sentence** | Longer confirmation hypothesis, partials off, `sentence_splitter.enabled: false`, finals, larger queue; explicitly experimental above Palabra's usual threshold recommendation. | **Native:** No dedicated sentence threshold, queue/tempo, glossary, or prompt control is published. **Controlled:** Use a longer, benchmarked live-transcription delay plus context/keywords and full-sentence holdback before text translation/TTS; that is a chained design with extra latency/cost, not native translation parity ([Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription)). | Mark OpenAI Accurate as unsupported or experimental until quality and latency gates pass. Never silently substitute the chained path when a user selected dedicated translation. |
| **Barge-in / persistent stream** | On local generation cut, clear playout, send `flush_task` with `pause_task: false`, tombstone provider IDs, and continue the affected lane on its existing task/socket; the other direction has its own independent task/socket. | **Native:** The dedicated translation client reference publishes `session.close`, which gracefully flushes pending input and emits remaining outputs before closing; it does not publish a mid-session flush/cancel event. Keep both capture lanes live, clear the affected output lane, fence the old generation, and close/restart only that translation session when a strict provider cutoff is required. **Controlled:** Cancel the affected transcription/text/TTS work while both capture lanes continue, clear output, and start a new generation. | The shared application contract is local cut plus zero stale-generation playback. Native close/restart and controlled cancellation have different warm-up and context costs; neither changes the local stale-audio gate. |

The shared interruption contract is therefore: the Relay increments the local generation and executes `media.clear` first; both capture lanes continue accepting audio; each adapter then performs best-effort provider cancellation; no audio from an old generation may reach playout; and a provider without a drain or cancel primitive is still safe because the local fence is authoritative. This matches Palabra's documented `flush_task` behavior while honestly degrading OpenAI dedicated translation to local output clear plus close/restart when necessary ([Palabra management API](https://docs.palabra.ai/docs/streaming_api/management), [OpenAI translation client events](https://developers.openai.com/api/reference/resources/realtime/translation-client-events)).

OpenAI's standard Realtime VAD and conversation interruption/truncation controls are separate capabilities: semantic VAD changes chunking eagerness, and standard conversation mode can cancel/truncate a response. They must not be silently treated as controls on the dedicated translation endpoint ([Realtime VAD](https://developers.openai.com/api/docs/guides/realtime-vad), [Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations)).

## Config-only switching

Expose the provider and behavior as separate configuration dimensions:

```text
TRANSLATION_PROVIDER=palabra | openai_native | openai_controlled
TRANSLATION_MODE=fast | balanced | accurate
```

The composition root selects the pipeline from `TRANSLATION_PROVIDER`: `palabra` is the black-box Palabra Speech-to-Speech path, `openai_native` is the dedicated `gpt-realtime-translate` path, and `openai_controlled` is the separate application-composed path. It maps `TRANSLATION_MODE` to provider options and local policy. Palabra can accept live `set_task` changes ([management API](https://docs.palabra.ai/docs/streaming_api/management)), but for cross-provider consistency any mode or provider change becomes pending and applies at the next clean generation/speech boundary; never splice settings mid-phrase. Relay/core code consumes only `TranslationBehavior`, normalized `TranslationEvent` values, generation cuts, and `media.clear`; it must not branch on `palabra_live` or `native_live_baseline`. Unsupported provider features should surface capability metadata and metrics, then use the documented local degradation. Remove profile-name semantics as this seam lands rather than adding a compatibility layer. Keep adapter conformance tests for event revisions, finality, interruption, and capability reporting.

The current code already has separate OpenAI and Palabra adapters and generation-aware media clearing, but its three product profiles still bundle provider and turn semantics. The minimal seam is to move behavior into `SessionSpec` / `LaneContext`, make Relay branches behavior-based, and require a revision-aware event contract before enabling Palabra partials across providers ([core types](../../src/core/types.ts), [Relay](../../src/core/relay.ts), [OpenAI adapter](../../src/adapters/openai/native-realtime-translate.ts), [Palabra adapter](../../src/adapters/palabra/index.ts)).

## Barge-in implementation contract

1. On opposite-side speech onset, increment the affected output lane generation and immediately clear its local playout. Never stop either microphone or capture stream; same-speaker continuation remains one continuous Fast lane.
2. Call provider cancellation for the affected output lane. For Palabra, send `flush_task` (`global`, `pause_task: false`); this cancels the current phrase while keeping later phrases active ([management API](https://docs.palabra.ai/docs/streaming_api/management)). Keep both input lanes accepting audio.
3. Keep the local playout clear authoritative. A provider flush cannot undo audio already buffered or played by the application; the Palabra API only specifies cancellation of server-side phrase processing ([management API](https://docs.palabra.ai/docs/streaming_api/management)).
4. Retain the canceled turn's `transcription_id` and `(transcription_id, translation_part_id)` values in a bounded FIFO tombstone set. Ignore later transcript and `output_audio_data` messages matching those IDs. Keep the set bounded (for example, 256 IDs) so a long-lived lane cannot leak memory.
5. Keep the WebSocket/task alive after a successful flush and send the next turn at the documented real-time pace. If the transport actually fails, reconnect explicitly and report that the provider's in-flight context was lost; do not claim transparent resume ([official Python SDK reconnection guidance](https://github.com/PalabraAI/palabra-ai-python#reconnection)).

The provider's `output_audio_data` schema includes a `transcription_id`, so this fence is grounded in a documented field. If a future event lacks an ID or introduces a new event type, the adapter should fail closed for playback rather than silently mixing generations ([audio receiving](https://docs.palabra.ai/docs/streaming_api/publishing_and_receiving_audio)).

## Existing-video audit (local evidence)

The supplied local, untracked mixed screen recording `18ebae02-9e7c-444a-b53b-db74c50e3380.mp4` is 24.642 seconds and shows a bilingual English <-> Chinese UI. The displayed UI latency value, sampled at 0, 2, ..., 24 seconds, was: **91, 91, 71, 69, 69, 97, 114, 128, 121, 109, 109, 109, 109 ms**. That is an observed UI range of **69-128 ms**, with a rough center around **95-100 ms**. Mixed audio was near-continuous from about 10.50 s to 18.02 s, and the UI showed Barge-in sensitivity **Medium**.

This is a product-perception benchmark only, not a measured end-to-end latency distribution. The recording is a mixed stereo track with highly correlated channels (about 0.993), so source and translated audio onsets cannot be separated and successful barge-in cannot be proven from this file. Treat the displayed value as a vendor/UI metric. Acceptance must use the dual-track harness timestamps and the same generation-fence and stale-audio gates for both providers.

## Comparisons with other first-party streaming APIs

These providers are useful comparators for the shape of a speed-mode API; their controls and quality characteristics are not interchangeable with Palabra's.

| Provider | Latency/finality control | Accuracy tradeoff or interruption signal | Relevance to this product |
|---|---|---|---|
| **Google Cloud Speech-to-Text** | Streaming recognition returns interim results while audio is captured; `interim_results` marks results that may be refined, while final results represent the best result for a section. `single_utterance` can end a stream after pauses/silence ([streaming requests](https://docs.cloud.google.com/speech-to-text/docs/v1/speech-to-text-requests)). | Phrase adaptation can bias rare/domain terms; Google warns that stronger boost reduces false negatives but can increase false positives ([model adaptation](https://docs.cloud.google.com/speech-to-text/docs/adaptation-model)). | Confirms that Fast should expose provisional output and that terminology bias needs a measured false-positive gate. |
| **Microsoft Azure Speech Translation** | Single-shot translation ends on silence or a maximum duration; continuous translation exposes `recognizing` intermediate results and `recognized` final results ([speech translation](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-translate-speech)). | Azure documents that higher segmentation-silence time generally allows longer pauses but makes results arrive later; semantic segmentation can wait for sentence punctuation but has language/feature limitations ([segmentation guidance](https://learn.microsoft.com/en-us/azure/ai-services/Speech-Service/how-to-recognize-speech)). | Supports a Balanced/Accurate distinction, but does not establish Palabra parameter values. |

## Measurement plan and open limits

Measure each mode on the same recorded corpus, speakers, noise conditions, network path, and playback device. Record at least:

- capture-to-first-transcript and capture-to-first-audio latency (p50/p95);
- capture-to-final-transcript and final-translation latency;
- segment split rate, partial revision count, and final text exactness;
- TTS queue depth, tempo changes, and underruns;
- barge-in command-to-local-clear latency and stale-audio duration;
- stale-ID drops, unknown-ID drops, and reconnects; and
- domain-term, number, unit, negation, and proper-name accuracy.

Do not use a provider's "real time" or "minimal latency" wording as a p95 acceptance criterion. Palabra's public references specify controls, message formats, and recommended values, but not a fixed end-to-end latency or accuracy guarantee ([Speech-to-Speech overview](https://docs.palabra.ai/docs/streaming_api), [settings reference](https://docs.palabra.ai/docs/streaming_api/translation_settings_breakdown)).

The following remain open and should be treated as **not publicly guaranteed**: exact p50/p95 latency by mode; whether every post-flush event carries a usable old transcription ID; the amount of audio already buffered at the provider when flush arrives; and the accuracy improvement, if any, from waiting beyond the documented threshold recommendation. Resolve them with a live benchmark and explicit product thresholds rather than inferred provider behavior.

## Primary sources

- [Palabra Speech-to-Speech Translation API](https://docs.palabra.ai/docs/streaming_api)
- [Palabra Translation management API](https://docs.palabra.ai/docs/streaming_api/management)
- [Palabra Translation settings breakdown](https://docs.palabra.ai/docs/streaming_api/translation_settings_breakdown)
- [Palabra Recommended settings](https://docs.palabra.ai/docs/streaming_api/recommended_settings)
- [Palabra Publishing and receiving audio](https://docs.palabra.ai/docs/streaming_api/publishing_and_receiving_audio)
- [Palabra official Python SDK](https://github.com/PalabraAI/palabra-ai-python)
- [OpenAI Realtime translation guide](https://developers.openai.com/api/docs/guides/realtime-translation)
- [OpenAI gpt-realtime-translate model](https://developers.openai.com/api/docs/models/gpt-realtime-translate)
- [OpenAI translation client events](https://developers.openai.com/api/reference/resources/realtime/translation-client-events)
- [OpenAI translation server events](https://developers.openai.com/api/reference/resources/realtime/translation-server-events)
- [OpenAI Realtime VAD guide](https://developers.openai.com/api/docs/guides/realtime-vad)
- [OpenAI Realtime conversations guide](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [OpenAI Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription)
- [Google Cloud Speech-to-Text streaming requests](https://docs.cloud.google.com/speech-to-text/docs/v1/speech-to-text-requests)
- [Google Cloud Speech-to-Text model adaptation](https://docs.cloud.google.com/speech-to-text/docs/adaptation-model)
- [Microsoft Azure Speech translation](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-translate-speech)
- [Microsoft Azure speech segmentation guidance](https://learn.microsoft.com/en-us/azure/ai-services/Speech-Service/how-to-recognize-speech)
