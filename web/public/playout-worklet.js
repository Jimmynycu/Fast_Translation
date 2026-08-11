class RelayPcmPlayoutProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = (options && options.processorOptions) || {};
    this.sourceSampleRate = Number(settings.sourceSampleRate) || 24000;
    this.playbackStep = this.sourceSampleRate / sampleRate;
    this.generation = -1;
    this.lastSequence = -1;
    this.queue = [];
    this.current = null;
    this.position = 0;
    this.interrupted = false;
    this.lane = null;
    this.latestClear = null;
    this.clearReceipts = new Map();
    this.clearReceiptOrder = [];
    this.maximumClearReceipts = 256;
    this.maximumSamples = Math.round(this.sourceSampleRate * 1.2);
    this.targetSamples = Math.round(this.sourceSampleRate * 0.7);
    this.telemetryFrameSamples = Math.max(1, Math.round(this.sourceSampleRate / 50));
    this.telemetryCapacityFrames = Math.max(
      1,
      Math.floor(this.maximumSamples / this.telemetryFrameSamples),
    );
    this.renderedAtMs = 0;
    this.lastTelemetryAtMs = -Infinity;
    this.lastTelemetryDepthFrames = -1;
    this.lastTelemetryGeneration = -1;

    this.port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "clear") {
        this.clear(message);
      } else if (message.type === "interrupt") {
        this.interrupt(message);
      } else if (message.type === "push") {
        this.push(message);
      }
    };
  }

  isLane(lane) {
    return lane === "A_TO_B" || lane === "B_TO_A";
  }

  isClearId(clearId) {
    return typeof clearId === "string" && clearId.trim().length > 0 && clearId.length <= 256;
  }

  advanceGeneration(generation) {
    if (!Number.isSafeInteger(generation) || generation < this.generation) return false;
    if (generation === this.generation) return true;
    this.generation = generation;
    this.lastSequence = -1;
    this.queue.length = 0;
    this.current = null;
    this.position = 0;
    this.latestClear = null;
    return true;
  }

  rememberClear(clearId, lane, generation) {
    this.clearReceipts.set(clearId, { lane, generation });
    this.clearReceiptOrder.push(clearId);
    while (this.clearReceiptOrder.length > this.maximumClearReceipts) {
      const expired = this.clearReceiptOrder.shift();
      if (expired) this.clearReceipts.delete(expired);
    }
  }

  clear(message) {
    const generation = Number(message.generation);
    const lane = message.lane;
    const clearId = message.clearId;
    if (!Number.isSafeInteger(generation) || generation < 0 || !this.isLane(lane) || !this.isClearId(clearId)) {
      return;
    }
    const prior = this.clearReceipts.get(clearId);
    if (prior) {
      if (prior.lane === lane && prior.generation === generation) {
        this.port.postMessage({ type: "clear_applied", lane, generation, clearId });
      }
      return;
    }
    if (generation === this.generation && this.lane !== null && this.lane !== lane) return;
    if (
      this.latestClear &&
      this.latestClear.generation === generation &&
      this.latestClear.clearId !== clearId
    ) {
      return;
    }
    if (generation < this.generation || !this.advanceGeneration(generation)) return;
    this.lane = lane;
    this.rememberClear(clearId, lane, generation);
    this.latestClear = { lane, generation, clearId };
    this.interrupted = false;
    this.reportQueueSample(true);
    this.port.postMessage({ type: "clear_applied", lane, generation, clearId });
  }

  interrupt(message) {
    const lane = message.lane;
    if (!this.isLane(lane)) return;
    if (this.lane !== null && this.lane !== lane) return;
    this.lane = lane;
    this.interrupted = true;
    this.queue.length = 0;
    this.current = null;
    this.position = 0;
    this.reportQueueSample(true);
  }

  bufferedSamples() {
    let total = this.current ? Math.max(0, this.current.samples.length - this.position) : 0;
    for (const chunk of this.queue) total += chunk.samples.length;
    return total;
  }

  depthFrames() {
    return this.queue.length + (this.current ? 1 : 0);
  }

  oldestQueuedAtMs() {
    if (this.current) return this.current.enqueuedAtMs;
    const next = this.queue[0];
    return next ? next.enqueuedAtMs : this.renderedAtMs;
  }

  reportQueueSample(force) {
    if (!this.isLane(this.lane) || this.generation < 0) return;
    const depthFrames = this.depthFrames();
    const due = this.renderedAtMs - this.lastTelemetryAtMs >= 100;
    if (
      !force &&
      !due &&
      depthFrames === this.lastTelemetryDepthFrames &&
      this.generation === this.lastTelemetryGeneration
    ) {
      return;
    }
    const bufferedSamples = this.bufferedSamples();
    this.port.postMessage({
      type: "queue_sample",
      lane: this.lane,
      generation: this.generation,
      depthFrames,
      capacityFrames: this.telemetryCapacityFrames,
      bufferedAudioMs: (bufferedSamples * 1000) / this.sourceSampleRate,
      oldestQueuedAgeMs: Math.max(0, this.renderedAtMs - this.oldestQueuedAtMs()),
    });
    this.lastTelemetryAtMs = this.renderedAtMs;
    this.lastTelemetryDepthFrames = depthFrames;
    this.lastTelemetryGeneration = this.generation;
  }

  reportDropped(chunk) {
    this.port.postMessage({
      type: "playout_dropped",
      generation: chunk.generation,
      sequence: chunk.sequence,
    });
  }

  trimLatency() {
    let buffered = this.bufferedSamples();
    if (buffered <= this.maximumSamples) return;

    if (this.current) {
      const dropped = this.current;
      buffered -= Math.max(0, dropped.samples.length - this.position);
      this.current = null;
      this.position = 0;
      this.reportDropped(dropped);
    }
    while (this.queue.length > 1 && buffered > this.targetSamples) {
      const dropped = this.queue.shift();
      if (!dropped) break;
      buffered -= dropped.samples.length;
      this.reportDropped(dropped);
    }
  }

  push(message) {
    const generation = Number(message.generation);
    const sequence = Number(message.sequence);
    const lane = message.lane;
    const samples = message.samples;
    if (
      !Number.isSafeInteger(generation) ||
      generation < 0 ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      !this.isLane(lane) ||
      !(samples instanceof Float32Array) ||
      samples.length === 0
    ) {
      return;
    }
    if (this.interrupted) return;
    if (generation < this.generation) return;
    if (generation > this.generation) {
      if (!this.advanceGeneration(generation)) return;
      this.lane = lane;
    } else if (this.lane !== null && this.lane !== lane) {
      return;
    } else if (this.lane === null) {
      this.lane = lane;
    }
    if (sequence <= this.lastSequence) return;

    this.lastSequence = sequence;
    this.queue.push({ generation, sequence, samples, enqueuedAtMs: this.renderedAtMs });
    this.trimLatency();
    this.reportQueueSample(true);
  }

  nextChunk() {
    if (this.current && this.position < this.current.samples.length) return true;
    const carry = this.current
      ? Math.max(0, this.position - this.current.samples.length)
      : 0;
    const next = this.queue.shift();
    if (!next) {
      this.current = null;
      this.position = 0;
      return false;
    }
    this.current = next;
    this.position = carry;
    this.port.postMessage({
      type: "playout_started",
      generation: next.generation,
      sequence: next.sequence,
    });
    return true;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const mono = output[0];

    for (let index = 0; index < mono.length; index += 1) {
      if (!this.nextChunk()) {
        mono[index] = 0;
        continue;
      }

      const leftIndex = Math.floor(this.position);
      const fraction = this.position - leftIndex;
      const samples = this.current.samples;
      const left = samples[leftIndex] || 0;
      const right =
        leftIndex + 1 < samples.length ? samples[leftIndex + 1] : left;
      mono[index] = left + (right - left) * fraction;
      this.position += this.playbackStep;
    }

    for (let channel = 1; channel < output.length; channel += 1) {
      output[channel].set(mono);
    }
    this.renderedAtMs += (mono.length * 1000) / sampleRate;
    this.reportQueueSample(false);
    return true;
  }
}

registerProcessor("relay-pcm-playout", RelayPcmPlayoutProcessor);
