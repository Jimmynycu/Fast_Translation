import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { composeApplication, ManagedRelay } from "../src/composition.js";
import { loadConfig } from "../src/config.js";
import type {
  EventCursor,
  GuardedDuplexRelay,
  RelayCommand,
  SessionEvent,
  SessionSnapshot,
  SessionSpec,
} from "../src/core/types.js";
import { operatorStartupUrl } from "../src/server/main.js";

function temporaryDirectory(name: string): string {
  return resolve(
    process.cwd(),
    "work",
    "tmp",
    "composition-tests",
    name + "-" + randomUUID(),
  );
}

function operatorHeaders(token: string): Readonly<{ authorization: string }> {
  return { authorization: "Bearer " + token };
}

class IdleSubscriberRelay implements GuardedDuplexRelay {
  readonly #subscribers = new Set<() => void>();
  #markSubscriptionStarted!: () => void;
  readonly subscriptionStarted = new Promise<void>((resolve) => {
    this.#markSubscriptionStarted = resolve;
  });
  receivedSignal: AbortSignal | undefined;

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  async open(_spec: SessionSpec): Promise<SessionSnapshot> {
    throw new Error("IdleSubscriberRelay does not open sessions");
  }

  snapshot(_sessionId: string): SessionSnapshot {
    throw new Error("IdleSubscriberRelay does not expose snapshots");
  }

  async command(_sessionId: string, _command: RelayCommand): Promise<void> {
    throw new Error("IdleSubscriberRelay does not accept commands");
  }

  events(
    _sessionId: string,
    _after: EventCursor = 0,
    signal?: AbortSignal,
  ): AsyncIterable<SessionEvent> {
    this.receivedSignal = signal;
    return this.#idleEvents(signal);
  }

  releaseIdleSubscribers(): void {
    for (const subscriber of this.#subscribers) subscriber();
  }

  async *#idleEvents(signal?: AbortSignal): AsyncIterable<SessionEvent> {
    let wake!: () => void;
    const idle = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const onAbort = (): void => wake();
    this.#subscribers.add(onAbort);
    this.#markSubscriptionStarted();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    try {
      await idle;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.#subscribers.delete(onAbort);
    }
  }
}

