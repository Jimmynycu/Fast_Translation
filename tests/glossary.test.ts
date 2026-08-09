import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GlossaryConflictError,
  MAX_GLOSSARY_ALIASES_PER_ENTRY,
  MAX_GLOSSARY_OVERLAP_WORK,
  MAX_GLOSSARY_TERM_CHARACTERS,
  MAX_GLOSSARY_TERM_UTF8_BYTES,
  compileGlossary,
  compileGlossaryPair,
  deriveOpaqueTermId,
  reverseGlossarySpec,
  type GlossaryAlert,
} from "../src/core/glossary.js";

const torqueTarget = "\u626d\u529b\u63a7\u5236\u5668";
const spindleTarget = "\u4e3b\u8ef8";
const placeholder1 = "\u27e6GLOSSARY_0001\u27e7";
const placeholder2 = "\u27e6GLOSSARY_0002\u27e7";
const placeholder3 = "\u27e6GLOSSARY_0003\u27e7";

const entries = [
  {
    id: "torque-controller",
    source: "torque controller",
    aliases: ["torque control unit", "TCU"],
    targetExact: torqueTarget,
  },
  { id: "spindle", source: "spindle", aliases: [], targetExact: spindleTarget },
] as const;

const torqueControllerOpaqueId = deriveOpaqueTermId(entries[0]!);

test("compile creates an immutable, content-addressed glossary", () => {
  const glossary = compileGlossary({
    id: "factory-terms",
    version: "2026-08-06",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries,
  });
  assert.match(glossary.hash, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(glossary), true);
  assert.equal(Object.isFrozen(glossary.entries), true);
  assert.equal(Object.isFrozen(glossary.entries[0]?.aliases), true);
  assert.match(glossary.entries[0]?.id ?? "", /^term_[a-f0-9]{32}$/u);
  assert.notEqual(glossary.entries[0]?.id, entries[0]?.id);
  assert.throws(() => {
    (glossary.entries as unknown as { id: string }[])[0]!.id = "changed";
  }, TypeError);
  const equivalent = compileGlossary({
    id: "factory-terms",
    version: "2026-08-06",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [...entries].reverse(),
  });
  assert.equal(equivalent.hash, glossary.hash);
  const renamed = compileGlossary({
    id: "factory-terms",
    version: "2026-08-06",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [
      { ...entries[0], id: "opaque-master-a" },
      { ...entries[1], id: "opaque-master-b" },
    ],
  });
  assert.equal(renamed.hash, glossary.hash);
});

test("reverse glossary compiles the approved pair for the opposite lane", () => {
  const forward = {
    id: "factory-terms",
    version: "1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries,
  } as const;
  const reverse = reverseGlossarySpec(forward);
  assert.equal(reverse.sourceLanguage, "zh-TW");
  assert.equal(reverse.targetLanguage, "en");
  assert.deepEqual(reverse.entries[0], {
    id: "torque-controller",
    source: torqueTarget,
    aliases: [],
    targetExact: "torque controller",
  });

  const compiled = compileGlossary(reverse);
  const bound = compiled.bind(torqueTarget);
  const authorized = compiled.authorize(placeholder1, bound);
  assert.equal(authorized.status, "authorized");
  assert.equal(authorized.text, "torque controller");
});

test("the compiled pair reuses one master hash and opaque identity across directions", () => {
  const pair = compileGlossaryPair({
    id: "factory-terms",
    version: "1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries,
  });
  assert.equal(pair.forward.hash, pair.reverse.hash);
  assert.deepEqual(
    pair.forward.entries.map((entry) => entry.id),
    pair.reverse.entries.map((entry) => entry.id),
  );
  const forwardBound = pair.forward.bind("spindle");
  assert.equal(Object.prototype.propertyIsEnumerable.call(forwardBound, "directionalHash"), false);
  assert.equal(pair.reverse.authorize(placeholder1, forwardBound).alerts[0]?.code, "glossary_mismatch");
});

