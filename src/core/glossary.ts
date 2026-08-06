import { createHash } from "node:crypto";

export interface GlossaryEntrySpec {
  readonly id: string;
  readonly source: string;
  readonly aliases: readonly string[];
  readonly targetExact: string;
}

export interface GlossaryEntry {
  readonly id: string;
  readonly source: string;
  readonly aliases: readonly string[];
  readonly targetExact: string;
}

export interface GlossarySpec {
  readonly id: string;
  readonly version: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly entries: readonly GlossaryEntrySpec[];
}

export interface GlossaryBinding {
  readonly entryId: string;
  readonly sourceText: string;
  readonly targetExact: string;
  readonly placeholder: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

export interface BoundGlossaryText {
  readonly text: string;
  readonly glossaryHash: string;
  readonly bindings: readonly GlossaryBinding[];
}

export type GlossaryAlertCode =
  | "glossary_mismatch"
  | "placeholder_missing"
  | "placeholder_duplicate"
  | "placeholder_unknown"
  | "placeholder_reordered"
  | "target_exact_missing";

export interface GlossaryAlert {
  readonly type: "glossary_control_bypassed";
  readonly code: GlossaryAlertCode;
  readonly message: string;
  readonly glossaryId: string;
  readonly glossaryVersion: string;
  readonly glossaryHash: string;
  readonly expectedPlaceholders: readonly string[];
  readonly observedPlaceholders: readonly string[];
}

export interface AuthorizedGlossaryResult {
  readonly status: "authorized";
  readonly text: string;
  readonly alerts: readonly GlossaryAlert[];
  readonly guaranteedTargetExact: readonly string[];
}

export interface BypassedGlossaryResult {
  readonly status: "bypassed";
  readonly text: string;
  readonly alerts: readonly GlossaryAlert[];
  readonly guaranteedTargetExact: readonly string[];
}

export type GlossaryAuthorizationResult = AuthorizedGlossaryResult | BypassedGlossaryResult;

export interface CompiledGlossary {
  readonly id: string;
  readonly version: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly hash: string;
  readonly entries: readonly GlossaryEntry[];
  bind(sourceText: string): BoundGlossaryText;
  authorize(translatedText: string, bound: BoundGlossaryText): GlossaryAuthorizationResult;
}

export interface CompileGlossaryOptions {
  readonly onAlert?: (alert: GlossaryAlert) => void;
}

export class GlossaryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlossaryConflictError";
  }
}

function requireText(value: string, field: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) throw new GlossaryConflictError(`${field} must not be empty`);
  return normalized;
}

