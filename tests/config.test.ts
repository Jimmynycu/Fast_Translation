import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { loadConfig } from "../src/config.js";

const rootKey = Buffer.alloc(32, 7).toString("base64");

function deploymentEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    HOST: "127.0.0.1",
    PROCESSING_PROFILE_PATH: "profiles/poc.json",
    PROCESSING_PROFILE_SHA256: "a".repeat(64),
    DEPLOYMENT_BUILD_SHA256: "b".repeat(64),
    OPERATOR_TOKEN: "operator-" + "o".repeat(32),
    RETENTION_OWNER_ID: "retention-owner",
    RETENTION_OWNER_TOKEN: "owner-" + "a".repeat(32),
    EVIDENCE_REVIEWER_ID: "evidence-reviewer",
    EVIDENCE_REVIEWER_TOKEN: "reviewer-" + "b".repeat(32),
    EVIDENCE_ARCHIVE_DIRECTORY: "data/evidence/archive",
    EVIDENCE_KEY_DIRECTORY: "data/evidence/keys",
    EVIDENCE_EXPORT_DIRECTORY: "data/evidence/exports",
    EVIDENCE_RECEIPT_DIRECTORY: "data/evidence/receipts",
    EVIDENCE_ROOT_KEY_BASE64: rootKey,
    ...overrides,
  };
}

const glossaryEvidenceDirectoryOverlapCases = [
  ["archive", "EVIDENCE_ARCHIVE_DIRECTORY"],
  ["key", "EVIDENCE_KEY_DIRECTORY"],
  ["export", "EVIDENCE_EXPORT_DIRECTORY"],
  ["receipt", "EVIDENCE_RECEIPT_DIRECTORY"],
] as const;