test("master hash remains stable when the runtime spec carries opaque entry ids", () => {
  const master = {
    id: "factory-terms",
    version: "1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries,
  } as const;
  const compiled = compileGlossary(master);
  const runtime = compileGlossary({
    ...master,
    entries: compiled.entries,
  });
  assert.equal(runtime.hash, compiled.hash);
  assert.deepEqual(runtime.entries.map((entry) => entry.id), compiled.entries.map((entry) => entry.id));
});

test("compiles a frozen forward/reverse pair and rejects ambiguous alias ownership", () => {
  const spec = {
    id: "factory-terms",
    version: "1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries,
  } as const;
  const pair = compileGlossaryPair(spec);
  assert.equal(Object.isFrozen(pair), true);
  assert.equal(pair.forward.hash.length, 64);
  assert.equal(pair.reverse.sourceLanguage, "zh-TW");
  assert.throws(() => compileGlossary({
    ...spec,
    entries: [{
      id: "duplicate-alias",
      source: "Spindle",
      aliases: [" spindle "],
      targetExact: "主軸",
    }],
  }), /ambiguous normalized term/u);
});

test("compile rejects duplicate IDs, empty values, and normalized alias conflicts", () => {
  assert.throws(() => compileGlossary({
    id: "conflict",
    version: "1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [
      { id: "one", source: "Torque  Controller", aliases: [], targetExact: "one" },
      { id: "two", source: "other", aliases: [" torque controller "], targetExact: "two" },
    ],
  }), GlossaryConflictError);
  assert.throws(() => compileGlossary({
    id: "duplicate-id",
    version: "1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [
      { id: "same", source: "one", aliases: [], targetExact: "one" },
      { id: "same", source: "two", aliases: [], targetExact: "two" },
    ],
  }), GlossaryConflictError);
  assert.throws(() => compileGlossary({
    id: "empty",
    version: "1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [{ id: "one", source: " ", aliases: [], targetExact: "one" }],
  }), GlossaryConflictError);
});

test("compile accepts exact normalized term limits and rejects one character beyond", () => {
  const atLimit = "a".repeat(MAX_GLOSSARY_TERM_CHARACTERS);
  assert.doesNotThrow(() => compileGlossary({
    id: "term-limit",
    version: "1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [{ id: "bounded", source: atLimit, aliases: [], targetExact: "target" }],
  }));

  const overLimit = atLimit + "a";
  assert.throws(() => compileGlossary({
    id: "term-limit-over",
    version: "1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [{ id: "bounded", source: overLimit, aliases: [], targetExact: "target" }],
  }), (error: unknown) => {
    assert(error instanceof GlossaryConflictError);
    assert.equal(error.message, "glossary term exceeds the maximum normalized size");
    assert.equal(error.message.includes(overLimit), false);
    return true;
  });
});

test("compile enforces normalized UTF-8 term size and aliases-per-entry bounds", () => {
  const utf8AtLimit = "😀".repeat(MAX_GLOSSARY_TERM_UTF8_BYTES / 4);
  assert.equal(Buffer.byteLength(utf8AtLimit, "utf8"), MAX_GLOSSARY_TERM_UTF8_BYTES);
  assert.doesNotThrow(() => compileGlossary({
    id: "utf8-limit",
    version: "1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [{ id: "bounded", source: utf8AtLimit, aliases: [], targetExact: "target" }],
  }));
  assert.throws(() => compileGlossary({
    id: "utf8-limit-over",
    version: "1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [{ id: "bounded", source: utf8AtLimit + "😀", aliases: [], targetExact: "target" }],
  }), GlossaryConflictError);

  const aliases = Array.from({ length: MAX_GLOSSARY_ALIASES_PER_ENTRY }, (_, index) => `alias-${index}`);
  assert.doesNotThrow(() => compileGlossary({
    id: "alias-limit",
    version: "1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [{ id: "bounded", source: "source", aliases, targetExact: "target" }],
  }));
  assert.throws(() => compileGlossary({
    id: "alias-limit-over",
    version: "1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [{ id: "bounded", source: "source", aliases: [...aliases, "alias-over"], targetExact: "target" }],
  }), (error: unknown) => {
    assert(error instanceof GlossaryConflictError);
    assert.equal(error.message, "glossary entry exceeds the maximum alias count");
    return true;
  });
});

