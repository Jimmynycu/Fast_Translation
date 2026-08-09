import QRCode from "qrcode";
import { BrowserWebSocketMediaPort } from "./adapters/media/browser-websocket.js";
import {
  FakeTelephonyMediaPort,
  type FakeTelephonyOutbound,
  type TelephonyDtmfDigit,
} from "./adapters/media/fake-telephony.js";
import type { EndpointGrantFactory } from "./core/relay.js";
import type { MediaPort, MediaProfile, Side } from "./core/types.js";
import {
  withAccessFragment,
  type ServerAccessControl,
} from "./server/access.js";

export interface TelephonyTestDriver {
  connect(sessionId: string, side: Side): void;
  hangup(sessionId: string, side: Side): void;
  reconnect(sessionId: string, side: Side): void;
  speechStarted(sessionId: string, side: Side): void;
  speechEnded(sessionId: string, side: Side): void;
  ingestMulaw(
    sessionId: string,
    side: Side,
    sequence: number,
    mulaw8k: Uint8Array,
    capturedAtMs?: number,
  ): void;
  ingestDtmf(
    sessionId: string,
    side: Side,
    digit: TelephonyDtmfDigit,
    capturedAtMs?: number,
  ): void;
  emitAlert(
    sessionId: string,
    side: Side,
    code: string,
    message: string,
    retryable: boolean,
    capturedAtMs?: number,
  ): void;
  outbound(sessionId: string, side: Side): readonly FakeTelephonyOutbound[];
}

export interface MediaRuntime {
  readonly profile: MediaProfile;
  readonly port: MediaPort;
  readonly endpointGrant: EndpointGrantFactory;
  readonly browserGateway?: BrowserWebSocketMediaPort;
  readonly telephonyTestDriver?: TelephonyTestDriver;
}

export interface CreateMediaRuntimeOptions {
  readonly profile: MediaProfile;
  readonly publicBaseUrl: URL;
  readonly access: ServerAccessControl;
}

function assertPublicOrigin(publicBaseUrl: URL): void {
  if (
    (publicBaseUrl.protocol !== "http:" && publicBaseUrl.protocol !== "https:") ||
    publicBaseUrl.pathname !== "/" ||
    publicBaseUrl.search !== "" ||
    publicBaseUrl.hash !== "" ||
    publicBaseUrl.username !== "" ||
    publicBaseUrl.password !== ""
  ) {
    throw new TypeError(
      "PUBLIC_BASE_URL must be an HTTP(S) origin without a path, query, credentials, or fragment",
    );
  }
}

function browserEndpointGrant(
  publicBaseUrl: URL,
  access: ServerAccessControl,
): EndpointGrantFactory {
  assertPublicOrigin(publicBaseUrl);
  return async (sessionId, side) => {
    const participantUrl = new URL(publicBaseUrl);
    participantUrl.searchParams.set("role", "participant");
    participantUrl.searchParams.set("sessionId", sessionId);
    participantUrl.searchParams.set("side", side);
    const url = withAccessFragment(
      participantUrl,
      access.issueParticipantAccess(sessionId, side),
    ).toString();
    const qrDataUrl = await QRCode.toDataURL(url, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 256,
    });
    return { kind: "browser_link", side, url, qrDataUrl };
  };
}

function fakeTelephonyEndpointGrant(): EndpointGrantFactory {
  return (sessionId, side) => ({
    kind: "telephony_test",
    side,
    address: "fake-telephony://" + encodeURIComponent(sessionId) + "/" + side,
  });
}

export function createMediaRuntime(options: CreateMediaRuntimeOptions): MediaRuntime {
  if (options.profile === "browser_pair") {
    const browser = new BrowserWebSocketMediaPort();
    return Object.freeze({
      profile: options.profile,
      port: browser,
      endpointGrant: browserEndpointGrant(options.publicBaseUrl, options.access),
      browserGateway: browser,
    });
  }

  const telephony = new FakeTelephonyMediaPort();
  return Object.freeze({
    profile: options.profile,
    port: telephony,
    endpointGrant: fakeTelephonyEndpointGrant(),
    telephonyTestDriver: telephony,
  });
}
