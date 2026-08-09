import assert from "node:assert/strict";
import { test } from "node:test";

import {
  GlossaryConflictError,
  compileGlossary,
  compileGlossaryPair,
  reverseGlossarySpec,
  type GlossaryAlert,
} from "../src/core/glossary.js";

const torqueTarget = "\u626d\u529b\u63a7\u5236\u5668";
const controllerTarget = "\u63a7\u5236\u5668";
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
  { id: "controller", source: "controller", aliases: [], targetExact: controllerTarget },
] as const;

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

test("bind chooses unique longest, non-overlapping source matches", () => {
  const glossary = compileGlossary({
    id: "factory-terms", version: "1", sourceLanguage: "en", targetLanguage: "zh-TW", entries,
  });
  const bound = glossary.bind("Inspect the TORQUE   controller, then the controller and TCU.");
  assert.equal(bound.text, `Inspect the ${placeholder1}, then the ${placeholder2} and ${placeholder3}.`);
  assert.deepEqual(bound.bindings.map(({ entryId, sourceText, placeholder }) => ({ entryId, sourceText, placeholder })), [
    { entryId: "torque-controller", sourceText: "TORQUE   controller", placeholder: placeholder1 },
    { entryId: "controller", sourceText: "controller", placeholder: placeholder2 },
    { entryId: "torque-controller", sourceText: "TCU", placeholder: placeholder3 },
  ]);
});

test("authorize deterministically reinserts exact approved targets", () => {
  const glossary = compileGlossary({
    id: "factory-terms", version: "1", sourceLanguage: "en", targetLanguage: "zh-TW", entries,
  });
  const bound = glossary.bind("Inspect the torque controller and controller.");
  const authorized = glossary.authorize(`translated ${placeholder1} plus ${placeholder2}`, bound);
  assert.equal(authorized.status, "authorized");
  assert.equal(authorized.text, `translated ${torqueTarget} plus ${controllerTarget}`);
  assert.deepEqual(authorized.alerts, []);
  assert.deepEqual(authorized.guaranteedTargetExact, [torqueTarget, controllerTarget]);
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

test("authorize fails open on duplicate, unknown, or reordered placeholders", () => {
  const glossary = compileGlossary({
    id: "factory-terms", version: "1", sourceLanguage: "en", targetLanguage: "zh-TW", entries,
  });
  const bound = glossary.bind("torque controller then controller");
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

test("authorize rejects bindings from a different immutable glossary", () => {
  const glossary = compileGlossary({
    id: "factory-terms", version: "1", sourceLanguage: "en", targetLanguage: "zh-TW", entries,
  });
  const bound = glossary.bind("torque controller");
  const result = glossary.authorize(placeholder1, { ...bound, glossaryHash: "0".repeat(64) });
  assert.equal(result.status, "bypassed");
  assert.equal(result.alerts[0]?.code, "glossary_mismatch");
});