test("compile rejects a glossary whose quadratic overlap work exceeds the static budget", () => {
  assert.equal(MAX_GLOSSARY_OVERLAP_WORK, 2_000_000);
  const longTerm = "x".repeat(MAX_GLOSSARY_TERM_CHARACTERS);
  assert.throws(() => compileGlossary({
    id: "overlap-work-over",
    version: "1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [{ id: "bounded", source: longTerm, aliases: [], targetExact: longTerm }],
  }), (error: unknown) => {
    assert(error instanceof GlossaryConflictError);
    assert.equal(error.message, "glossary exceeds the maximum overlap work budget");
    return true;
  });
});

test("overlap work is bounded before scanning long common-prefix terms", () => {
  const commonPrefix = "c".repeat(899);
  const entries = ["a", "b", "d"].map((suffix, index) => ({
    id: `common-prefix-${index}`,
    source: commonPrefix + suffix,
    aliases: [],
    targetExact: `target-${index}`,
  }));
  assert.throws(() => compileGlossary({
    id: "common-prefix-overlap-work",
    version: "1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries,
  }), /maximum overlap work budget/u);
});

test("compile rejects cross-entry normalized phrase overlaps in both compiled directions", () => {
  const header = {
    id: "overlapping-terms",
    version: "1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
  } as const;
  const longTerm = {
    id: "torque-controller",
    source: "Torque Controller",
    aliases: ["TCU"],
    targetExact: "\u626d\u529b\u63a7\u5236\u5668",
  } as const;
  const subphrase = {
    id: "controller",
    source: "Controller",
    aliases: [],
    targetExact: "\u63a7\u5236\u5668",
  } as const;

  assert.throws(() => compileGlossary({ ...header, entries: [longTerm, subphrase] }), GlossaryConflictError);
  assert.throws(() => compileGlossary({ ...header, entries: [subphrase, longTerm] }), GlossaryConflictError);
  assert.throws(() => compileGlossary({
    ...header,
    entries: [
      { id: "alias-owner", source: "drive", aliases: ["Torque Control Unit"], targetExact: "\u9a45\u52d5\u5668" },
      { id: "alias-subphrase", source: "control unit", aliases: [], targetExact: "\u55ae\u5143" },
    ],
  }), GlossaryConflictError);
  assert.doesNotThrow(() => compileGlossary({
    ...header,
    entries: [
      { id: "microcontroller", source: "microcontroller", aliases: [], targetExact: "\u5fae\u63a7\u5236\u5668" },
      { id: "controller", source: "controller", aliases: [], targetExact: "\u63a7\u5236\u5668" },
    ],
  }));
  assert.throws(() => compileGlossaryPair({
    ...header,
    entries: [
      { id: "long-target", source: "spindle", aliases: [], targetExact: "\u626d\u529b\u63a7\u5236\u5668" },
      { id: "short-target", source: "valve", aliases: [], targetExact: "\u63a7\u5236\u5668" },
    ],
  }), GlossaryConflictError);
});

