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
    this.maximumSamples = Math.round(this.sourceSampleRate * 1.2);
    this.targetSamples = Math.round(this.sourceSampleRate * 0.7);

    this.port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "clear") {
        this.clear(Number(message.generation));
      } else if (message.type === "push") {
        this.push(message);
      }
    };
  }

  clear(generation) {
    if (!Number.isFinite(generation) || generation <= this.generation) return;
    const isNewGeneration = generation > this.generation;
    this.generation = generation;
    if (isNewGeneration) this.lastSequence = -1;
    this.queue.length = 0;
    this.current = null;
    this.position = 0;
  }

  bufferedSamples() {
    let total = this.current ? Math.max(0, this.current.samples.length - this.position) : 0;
    for (const chunk of this.queue) total += chunk.samples.length;
    return total;
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
    const samples = message.samples;
    if (
      !Number.isFinite(generation) ||
      !Number.isFinite(sequence) ||
      !(samples instanceof Float32Array) ||
      samples.length === 0
    ) {
      return;
    }
    if (generation < this.generation) return;
    if (generation > this.generation) this.clear(generation);
    if (sequence <= this.lastSequence) return;

    this.lastSequence = sequence;
    this.queue.push({ generation, sequence, samples });
    this.trimLatency();
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
    return true;
  }
}

registerProcessor("relay-pcm-playout", RelayPcmPlayoutProcessor);
