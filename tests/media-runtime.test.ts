import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BrowserWebSocketMediaPort } from "../src/adapters/media/browser-websocket.js";
import { FakeTelephonyMediaPort } from "../src/adapters/media/fake-telephony.js";
import { createMediaRuntime } from "../src/media-runtime.js";
import { createServerAccessControl } from "../src/server/access.js";

const access = createServerAccessControl({ operatorToken: "o".repeat(32) });

describe("media runtime composition", () => {
  it("builds browser pairing with side-bound HTTPS participant grants", async () => {
    const runtime = createMediaRuntime({
      profile: "browser_pair",
      publicBaseUrl: new URL("https://relay.example.test"),
      access,
    });

    assert.ok(runtime.port instanceof BrowserWebSocketMediaPort);
    assert.equal(runtime.browserGateway, runtime.port);
    const grant = await runtime.endpointGrant("session with spaces", "A");
    assert.equal(grant.kind, "browser_link");
    if (grant.kind === "browser_link") {
      const url = new URL(grant.url);
      assert.equal(url.origin, "https://relay.example.test");
      assert.equal(url.searchParams.get("sessionId"), "session with spaces");
      assert.equal(url.searchParams.get("side"), "A");
      assert.ok(new URLSearchParams(url.hash.slice(1)).has("access"));
      assert.match(grant.qrDataUrl, /^data:image\/png;base64,/u);
    }
  });

  it("switches to the telephony contract with one profile value", async () => {
    const runtime = createMediaRuntime({
      profile: "fake_telephony",
      publicBaseUrl: new URL("https://relay.example.test"),
      access,
    });

    assert.ok(runtime.port instanceof FakeTelephonyMediaPort);
    assert.equal(runtime.browserGateway, undefined);
    assert.equal(runtime.telephonyTestDriver, runtime.port);
    assert.deepEqual(await runtime.endpointGrant("session/1", "B"), {
      kind: "telephony_test",
      side: "B",
      address: "fake-telephony://session%2F1/B",
    });
  });

  it("rejects a non-origin public browser URL before issuing grants", () => {
    assert.throws(
      () => createMediaRuntime({
        profile: "browser_pair",
        publicBaseUrl: new URL("https://relay.example.test/path"),
        access,
      }),
      /HTTP\(S\) origin/u,
    );
  });
});