test("bind permits same-entry subphrases and preserves repeated occurrences", () => {
  const sameEntryOpaqueId = deriveOpaqueTermId({
    source: "torque controller",
    aliases: ["controller", "TCU"],
    targetExact: torqueTarget,
  });
  const glossary = compileGlossary({
    id: "factory-terms",
    version: "1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [{
      id: "torque-controller",
      source: "torque controller",
      aliases: ["controller", "TCU"],
      targetExact: torqueTarget,
    }],
  });
  const bound = glossary.bind("Inspect the TORQUE   controller, then the controller and TCU.");
  assert.equal(bound.text, `Inspect the ${placeholder1}, then the ${placeholder2} and ${placeholder3}.`);
  assert.deepEqual(bound.bindings.map(({ entryId, sourceText, placeholder }) => ({ entryId, sourceText, placeholder })), [
    { entryId: sameEntryOpaqueId, sourceText: "TORQUE   controller", placeholder: placeholder1 },
    { entryId: sameEntryOpaqueId, sourceText: "controller", placeholder: placeholder2 },
    { entryId: sameEntryOpaqueId, sourceText: "TCU", placeholder: placeholder3 },
  ]);
});

test("authorize deterministically reinserts exact approved targets", () => {
  const glossary = compileGlossary({
    id: "factory-terms", version: "1", sourceLanguage: "en", targetLanguage: "zh-TW", entries,
  });
  const bound = glossary.bind("Inspect the torque controller and spindle.");
  const authorized = glossary.authorize(`translated ${placeholder1} plus ${placeholder2}`, bound);
  assert.equal(authorized.status, "authorized");
  assert.equal(authorized.text, `translated ${torqueTarget} plus ${spindleTarget}`);
  assert.deepEqual(authorized.alerts, []);
  assert.deepEqual(authorized.guaranteedTargetExact, [torqueTarget, spindleTarget]);
});

test("authorize fails open with a structured alert when placeholders are missing", () => {
  const alerts: GlossaryAlert[] = [];
  const glossary = compileGlossary({
    id: "factory-terms", version: "1", sourceLanguage: "en", targetLanguage: "zh-TW", entries,
  }, { onAlert: (alert) => alerts.push(alert) });
  const bound = glossary.bind("Inspect the torque controller.");
  const result = glossary.authorize("uncontrolled translation", bound);
  assert.equal(result.status, "bypassed");
  assert.equal(result.text, "uncontrolled translation");
  assert.deepEqual(result.guaranteedTargetExact, []);
  assert.equal(result.alerts[0]?.code, "placeholder_missing");
  assert.equal(result.alerts[0]?.glossaryHash, glossary.hash);
  assert.deepEqual(alerts, result.alerts);
});

test("authorization alerts identify one affected term but omit ambiguous attribution", () => {
  const glossary = compileGlossary({
    id: "factory-terms", version: "1", sourceLanguage: "en", targetLanguage: "zh-TW", entries,
  });

  const attributable = glossary.authorize(
    "uncontrolled translation",
    glossary.bind("Inspect the torque controller."),
  );
  assert.equal(attributable.status, "bypassed");
  assert.equal(attributable.alerts[0]?.termId, torqueControllerOpaqueId);

  const multiTerm = glossary.authorize(
    "uncontrolled translation",
    glossary.bind("Inspect the torque controller and spindle."),
  );
  assert.equal(multiTerm.status, "bypassed");
  assert.equal("termId" in (multiTerm.alerts[0] ?? {}), false);

  const unknown = glossary.authorize(
    `\u27e6GLOSSARY_9999\u27e7 ${placeholder1} ${placeholder2}`,
    glossary.bind("torque controller then spindle"),
  );
  assert.equal(unknown.status, "bypassed");
  assert.equal("termId" in (unknown.alerts[0] ?? {}), false);
});

test("a duplicated known placeholder identifies its glossary entry", () => {
  const glossary = compileGlossary({
    id: "factory-terms", version: "1", sourceLanguage: "en", targetLanguage: "zh-TW", entries,
  });
  const result = glossary.authorize(
    `${placeholder1} ${placeholder1} ${placeholder2}`,
    glossary.bind("torque controller then spindle"),
  );

  assert.equal(result.status, "bypassed");
  assert.equal(result.alerts[0]?.code, "placeholder_duplicate");
  assert.equal(result.alerts[0]?.termId, torqueControllerOpaqueId);
});

