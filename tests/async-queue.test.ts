import assert from "node:assert/strict";
import { test } from "node:test";

import { AsyncQueue, QueueClosedError } from "../src/core/async-queue.js";

test("offer is non-blocking and a bounded queue rejects overflow", async () => {
  const queue = new AsyncQueue<number>(2);
  assert.equal(queue.offer(1), true);
  assert.equal(queue.offer(2), true);
  assert.equal(queue.offer(3), false);
  assert.equal(queue.size, 2);
  const iterator = queue[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { value: 1, done: false });
  assert.deepEqual(await iterator.next(), { value: 2, done: false });
});

test("offerLatest evicts oldest buffered work to preserve freshness", async () => {
  const queue = new AsyncQueue<number>(2);
  assert.equal(queue.offerLatest(1), "accepted");
  assert.equal(queue.offerLatest(2), "accepted");
  assert.equal(queue.offerLatest(3), "dropped_oldest");
  const iterator = queue[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { value: 2, done: false });
  assert.deepEqual(await iterator.next(), { value: 3, done: false });
  queue.close();
  assert.equal(queue.offerLatest(4), "closed");
});

test("offer resolves a waiting consumer without buffering", async () => {
  const queue = new AsyncQueue<string>(1);
  const iterator = queue[Symbol.asyncIterator]();
  const waiting = iterator.next();
  assert.equal(queue.pendingConsumers, 1);
  assert.equal(queue.offer("ready"), true);
  assert.deepEqual(await waiting, { value: "ready", done: false });
  assert.equal(queue.size, 0);
  assert.equal(queue.pendingConsumers, 0);
});

test("close drains buffered values and then ends iteration", async () => {
  const queue = new AsyncQueue<number>(2);
  queue.offer(1);
  queue.offer(2);
  assert.equal(queue.close(), true);
  assert.equal(queue.close(), false);
  assert.equal(queue.offer(3), false);
  const values: number[] = [];
  for await (const value of queue) values.push(value);
  assert.deepEqual(values, [1, 2]);
  assert.equal(queue.closed, true);
});

test("close wakes all waiting consumers", async () => {
  const queue = new AsyncQueue<number>(1);
  const first = queue[Symbol.asyncIterator]();
  const second = queue[Symbol.asyncIterator]();
  const firstNext = first.next();
  const secondNext = second.next();
  queue.close();
  assert.deepEqual(await firstNext, { value: undefined, done: true });
  assert.deepEqual(await secondNext, { value: undefined, done: true });
});

test("close(error) rejects pending and future reads with the same reason", async () => {
  const queue = new AsyncQueue<number>(1);
  const iterator = queue[Symbol.asyncIterator]();
  const waiting = iterator.next();
  const failure = new Error("provider disconnected");
  queue.close(failure);
  await assert.rejects(waiting, failure);
  await assert.rejects(iterator.next(), failure);
  assert.equal(queue.close(new Error("ignored")), false);
});

test("capacity must be a positive safe integer", () => {
  assert.throws(() => new AsyncQueue(0), RangeError);
  assert.throws(() => new AsyncQueue(1.5), RangeError);
  assert.throws(() => new AsyncQueue(Number.MAX_SAFE_INTEGER + 1), RangeError);
});

test("throwing from an iterator does not close the shared queue", async () => {
  const queue = new AsyncQueue<number>(1);
  const iterator = queue[Symbol.asyncIterator]();
  await assert.rejects(iterator.throw!(new QueueClosedError("consumer stopped")));
  assert.equal(queue.closed, false);
  assert.equal(queue.offer(4), true);
});

test("return cancels a pending read so it cannot consume a later value", async () => {
  const queue = new AsyncQueue<number>(1);
  const abandoned = queue[Symbol.asyncIterator]();
  const pending = abandoned.next();
  await abandoned.return!();
  assert.equal(queue.pendingConsumers, 0);
  assert.deepEqual(await pending, { value: undefined, done: true });
  assert.equal(queue.offer(7), true);
  const active = queue[Symbol.asyncIterator]();
  assert.deepEqual(await active.next(), { value: 7, done: false });
});