async function resolvesPromptly<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Idle event iterator did not resolve after abort")),
          250,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe("production composition", () => {
  it("cancels idle managed event subscriptions without a later session event", async () => {
    const delegate = new IdleSubscriberRelay();
    const relay = new ManagedRelay(delegate);
    const controller = new AbortController();
    const iterator = relay
      .events("idle-session", 0, controller.signal)
      [Symbol.asyncIterator]();
    const next = iterator.next();

    try {
      await delegate.subscriptionStarted;
      assert.equal(delegate.receivedSignal, controller.signal);
      assert.equal(delegate.subscriberCount, 1);

      controller.abort();

      assert.equal((await resolvesPromptly(next)).done, true);
      assert.equal(delegate.subscriberCount, 0);
    } finally {
      delegate.releaseIdleSubscribers();
      await next.catch(() => undefined);
      await iterator.return?.();
    }
  });

  it("removes the operator bearer token from the startup log URL", () => {
    const token = "operator-test-token-0123456789abcdef";
    const publicUrl = operatorStartupUrl(
      "https://relay.example.test/#access=" + token,
    );

    assert.equal(publicUrl, "https://relay.example.test/");
    assert.equal(publicUrl.includes(token), false);
  });

  it("selects one server-side provider and advertises its session-pinned modes", async () => {
    const glossaryDirectory = temporaryDirectory("controlled");
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://relay.example.test",
      TRANSLATION_PROVIDER: "openai_controlled",
      TRANSLATION_MODE: "balanced",
      OPENAI_API_KEY: "openai-test-key",
      EVIDENCE_PROFILE: "in_memory",
      GLOSSARY_DIRECTORY: glossaryDirectory,
      LOG_LEVEL: "silent",
    });
    const composition = await composeApplication(config);
    await composition.app.ready();

    try {
      const operatorUrl = new URL(composition.operatorUrl);
      assert.equal(operatorUrl.origin, "https://relay.example.test");
      assert.equal(operatorUrl.search, "");
      assert.equal(
        new URLSearchParams(operatorUrl.hash.slice(1)).get("access"),
        config.operatorToken,
      );

      const capabilities = await composition.app.inject({
        method: "GET",
        url: "/api/capabilities",
        headers: operatorHeaders(config.operatorToken),
      });
      assert.equal(capabilities.statusCode, 200);
      const translation = capabilities.json().translation;
      assert.equal(translation.provider, "openai_controlled");
      assert.equal(translation.defaultMode, "balanced");
      assert.deepEqual(
        translation.supportedModes.map((mode: { mode: string }) => mode.mode),
        ["fast", "balanced", "accurate"],
      );
      assert.ok(
        translation.supportedModes.every(
          (mode: { behavior: { version: number }; degradation: { state: string } }) =>
            mode.behavior.version === 1 && mode.degradation.state === "full",
        ),
      );
      assert.equal(JSON.stringify(capabilities.json()).includes("openai-test-key"), false);
      assert.equal(JSON.stringify(capabilities.json()).includes(config.operatorToken), false);
      assert.equal(
        JSON.stringify(composition.translation).includes("openai-test-key"),
        false,
      );

      const created = await composition.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: operatorHeaders(config.operatorToken),
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "accurate",
          recordingConsent: true,
        },
      });
      assert.equal(created.statusCode, 201);
      assert.equal(created.json().provider, "openai_controlled");
      assert.equal(created.json().translationMode, "accurate");
      assert.equal(created.json().behaviorVersion, 1);
      assert.deepEqual(created.json().degradation, { state: "full" });
    } finally {
      await composition.app.close();
      await rm(glossaryDirectory, { recursive: true, force: true });
    }
  });

  it("preflights unsupported configured provider and mode combinations before live use", async () => {
    const config = loadConfig({
      TRANSLATION_PROVIDER: "openai_native",
      TRANSLATION_MODE: "accurate",
      OPENAI_API_KEY: "openai-test-key",
      EVIDENCE_PROFILE: "in_memory",
      GLOSSARY_DIRECTORY: temporaryDirectory("native-accurate"),
      LOG_LEVEL: "silent",
    });

    await assert.rejects(
      () => composeApplication(config),
      /does not support TRANSLATION_MODE=accurate/u,
    );
  });

  it("composes Palabra as a complete provider without exposing its server key", async () => {
    const glossaryDirectory = temporaryDirectory("palabra");
    const config = loadConfig({
      TRANSLATION_PROVIDER: "palabra",
      TRANSLATION_MODE: "accurate",
      PALABRA_API_KEY: "palabra-test-key",
      EVIDENCE_PROFILE: "in_memory",
      GLOSSARY_DIRECTORY: glossaryDirectory,
      LOG_LEVEL: "silent",
    });
    const composition = await composeApplication(config);
    await composition.app.ready();

    try {
      const capabilities = await composition.app.inject({
        method: "GET",
        url: "/api/capabilities",
        headers: operatorHeaders(config.operatorToken),
      });
      const translation = capabilities.json().translation;
      assert.equal(translation.provider, "palabra");
      assert.equal(translation.defaultMode, "accurate");
      assert.deepEqual(
        translation.supportedModes.map((mode: { mode: string }) => mode.mode),
        ["fast", "balanced", "accurate"],
      );
      const accurate = translation.supportedModes.find(
        (mode: { mode: string }) => mode.mode === "accurate",
      );
      assert.equal(accurate.deterministicGlossary, false);
      assert.equal(accurate.degradation.state, "degraded");
      assert.equal(JSON.stringify(capabilities.json()).includes("palabra-test-key"), false);
    } finally {
      await composition.app.close();
      await rm(glossaryDirectory, { recursive: true, force: true });
    }
  });

  it("keeps the media adapter independently switchable", async () => {
    const glossaryDirectory = temporaryDirectory("fake-telephony");
    const config = loadConfig({
      PUBLIC_BASE_URL: "http://localhost:4207",
      MEDIA_PROFILE: "fake_telephony",
      TRANSLATION_PROVIDER: "openai_native",
      TRANSLATION_MODE: "fast",
      OPENAI_API_KEY: "openai-test-key",
      EVIDENCE_PROFILE: "in_memory",
      GLOSSARY_DIRECTORY: glossaryDirectory,
      LOG_LEVEL: "silent",
    });
    const composition = await composeApplication(config);
    await composition.app.ready();

    try {
      const capabilities = await composition.app.inject({
        method: "GET",
        url: "/api/capabilities",
        headers: operatorHeaders(config.operatorToken),
      });
      assert.deepEqual(capabilities.json().mediaProfiles, ["fake_telephony"]);
      assert.equal(capabilities.json().translation.provider, "openai_native");
      assert.equal(
        composition.app.hasRoute({
          method: "GET",
          url: "/ws/media/:sessionId/:side",
        }),
        false,
      );

      const created = await composition.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: operatorHeaders(config.operatorToken),
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "fast",
          recordingConsent: true,
        },
      });
      assert.equal(created.statusCode, 201);
      assert.deepEqual(
        created.json().endpointGrants.map(
          (grant: { kind: string; side: string; address: string }) => grant,
        ),
        [
          {
            kind: "telephony_test",
            side: "A",
            address: "fake-telephony://" + created.json().sessionId + "/A",
          },
          {
            kind: "telephony_test",
            side: "B",
            address: "fake-telephony://" + created.json().sessionId + "/B",
          },
        ],
      );
      assert.ok(composition.telephonyTestDriver);
    } finally {
      await composition.app.close();
      await rm(glossaryDirectory, { recursive: true, force: true });
    }
  });
});