test("authorize fails open on duplicate, unknown, or reordered placeholders", () => {
  const glossary = compileGlossary({
    id: "factory-terms", version: "1", sourceLanguage: "en", targetLanguage: "zh-TW", entries,
  });
  const bound = glossary.bind("torque controller then spindle");
  const cases = [
    [`${placeholder1} ${placeholder1} ${placeholder2}`, "placeholder_duplicate"],
    [`\u27e6GLOSSARY_9999\u27e7 ${placeholder1} ${placeholder2}`, "placeholder_unknown"],
    [`${placeholder2} ${placeholder1}`, "placeholder_reordered"],
  ] as const;
  for (const [translated, code] of cases) {
    const result = glossary.authorize(translated, bound);
    assert.equal(result.status, "bypassed");
    assert.equal(result.text, translated);
    assert.equal(result.alerts[0]?.code, code);
  }
});

test("authorization alerts redact an approved target that is absent after reinsertion", () => {
  const sentinelTarget = "TARGET_PLAINTEXT_SENTINEL_9d58c8a3";
  const glossary = compileGlossary({
    id: "private-terms",
    version: "1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [{
      id: "private-term",
      source: "private source",
      aliases: [],
      targetExact: sentinelTarget,
    }],
  });
  const bound = glossary.bind("private source");
  const originalBinding = bound.bindings[0];
  if (originalBinding === undefined) throw new Error("test setup must bind the private term");
  let targetReads = 0;
  const tamperedBound = { ...bound, bindings: [{
    ...originalBinding,
    get targetExact(): string {
      targetReads += 1;
      return targetReads === 1 ? "reinsertion-decoy" : sentinelTarget;
    },
  }] };
  const directionalHash = Object.getOwnPropertyDescriptor(bound, "directionalHash")?.value;
  Object.defineProperty(tamperedBound, "directionalHash", {
    value: directionalHash,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  const result = glossary.authorize(placeholder1, tamperedBound);

  assert.equal(result.status, "bypassed");
  assert.equal(result.alerts[0]?.code, "target_exact_missing");
  assert.equal(result.alerts[0]?.message, "target exact missing after reinsertion");
  assert.equal(JSON.stringify(result.alerts).includes(sentinelTarget), false);
});

test("authorize rejects bindings from a different immutable glossary", () => {
  const glossary = compileGlossary({
    id: "factory-terms", version: "1", sourceLanguage: "en", targetLanguage: "zh-TW", entries,
  });
  const bound = glossary.bind("torque controller");
  const differentGlossaryBound = { ...bound, glossaryHash: "0".repeat(64) };
  const directionalHash = Object.getOwnPropertyDescriptor(bound, "directionalHash")?.value;
  Object.defineProperty(differentGlossaryBound, "directionalHash", {
    value: directionalHash,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  const result = glossary.authorize(placeholder1, differentGlossaryBound);
  assert.equal(result.status, "bypassed");
  assert.equal(result.alerts[0]?.code, "glossary_mismatch");
});

test("authorize rejects spread or JSON-roundtripped bounds without directional provenance", () => {
  const glossary = compileGlossary({
    id: "factory-terms", version: "1", sourceLanguage: "en", targetLanguage: "zh-TW", entries,
  });
  const bound = glossary.bind("torque controller");
  const spread = { ...bound };
  const roundTripped = JSON.parse(JSON.stringify(bound)) as typeof bound;
  for (const candidate of [spread, roundTripped]) {
    const result = glossary.authorize(placeholder1, candidate);
    assert.equal(result.status, "bypassed");
    assert.equal(result.alerts[0]?.code, "glossary_mismatch");
  }
  const reverse = compileGlossaryPair({
    id: "factory-terms", version: "1", sourceLanguage: "en", targetLanguage: "zh-TW", entries,
  }).reverse;
  const reverseResult = reverse.authorize(placeholder1, spread);
  assert.equal(reverseResult.status, "bypassed");
  assert.equal(reverseResult.alerts[0]?.code, "glossary_mismatch");
});
