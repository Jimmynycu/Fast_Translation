import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

interface SocketLike {
  readyState: number;
  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void;
  close(code?: number, reason?: string): void;
}

interface SupervisorLike {
  readonly socket: SocketLike | null;
  readonly running: boolean;
  start(): Promise<SocketLike>;
  stop(code?: number, reason?: string): void;
}

interface SupervisorConstructor {
  new (options: Record<string, unknown>): SupervisorLike;
}

class FakeSocket implements SocketLike {
  readyState = 1;
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  readonly #listeners: Array<{ listener: () => void; once: boolean }> = [];

  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void {
    if (type === "close") this.#listeners.push({ listener, once: options?.once === true });
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.closes.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
    const listeners = this.#listeners.slice();
    for (const entry of listeners) entry.listener();
    for (const entry of listeners) {
      if (entry.once) this.#listeners.splice(this.#listeners.indexOf(entry), 1);
    }
  }
}

async function supervisorConstructor(): Promise<SupervisorConstructor> {
  const url = pathToFileURL(
    resolve(process.cwd(), "web", "public", "media-socket-supervisor.js"),
  );
  url.searchParams.set("test", randomUUID());
  const module = await import(url.href) as { MediaSocketSupervisor: SupervisorConstructor };
  return module.MediaSocketSupervisor;
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
}

test("media supervisor reconnects with backoff and ignores stale socket closure", async () => {
  const MediaSocketSupervisor = await supervisorConstructor();
  const first = new FakeSocket();
  const second = new FakeSocket();
  const sockets = [first, second];
  const timers: Array<() => void> = [];
  const cleared: unknown[] = [];
  const opened: boolean[] = [];
  const retries: number[] = [];
  let disconnected = 0;
  const supervisor = new MediaSocketSupervisor({
    connect: async () => {
      const socket = sockets.shift();
      if (!socket) throw new Error("no more sockets");
      return socket;
    },
    onOpen: (_socket: SocketLike, detail: { reconnected: boolean }) => {
      opened.push(detail.reconnected);
    },
    onDisconnect: () => {
      disconnected += 1;
    },
    onRetry: (_error: Error, delayMs: number) => retries.push(delayMs),
    setTimeoutFn: (callback: () => void) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeoutFn: (timer: unknown) => cleared.push(timer),
    baseDelayMs: 250,
    maximumDelayMs: 1_000,
  });

  assert.equal(await supervisor.start(), first);
  assert.deepEqual(opened, [false]);
  first.close(1006, "network changed");
  assert.equal(disconnected, 1);
  assert.deepEqual(retries, [250]);
  assert.equal(supervisor.socket, null);

  timers.shift()?.();
  await flushPromises();
  assert.equal(supervisor.socket, second);
  assert.deepEqual(opened, [false, true]);
  first.close(1006, "stale duplicate close");
  assert.equal(disconnected, 1);

  supervisor.stop(1000, "done");
  assert.equal(supervisor.running, false);
  assert.deepEqual(second.closes, [{ code: 1000, reason: "done" }]);
  assert.deepEqual(cleared, []);
});

test("media supervisor retries failed reconnects and cancels pending retry on stop", async () => {
  const MediaSocketSupervisor = await supervisorConstructor();
  const first = new FakeSocket();
  const timers: Array<() => void> = [];
  const delays: number[] = [];
  let attempts = 0;
  const supervisor = new MediaSocketSupervisor({
    connect: async () => {
      attempts += 1;
      if (attempts === 1) return first;
      throw new Error("offline");
    },
    onRetry: (_error: Error, delayMs: number) => delays.push(delayMs),
    setTimeoutFn: (callback: () => void) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeoutFn: () => undefined,
    baseDelayMs: 100,
    maximumDelayMs: 400,
  });

  await supervisor.start();
  first.close();
  assert.deepEqual(delays, [100]);
  timers.shift()?.();
  await flushPromises();
  assert.deepEqual(delays, [100, 200]);
  supervisor.stop();
  timers.shift()?.();
  await flushPromises();
  assert.equal(attempts, 2, "stopped supervisor must not reconnect");
});
