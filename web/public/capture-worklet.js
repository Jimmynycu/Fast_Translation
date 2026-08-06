class RelayPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = (options && options.processorOptions) || {};
    this.inputSampleRate = Number(settings.inputSampleRate) || sampleRate;
    this.targetSampleRate = Number(settings.targetSampleRate) || 24000;
    this.frameSamples = Number(settings.frameSamples) || 480;
    this.resampleStep = this.inputSampleRate / this.targetSampleRate;
    this.source = [];
    this.readPosition = 0;
    this.frameBuffer = new ArrayBuffer(this.frameSamples * 2);
    this.frameView = new DataView(this.frameBuffer);
    this.frameIndex = 0;
    this.frameEnergy = 0;
    this.speaking = false;
    this.loudFrames = 0;
    this.quietFrames = 0;
  }

  updateVad(rms) {
    const startThreshold = 0.018;
    const stopThreshold = 0.010;

    if (!this.speaking) {
      this.loudFrames = rms >= startThreshold ? this.loudFrames + 1 : 0;
      if (this.loudFrames >= 2) {
        this.speaking = true;
        this.quietFrames = 0;
        this.port.postMessage({ type: "vad", active: true });
      }
      return;
    }

    this.quietFrames = rms < stopThreshold ? this.quietFrames + 1 : 0;
    if (this.quietFrames >= 15) {
      this.speaking = false;
      this.loudFrames = 0;
      this.port.postMessage({ type: "vad", active: false });
    }
  }

  emitSample(sampleValue) {
    const sample = Math.max(-1, Math.min(1, sampleValue));
    const pcm = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    this.frameView.setInt16(this.frameIndex * 2, pcm, true);
    this.frameEnergy += sample * sample;
    this.frameIndex += 1;

    if (this.frameIndex !== this.frameSamples) return;

    const rms = Math.sqrt(this.frameEnergy / this.frameSamples);
    const completed = this.frameBuffer;
    this.updateVad(rms);
    this.port.postMessage({ type: "frame", pcm: completed, rms }, [completed]);
    this.frameBuffer = new ArrayBuffer(this.frameSamples * 2);
    this.frameView = new DataView(this.frameBuffer);
    this.frameIndex = 0;
    this.frameEnergy = 0;
  }

  resample() {
    while (this.readPosition + 1 < this.source.length) {
      const leftIndex = Math.floor(this.readPosition);
      const fraction = this.readPosition - leftIndex;
      const left = this.source[leftIndex];
      const right = this.source[leftIndex + 1];
      this.emitSample(left + (right - left) * fraction);
      this.readPosition += this.resampleStep;
    }

    const consumed = Math.floor(this.readPosition);
    if (consumed > 0) {
      this.source.splice(0, consumed);
      this.readPosition -= consumed;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (output) output.forEach((channel) => channel.fill(0));
    if (!input || input.length === 0 || input[0].length === 0) return true;

    const channelCount = input.length;
    const sampleCount = input[0].length;
    for (let index = 0; index < sampleCount; index += 1) {
      let mono = 0;
      for (let channel = 0; channel < channelCount; channel += 1) {
        mono += input[channel][index] || 0;
      }
      this.source.push(mono / channelCount);
    }
    this.resample();
    return true;
  }
}

registerProcessor("relay-pcm-capture", RelayPcmCaptureProcessor);