function matchKey(value: string): string {
  return requireText(value, "glossary term").toLocaleLowerCase("und");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termPattern(term: string): RegExp {
  const body = term.split(" ").map(escapeRegex).join("\\s+");
  const left = /^[A-Za-z0-9_]/u.test(term) ? "(?<![\\p{L}\\p{N}_])" : "";
  const right = /[A-Za-z0-9_]$/u.test(term) ? "(?![\\p{L}\\p{N}_])" : "";
  return new RegExp(`${left}${body}${right}`, "giu");
}

interface Matcher {
  readonly entry: GlossaryEntry;
  readonly pattern: RegExp;
  readonly normalizedLength: number;
}

interface MatchCandidate {
  readonly entry: GlossaryEntry;
  readonly start: number;
  readonly end: number;
  readonly sourceText: string;
  readonly normalizedLength: number;
}

function collectMatches(sourceText: string, matchers: readonly Matcher[]): MatchCandidate[] {
  const candidates: MatchCandidate[] = [];
  for (const matcher of matchers) {
    matcher.pattern.lastIndex = 0;
    for (const match of sourceText.matchAll(matcher.pattern)) {
      const matchedText = match[0];
      const start = match.index;
      if (matchedText === undefined || start === undefined) continue;
      candidates.push({
        entry: matcher.entry,
        start,
        end: start + matchedText.length,
        sourceText: matchedText,
        normalizedLength: matcher.normalizedLength,
      });
    }
  }
  candidates.sort((a, b) =>
    a.start - b.start ||
    b.normalizedLength - a.normalizedLength ||
    b.end - a.end ||
    a.entry.id.localeCompare(b.entry.id),
  );
  return candidates;
}

function selectNonOverlapping(candidates: readonly MatchCandidate[]): MatchCandidate[] {
  const selected: MatchCandidate[] = [];
  let occupiedUntil = 0;
  for (const candidate of candidates) {
    if (candidate.start < occupiedUntil) continue;
    selected.push(candidate);
    occupiedUntil = candidate.end;
  }
  return selected;
}

function freezeStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

function contentHash(spec: {
  readonly id: string;
  readonly version: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly entries: readonly GlossaryEntry[];
}): string {
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex");
}

export function reverseGlossarySpec(spec: GlossarySpec): GlossarySpec {
  return Object.freeze({
    id: spec.id + "__reverse",
    version: spec.version,
    sourceLanguage: spec.targetLanguage,
    targetLanguage: spec.sourceLanguage,
    entries: Object.freeze(spec.entries.map((entry) => Object.freeze({
      id: entry.id,
      source: entry.targetExact,
      aliases: Object.freeze([]),
      targetExact: entry.source,
    }))),
  });
}

export function compileGlossary(
  spec: GlossarySpec,
  options: CompileGlossaryOptions = {},
): CompiledGlossary {
  const id = requireText(spec.id, "glossary id");
  const version = requireText(spec.version, "glossary version");
  const sourceLanguage = requireText(spec.sourceLanguage, "source language");
  const targetLanguage = requireText(spec.targetLanguage, "target language");
  const ids = new Set<string>();
  const ownersByTerm = new Map<string, string>();

  const entries = spec.entries.map((candidate, index): GlossaryEntry => {
    const entryId = requireText(candidate.id, `entries[${index}].id`);
    if (ids.has(entryId)) throw new GlossaryConflictError(`duplicate glossary entry id: ${entryId}`);
    ids.add(entryId);
    const source = requireText(candidate.source, `entries[${index}].source`);
    if (candidate.targetExact.trim().length === 0) {
      throw new GlossaryConflictError(`entries[${index}].targetExact must not be empty`);
    }

    const sourceKey = matchKey(source);
    const aliasesByKey = new Map<string, string>();
    for (const aliasValue of candidate.aliases) {
      const alias = requireText(aliasValue, `entries[${index}].aliases`);
      const key = matchKey(alias);
      if (key !== sourceKey) aliasesByKey.set(key, alias);
    }
    const aliases = [...aliasesByKey.values()].sort((a, b) => matchKey(a).localeCompare(matchKey(b)));
    for (const term of [source, ...aliases]) {
      const key = matchKey(term);
      const owner = ownersByTerm.get(key);
      if (owner !== undefined && owner !== entryId) {
        throw new GlossaryConflictError(`normalized term "${term}" conflicts between ${owner} and ${entryId}`);
      }
      ownersByTerm.set(key, entryId);
    }
    return Object.freeze({
      id: entryId,
      source,
      aliases: Object.freeze(aliases),
      targetExact: candidate.targetExact,
    });
  }).sort((a, b) => a.id.localeCompare(b.id));

  const frozenEntries = Object.freeze(entries);
  const hash = contentHash({ id, version, sourceLanguage, targetLanguage, entries: frozenEntries });
  const matchers: Matcher[] = [];
  for (const entry of frozenEntries) {
    for (const term of [entry.source, ...entry.aliases]) {
      matchers.push({ entry, pattern: termPattern(term), normalizedLength: matchKey(term).length });
    }
  }

  const emitAlert = (alert: GlossaryAlert): void => {
    try {
      options.onAlert?.(alert);
    } catch {
      // Alert delivery is isolated from the fail-open media path.
    }
  };
  const bypass = (
    code: GlossaryAlertCode,
    message: string,
    translatedText: string,
    expected: readonly string[],
    observed: readonly string[],
  ): BypassedGlossaryResult => {
    const alert: GlossaryAlert = Object.freeze({
      type: "glossary_control_bypassed",
      code,
      message,
      glossaryId: id,
      glossaryVersion: version,
      glossaryHash: hash,
      expectedPlaceholders: freezeStrings(expected),
      observedPlaceholders: freezeStrings(observed),
    });
    emitAlert(alert);
    return Object.freeze({
      status: "bypassed",
      text: translatedText,
      alerts: Object.freeze([alert]),
      guaranteedTargetExact: Object.freeze([]),
    });
  };

  const glossary: CompiledGlossary = {
    id,
    version,
    sourceLanguage,
    targetLanguage,
    hash,
    entries: frozenEntries,
    bind(sourceText: string): BoundGlossaryText {
      const selected = selectNonOverlapping(collectMatches(sourceText, matchers));
      const bindings = selected.map((match, index): GlossaryBinding => Object.freeze({
        entryId: match.entry.id,
        sourceText: match.sourceText,
        targetExact: match.entry.targetExact,
        placeholder: `\u27e6GLOSSARY_${String(index + 1).padStart(4, "0")}\u27e7`,
        sourceStart: match.start,
        sourceEnd: match.end,
      }));
      let cursor = 0;
      let text = "";
      for (const binding of bindings) {
        text += sourceText.slice(cursor, binding.sourceStart) + binding.placeholder;
        cursor = binding.sourceEnd;
      }
      text += sourceText.slice(cursor);
      return Object.freeze({ text, glossaryHash: hash, bindings: Object.freeze(bindings) });
    },
    authorize(translatedText: string, bound: BoundGlossaryText): GlossaryAuthorizationResult {
      const expected = bound.bindings.map((binding) => binding.placeholder);
      const observed = [...translatedText.matchAll(/\u27e6GLOSSARY_[A-Z0-9_-]+\u27e7/gu)].map((match) => match[0]);
      if (bound.glossaryHash !== hash) {
        return bypass("glossary_mismatch", "bound text belongs to another glossary build", translatedText, expected, observed);
      }
      const expectedSet = new Set(expected);
      const seen = new Set<string>();
      let duplicate: string | undefined;
      for (const placeholder of observed) {
        if (seen.has(placeholder)) {
          duplicate = placeholder;
          break;
        }
        seen.add(placeholder);
      }
      if (duplicate !== undefined) {
        return bypass("placeholder_duplicate", `placeholder ${duplicate} occurred more than once`, translatedText, expected, observed);
      }
      const unknown = observed.find((placeholder) => !expectedSet.has(placeholder));
      if (unknown !== undefined) {
        return bypass("placeholder_unknown", `unknown placeholder ${unknown}`, translatedText, expected, observed);
      }
      const missing = expected.find((placeholder) => !seen.has(placeholder));
      if (missing !== undefined) {
        return bypass("placeholder_missing", `required placeholder ${missing} is missing`, translatedText, expected, observed);
      }
      if (observed.some((placeholder, index) => placeholder !== expected[index])) {
        return bypass("placeholder_reordered", "glossary placeholders changed order", translatedText, expected, observed);
      }

      let text = translatedText;
      for (const binding of bound.bindings) {
        text = text.replaceAll(binding.placeholder, () => binding.targetExact);
      }
      const guaranteedTargetExact = bound.bindings.map((binding) => binding.targetExact);
      const absent = guaranteedTargetExact.find((targetExact) => !text.includes(targetExact));
      if (absent !== undefined) {
        return bypass("target_exact_missing", `approved target ${absent} was not present after reinsertion`, translatedText, expected, observed);
      }
      return Object.freeze({
        status: "authorized",
        text,
        alerts: Object.freeze([]),
        guaranteedTargetExact: freezeStrings(guaranteedTargetExact),
      });
    },
  };
  return Object.freeze(glossary);
}
