import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

interface WorkletPort {
  onmessage?: (event: { data: unknown }) => void;
  readonly messages: unknown[];
  postMessage(message: unknown): void;
}

interface CaptureProcessor {
  readonly port: WorkletPort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

async function loadCaptureProcessor(options: {
  readonly inputSampleRate: number;
  readonly targetSampleRate: number;
  readonly frameSamples: number;
}): Promise<CaptureProcessor> {
  let Processor: (new (options: unknown) => CaptureProcessor) | undefined;
  class Port implements WorkletPort {
    onmessage?: (event: { data: unknown }) => void;
    readonly messages: unknown[] = [];
    postMessage(message: unknown): void {
      this.messages.push(structuredClone(message));
    }
  }
  class ProcessorBase {
    readonly port = new Port();
  }
  const source = await readFile(
    resolve(process.cwd(), "web", "public", "capture-worklet.js"),
    "utf8",
  );
  runInNewContext(source, {
    AudioWorkletProcessor: ProcessorBase,
    sampleRate: options.inputSampleRate,
    registerProcessor: (_name: string, candidate: typeof Processor) => {
      Processor = candidate;
    },
    ArrayBuffer,
    DataView,
    Float32Array,
    Number,
    Math,
  });
  assert.ok(Processor !== undefined);
  return new Processor({ processorOptions: options });
}

function captureFrames(processor: CaptureProcessor): Array<{
  readonly type: "frame";
  readonly pcm: ArrayBuffer;
  readonly rms: number;
}> {
  return processor.port.messages.filter((message): message is {
    readonly type: "frame";
    readonly pcm: ArrayBuffer;
    readonly rms: number;
  } =>
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "frame" &&
    "pcm" in message &&
    message.pcm instanceof ArrayBuffer
  );
}

test("capture worklet downmixes, resamples, and emits exact PCM16LE frames", async () => {
  const processor = await loadCaptureProcessor({
    inputSampleRate: 48_000,
    targetSampleRate: 24_000,
    frameSamples: 480,
  });
  const left = new Float32Array(960).fill(0.75);
  const right = new Float32Array(960).fill(0.25);
  const monitor = new Float32Array(960).fill(1);

  assert.equal(processor.process([[left, right]], [[monitor]]), true);
  assert.ok(monitor.every((sample) => sample === 0), "capture monitor must stay silent");
  const frames = captureFrames(processor);
  assert.equal(frames.length, 1);
  const frame = frames[0];
  assert.ok(frame !== undefined);
  assert.equal(frame.pcm.byteLength, 960);
  assert.ok(Math.abs(frame.rms - 0.5) < 0.000_001);
  const view = new DataView(frame.pcm);
  for (let index = 0; index < 480; index += 1) {
    assert.equal(view.getInt16(index * 2, true), 16_384);
  }
});

test("capture worklet clamps PCM and drives VAD with hysteresis", async () => {
  const processor = await loadCaptureProcessor({
    inputSampleRate: 24_000,
    targetSampleRate: 24_000,
    frameSamples: 8,
  });
  const processFrame = (value: number): void => {
    const input = new Float32Array(9).fill(value);
    assert.equal(processor.process([[input]], [[new Float32Array(9)]]), true);
  };

  processFrame(2);
  processFrame(2);
  assert.ok(processor.port.messages.some((message) =>
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "vad" &&
    "active" in message &&
    message.active === true
  ));
  const loudFrame = captureFrames(processor)[0];
  assert.ok(loudFrame !== undefined);
  const loudView = new DataView(loudFrame.pcm);
  assert.equal(loudView.getInt16(0, true), 32_767);

  for (let index = 0; index < 15; index += 1) processFrame(0);
  assert.ok(processor.port.messages.some((message) =>
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "vad" &&
    "active" in message &&
    message.active === false
  ));
});

test("playout worklet makes equal-generation clear idempotent and acks actual start", async () => {
  let Processor: (new (options: unknown) => {
    readonly port: WorkletPort;
    readonly queue: unknown[];
    process(inputs: unknown[], outputs: Float32Array[][]): boolean;
  }) | undefined;
  class Port implements WorkletPort {
    onmessage?: (event: { data: unknown }) => void;
    readonly messages: unknown[] = [];
    postMessage(message: unknown): void {
      this.messages.push(structuredClone(message));
    }
  }
  class ProcessorBase {
    readonly port = new Port();
  }
  const source = await readFile(
    resolve(process.cwd(), "web", "public", "playout-worklet.js"),
    "utf8",
  );
  runInNewContext(source, {
    AudioWorkletProcessor: ProcessorBase,
    sampleRate: 48_000,
    registerProcessor: (_name: string, candidate: typeof Processor) => {
      Processor = candidate;
    },
    Float32Array,
    Number,
    Math,
  });
  assert.ok(Processor !== undefined);
  const processor = new Processor({ processorOptions: { sourceSampleRate: 24_000 } });
  const samples = new Float32Array(480).fill(0.25);

  processor.port.onmessage?.({ data: { type: "clear", generation: 2 } });
  processor.port.onmessage?.({ data: { type: "push", generation: 2, sequence: 0, samples } });
  assert.equal(processor.queue.length, 1);
  processor.port.onmessage?.({ data: { type: "clear", generation: 2 } });
  assert.equal(processor.queue.length, 1, "late duplicate clear erased current audio");

  const output = [[new Float32Array(128)]];
  assert.equal(processor.process([], output), true);
  assert.deepEqual(processor.port.messages, [{
    type: "playout_started",
    generation: 2,
    sequence: 0,
  }]);

  for (let sequence = 1; sequence <= 70; sequence += 1) {
    const chunk = new Float32Array(480).fill(0.1);
    processor.port.onmessage?.({ data: { type: "push", generation: 2, sequence, samples: chunk } });
  }
  assert.ok(processor.port.messages.some((message) =>
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "playout_dropped"
  ));
});
