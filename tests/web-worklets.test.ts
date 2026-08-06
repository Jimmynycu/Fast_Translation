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