describe("loadConfig", () => {
  it("loads the pinned processing-profile reference and separately scoped deployment controls", () => {
    const config = loadConfig(
      deploymentEnvironment({
        MEDIA_PROFILE: "fake_telephony",
        OPENAI_API_KEY: "openai-test-key",
        PALABRA_API_KEY: "palabra-test-key",
      }),
      "C:/workspace",
    );

    assert.equal(config.port, 4207);
    assert.equal(config.mediaProfile, "fake_telephony");
    assert.match(config.processingProfile.path, /workspace[\\/]profiles[\\/]poc\.json$/u);
    assert.equal(config.processingProfile.expectedSha256, "a".repeat(64));
    assert.equal(config.deploymentBuildSha256, "b".repeat(64));
    assert.equal(config.openaiApiKey, "openai-test-key");
    assert.equal(config.palabraApiKey, "palabra-test-key");
    assert.equal(config.retentionOwner.id, "retention-owner");
    assert.equal(config.evidenceReviewer.id, "evidence-reviewer");
    assert.equal(config.evidence.rootKey.equals(Buffer.alloc(32, 7)), true);
    assert.equal(config.strictSecurityAncestors, true);
    assert.match(config.evidence.archiveDirectory, /workspace[\\/]data[\\/]evidence[\\/]archive$/u);
    assert.match(config.evidence.keyDirectory, /workspace[\\/]data[\\/]evidence[\\/]keys$/u);
    assert.match(config.evidence.exportDirectory, /workspace[\\/]data[\\/]evidence[\\/]exports$/u);
    assert.match(config.evidence.receiptDirectory, /workspace[\\/]data[\\/]evidence[\\/]receipts$/u);
    assert.equal("translationProvider" in config, false);
    assert.equal("translationMode" in config, false);
    assert.equal("openaiRealtimeModel" in config, false);
    assert.equal("evidenceKey" in config, false);
  });

  it("allows plaintext public URLs only for exact local loopback hosts", () => {
    for (const publicBaseUrl of [
      "http://localhost:4207",
      "http://127.0.0.1:4207",
      "http://[::1]:4207",
    ]) {
      const config = loadConfig(deploymentEnvironment({ PUBLIC_BASE_URL: publicBaseUrl }));
      assert.equal(config.publicBaseUrl.protocol, "http:");
      assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(config.publicBaseUrl.hostname));
    }

    const remoteConfig = loadConfig(
      deploymentEnvironment({
        PUBLIC_BASE_URL: "https://relay.example.test:4207",
        HOST: "0.0.0.0",
        SECURITY_DATA_DIRECTORY: "C:/fast-translation-security",
        EVIDENCE_ARCHIVE_DIRECTORY: "C:/fast-translation-security/evidence/archive",
        EVIDENCE_KEY_DIRECTORY: "C:/fast-translation-security/evidence/keys",
        EVIDENCE_EXPORT_DIRECTORY: "C:/fast-translation-security/evidence/exports",
        EVIDENCE_RECEIPT_DIRECTORY: "C:/fast-translation-security/evidence/receipts",
        GLOSSARY_DIRECTORY: "C:/fast-translation-security/glossaries",
        TLS_CERT_PATH: "certs/lan.pem",
        TLS_KEY_PATH: "certs/lan-key.pem",
      }),
      "C:/workspace",
    );
    assert.equal(remoteConfig.publicBaseUrl.protocol, "https:");
    assert.equal(remoteConfig.strictSecurityAncestors, true);
  });

  it("allows an explicit insecure data-boundary opt-out only for loopback HTTP", () => {
    const config = loadConfig(
      deploymentEnvironment({ ALLOW_INSECURE_LOOPBACK_DATA_BOUNDARY: "true" }),
      "C:/workspace",
    );
    assert.equal(config.strictSecurityAncestors, false);

    assert.throws(
      () => loadConfig({
        ...deploymentEnvironment({
          PUBLIC_BASE_URL: "https://relay.example.test:4207",
          ALLOW_INSECURE_LOOPBACK_DATA_BOUNDARY: "true",
          SECURITY_DATA_DIRECTORY: "C:/fast-translation-security",
          EVIDENCE_ARCHIVE_DIRECTORY: "C:/fast-translation-security/evidence/archive",
          EVIDENCE_KEY_DIRECTORY: "C:/fast-translation-security/evidence/keys",
          EVIDENCE_EXPORT_DIRECTORY: "C:/fast-translation-security/evidence/exports",
          EVIDENCE_RECEIPT_DIRECTORY: "C:/fast-translation-security/evidence/receipts",
          GLOSSARY_DIRECTORY: "C:/fast-translation-security/glossaries",
          TLS_CERT_PATH: "certs/lan.pem",
          TLS_KEY_PATH: "certs/lan-key.pem",
        }),
      }, "C:/workspace"),
      /ALLOW_INSECURE_LOOPBACK_DATA_BOUNDARY.*loopback HTTP/u,
    );
  });

  it("requires plaintext HTTP to bind only to an exact numeric loopback address", () => {
    assert.throws(
      () => loadConfig(deploymentEnvironment({ HOST: undefined })),
      /HOST.*exact numeric loopback/u,
    );
    for (const host of ["0.0.0.0", "::", "192.0.2.10", "localhost"]) {
      assert.throws(
        () => loadConfig(deploymentEnvironment({ HOST: host })),
        /HOST.*exact numeric loopback/u,
      );
    }
    for (const host of ["127.0.0.1", "::1", "[::1]"]) {
      const config = loadConfig(deploymentEnvironment({ HOST: host }));
      assert.equal(config.host, host);
    }
    assert.throws(
      () => loadConfig(deploymentEnvironment({
        HOST: "0.0.0.0",
        ALLOW_INSECURE_LOOPBACK_DATA_BOUNDARY: "true",
      })),
      /HOST.*exact numeric loopback/u,
    );
  });

  it("rejects public URLs that could send participant grants over an unsafe transport", () => {
    for (const publicBaseUrl of [
      "http://relay.example.test:4207",
      "http://192.0.2.10:4207",
      "http://127.1:4207",
      "ftp://relay.example.test:4207",
      "https://participant:grant@relay.example.test:4207",
      "https://relay.example.test:4207/#access=participant-grant",
      "https://relay.example.test:4207/#",
    ]) {
      assert.throws(
        () => loadConfig(deploymentEnvironment({ PUBLIC_BASE_URL: publicBaseUrl })),
        /PUBLIC_BASE_URL/u,
      );
    }
  });

  it("requires the deployment-pinned profile, role credentials, and encrypted evidence controls", () => {
    assert.throws(
      () => loadConfig(deploymentEnvironment({ PROCESSING_PROFILE_PATH: undefined })),
      /PROCESSING_PROFILE_PATH/u,
    );
    assert.throws(
      () => loadConfig(deploymentEnvironment({ PROCESSING_PROFILE_SHA256: undefined })),
      /PROCESSING_PROFILE_SHA256/u,
    );
    assert.throws(
      () => loadConfig(deploymentEnvironment({ DEPLOYMENT_BUILD_SHA256: undefined })),
      /DEPLOYMENT_BUILD_SHA256/u,
    );
    assert.throws(
      () => loadConfig(deploymentEnvironment({ RETENTION_OWNER_TOKEN: undefined })),
      /RETENTION_OWNER_TOKEN/u,
    );
    assert.throws(
      () => loadConfig(deploymentEnvironment({ EVIDENCE_ARCHIVE_DIRECTORY: undefined })),
      /EVIDENCE_ARCHIVE_DIRECTORY/u,
    );
    assert.throws(
      () => loadConfig(deploymentEnvironment({ EVIDENCE_ROOT_KEY_BASE64: undefined })),
      /EVIDENCE_ROOT_KEY_BASE64/u,
    );
  });

  it("rejects a non-canonical profile hash and root key", () => {
    assert.throws(
      () => loadConfig(deploymentEnvironment({ PROCESSING_PROFILE_SHA256: "A".repeat(64) })),
      /PROCESSING_PROFILE_SHA256/u,
    );
    assert.throws(
      () => loadConfig(deploymentEnvironment({ DEPLOYMENT_BUILD_SHA256: "B".repeat(64) })),
      /DEPLOYMENT_BUILD_SHA256/u,
    );
    assert.throws(
      () => loadConfig(deploymentEnvironment({ EVIDENCE_ROOT_KEY_BASE64: rootKey.slice(0, -1) + "!" })),
      /EVIDENCE_ROOT_KEY_BASE64/u,
    );
  });

  it("keeps owner, reviewer, and operator secrets distinct and evidence directories disjoint", () => {
    assert.throws(
      () => loadConfig(deploymentEnvironment({ EVIDENCE_REVIEWER_TOKEN: "owner-" + "a".repeat(32) })),
      /must be distinct/u,
    );
    assert.throws(
      () => loadConfig(deploymentEnvironment({ RETENTION_OWNER_TOKEN: "operator-" + "o".repeat(32) })),
      /must be distinct/u,
    );
    assert.throws(
      () => loadConfig(deploymentEnvironment({ EVIDENCE_REVIEWER_ID: "retention-owner" })),
      /must be distinct/u,
    );
    assert.throws(
      () => loadConfig(deploymentEnvironment({ EVIDENCE_KEY_DIRECTORY: "data/evidence/archive/keys" })),
      /must be distinct and non-nested/u,
    );
  });

  it("accepts five distinct roots beneath the dedicated data parent, including absolute deployment paths", () => {
    const cwd = "C:/workspace";
    const dataParent = resolve(cwd, "data");
    const config = loadConfig(
      deploymentEnvironment({
        EVIDENCE_ARCHIVE_DIRECTORY: join(dataParent, "managed", "archive"),
        EVIDENCE_KEY_DIRECTORY: join(dataParent, "managed", "keys"),
        EVIDENCE_EXPORT_DIRECTORY: join(dataParent, "managed", "exports"),
        EVIDENCE_RECEIPT_DIRECTORY: join(dataParent, "managed", "receipts"),
        GLOSSARY_DIRECTORY: join(dataParent, "managed", "glossaries"),
      }),
      cwd,
    );

    assert.match(config.evidence.archiveDirectory, /workspace[\\/]data[\\/]managed[\\/]archive$/u);
    assert.match(config.glossaryDirectory, /workspace[\\/]data[\\/]managed[\\/]glossaries$/u);
  });

  it("rejects a security root that overlaps the resolved web static root", () => {
    assert.throws(
      () => loadConfig(
        deploymentEnvironment({
          SECURITY_DATA_DIRECTORY: "C:/workspace",
          EVIDENCE_ARCHIVE_DIRECTORY: "C:/workspace/web/evidence",
        }),
        "C:/workspace",
      ),
      /web static root/u,
    );
  });

  for (const [name, directory] of [
    ["C filesystem root", parse("C:/workspace").root],
    ["D filesystem root", parse("D:/workspace").root],
    ["deployment cwd", "C:/workspace"],
    ["cwd ancestor", dirname("C:/workspace")],
    ["user home", homedir()],
    ["dedicated data parent", resolve("C:/workspace", "data")],
  ] as const) {
    it(`rejects a ${name} as a recursive security root`, () => {
      assert.throws(
        () => loadConfig(
          deploymentEnvironment({ EVIDENCE_ARCHIVE_DIRECTORY: directory }),
          "C:/workspace",
        ),
        /security (?:data|root)|filesystem root|strict descendant|deployment cwd/u,
      );
    });
  }

  for (const [evidenceRootName, evidenceDirectoryVariable] of glossaryEvidenceDirectoryOverlapCases) {
    const evidenceRoot = `data/security-roots/${evidenceRootName}`;
    const overlapCases = [
      {
        name: "equals",
        evidenceDirectory: evidenceRoot,
        glossaryDirectory: evidenceRoot,
      },
      {
        name: "contains",
        evidenceDirectory: `${evidenceRoot}/evidence`,
        glossaryDirectory: evidenceRoot,
      },
      {
        name: "is contained by",
        evidenceDirectory: evidenceRoot,
        glossaryDirectory: `${evidenceRoot}/glossary`,
      },
    ] as const;

    for (const overlapCase of overlapCases) {
      it(`rejects a glossary directory that ${overlapCase.name} the ${evidenceRootName} evidence root`, () => {
        assert.throws(
          () => loadConfig(
            deploymentEnvironment({
              [evidenceDirectoryVariable]: overlapCase.evidenceDirectory,
              GLOSSARY_DIRECTORY: overlapCase.glossaryDirectory,
            }),
            "C:/workspace",
          ),
          /Glossary directory must be a distinct and non-nested security root/u,
        );
      });
    }
  }

  it("rejects obsolete environment routes rather than silently retaining compatibility", () => {
    assert.throws(
      () => loadConfig(deploymentEnvironment({ TRANSLATION_PROFILE: "controlled_poc" })),
      /TRANSLATION_PROFILE/u,
    );
    assert.throws(
      () => loadConfig(deploymentEnvironment({ TRANSLATION_PROVIDER: "palabra" })),
      /TRANSLATION_PROVIDER/u,
    );
    assert.throws(
      () => loadConfig(deploymentEnvironment({ OPENAI_TTS_VOICE: "marin" })),
      /OPENAI_TTS_VOICE/u,
    );
    assert.throws(
      () => loadConfig(deploymentEnvironment({ EVIDENCE_DIRECTORY: "data/evidence" })),
      /EVIDENCE_DIRECTORY/u,
    );
    assert.throws(
      () => loadConfig(deploymentEnvironment({ EVIDENCE_KEY_BASE64: rootKey })),
      /EVIDENCE_KEY_BASE64/u,
    );
    assert.throws(
      () => loadConfig(deploymentEnvironment({ EVIDENCE_MIN_FREE_BYTES: "1073741824" })),
      /EVIDENCE_MIN_FREE_BYTES/u,
    );
  });

  it("requires the TLS certificate and key together and resolves both from the deployment cwd", () => {
    assert.throws(
      () => loadConfig(deploymentEnvironment({ TLS_CERT_PATH: "certs/lan.pem" })),
      /TLS_CERT_PATH and TLS_KEY_PATH/u,
    );

    const config = loadConfig(
      deploymentEnvironment({
        TLS_CERT_PATH: "certs/lan.pem",
        TLS_KEY_PATH: "certs/lan-key.pem",
      }),
      "C:/workspace",
    );
    assert.match(config.tlsCertPath ?? "", /workspace[\\/]certs[\\/]lan\.pem$/u);
    assert.match(config.tlsKeyPath ?? "", /workspace[\\/]certs[\\/]lan-key\.pem$/u);
  });

  it("requires TLS files for remote HTTPS and keeps them outside the web static root", () => {
    assert.throws(
      () => loadConfig(
        deploymentEnvironment({ PUBLIC_BASE_URL: "https://relay.example.test:4207" }),
        "C:/workspace",
      ),
      /TLS_CERT_PATH and TLS_KEY_PATH.*required.*HTTPS/u,
    );
    assert.throws(
      () => loadConfig(
        deploymentEnvironment({
          PUBLIC_BASE_URL: "https://relay.example.test:4207",
          TLS_CERT_PATH: "certs/server-cert.pem",
          TLS_KEY_PATH: "certs/server-key.pem",
        }),
        "C:/workspace",
      ),
      /SECURITY_DATA_DIRECTORY.*absolute.*outside.*cwd/u,
    );
    assert.throws(
      () => loadConfig(
        deploymentEnvironment({
          PUBLIC_BASE_URL: "https://relay.example.test:4207",
          SECURITY_DATA_DIRECTORY: "C:/fast-translation-security",
          EVIDENCE_ARCHIVE_DIRECTORY: "C:/fast-translation-security/evidence/archive",
          EVIDENCE_KEY_DIRECTORY: "C:/fast-translation-security/evidence/keys",
          EVIDENCE_EXPORT_DIRECTORY: "C:/fast-translation-security/evidence/exports",
          EVIDENCE_RECEIPT_DIRECTORY: "C:/fast-translation-security/evidence/receipts",
          GLOSSARY_DIRECTORY: "C:/fast-translation-security/glossaries",
          TLS_CERT_PATH: "web/server-cert.pem",
          TLS_KEY_PATH: "certs/server-key.pem",
        }),
        "C:/workspace",
      ),
      /web static root/u,
    );
  });
});
