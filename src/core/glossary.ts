import { createHash } from "node:crypto";

/** Maximum size of a normalized source, target, or alias in Unicode code points. */
export const MAX_GLOSSARY_TERM_CHARACTERS = 1_024;
/** Maximum UTF-8 representation of a normalized source, target, or alias. */
export const MAX_GLOSSARY_TERM_UTF8_BYTES = 4_096;
/** Maximum aliases accepted for one glossary entry. */
export const MAX_GLOSSARY_ALIASES_PER_ENTRY = 64;
/** Maximum aggregate normalized term size in one glossary build, in code points. */
export const MAX_GLOSSARY_NORMALIZED_CHARACTERS = 1_000_000;
/** Maximum quadratic overlap work admitted before the term trie is built. */
export const MAX_GLOSSARY_OVERLAP_WORK = 2_000_000;

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

/** Runtime projection of a glossary entry. Its id is an opaque term id. */
export interface CompiledGlossaryEntry {
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

interface InternalBoundGlossaryText extends BoundGlossaryText {
  readonly directionalHash: string;
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
  /** Present only when the failed authorization can be attributed to one entry. */
  readonly termId?: string;
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
  readonly entries: readonly CompiledGlossaryEntry[];
  bind(sourceText: string): BoundGlossaryText;
  authorize(translatedText: string, bound: BoundGlossaryText): GlossaryAuthorizationResult;
}

export interface CompiledGlossaryPair {
  readonly forward: CompiledGlossary;
  readonly reverse: CompiledGlossary;
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
  if (typeof value !== "string") throw new GlossaryConflictError(`${field} must be text`);
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) throw new GlossaryConflictError(`${field} must not be empty`);
  return normalized;
}

function matchKey(value: string): string {
  return requireText(value, "glossary term").toLocaleLowerCase("und");
}

/**
 * Derives the opaque identifier exposed by runtime glossary bindings.  The
 * customer-supplied entry id is deliberately not an input to this value.
 */
export function deriveOpaqueTermId(
  entry: Pick<GlossaryEntry, "source" | "aliases" | "targetExact">,
): string {
  const canonical = JSON.stringify({
    source: matchKey(entry.source),
    target: matchKey(entry.targetExact),
    aliases: [...entry.aliases].map((alias) => matchKey(alias)).sort(),
  });
  return "term_" + createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

function assertNormalizedTermBounds(normalized: string): void {
  if (
    [...normalized].length > MAX_GLOSSARY_TERM_CHARACTERS ||
    Buffer.byteLength(normalized, "utf8") > MAX_GLOSSARY_TERM_UTF8_BYTES
  ) {
    throw new GlossaryConflictError("glossary term exceeds the maximum normalized size");
  }
}

/**
 * Checks all user-controlled term material before constructing the overlap
 * trie.  The target is included because compileGlossaryPair builds the
 * reverse direction from targetExact.
 */
function assertGlossaryResourceBounds(entries: readonly GlossaryEntrySpec[]): void {
  let aggregateCharacters = 0;
  let overlapWork = 0;
  for (const [index, candidate] of entries.entries()) {
    if (!Array.isArray(candidate.aliases)) {
      throw new GlossaryConflictError("glossary aliases must be an array");
    }
    if (candidate.aliases.length > MAX_GLOSSARY_ALIASES_PER_ENTRY) {
      throw new GlossaryConflictError("glossary entry exceeds the maximum alias count");
    }

    const source = requireText(candidate.source, `entries[${index}].source`);
    const targetExact = requireText(candidate.targetExact, `entries[${index}].targetExact`);
    for (const term of [source, targetExact, ...candidate.aliases]) {
      const normalized = matchKey(term);
      assertNormalizedTermBounds(normalized);
      const characterCount = [...normalized].length;
      aggregateCharacters += characterCount;
      if (aggregateCharacters > MAX_GLOSSARY_NORMALIZED_CHARACTERS) {
        throw new GlossaryConflictError("glossary exceeds the maximum normalized character budget");
      }
      overlapWork += characterCount * characterCount;
      if (overlapWork > MAX_GLOSSARY_OVERLAP_WORK) {
        throw new GlossaryConflictError("glossary exceeds the maximum overlap work budget");
      }
    }
  }
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
  readonly entry: CompiledGlossaryEntry;
  readonly pattern: RegExp;
  readonly normalizedLength: number;
}

interface MatchCandidate {
  readonly entry: CompiledGlossaryEntry;
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

function attributableTermId(bindings: readonly GlossaryBinding[]): string | undefined {
  const entryIds = new Set(bindings.map((binding) => binding.entryId));
  if (entryIds.size !== 1) return undefined;
  return bindings[0]?.entryId;
}

interface NormalizedGlossaryTerm {
  readonly entryId: string;
  readonly term: string;
  readonly characters: readonly string[];
}

interface TermTrieNode {
  readonly children: Map<string, TermTrieNode>;
  entryId: string | undefined;
  term: string | undefined;
  firstCharacter: string | undefined;
  lastCharacter: string | undefined;
}

const ASCII_TERM_CHARACTER = /^[A-Za-z0-9_]$/u;
const TERM_WORD_CHARACTER = /^[\p{L}\p{N}_]$/u;

function newTermTrieNode(): TermTrieNode {
  return {
    children: new Map(),
    entryId: undefined,
    term: undefined,
    firstCharacter: undefined,
    lastCharacter: undefined,
  };
}

function isAsciiTermCharacter(value: string | undefined): boolean {
  return value !== undefined && ASCII_TERM_CHARACTER.test(value);
}

function isTermWordCharacter(value: string | undefined): boolean {
  return value !== undefined && TERM_WORD_CHARACTER.test(value);
}

function hasTermPatternBoundaries(
  text: readonly string[],
  start: number,
  end: number,
  node: TermTrieNode,
): boolean {
  if (isAsciiTermCharacter(node.firstCharacter) && isTermWordCharacter(text[start - 1])) return false;
  if (isAsciiTermCharacter(node.lastCharacter) && isTermWordCharacter(text[end])) return false;
  return true;
}

function assertNoCrossEntryTermOverlaps(entries: readonly GlossaryEntry[]): void {
  const terms: NormalizedGlossaryTerm[] = [];
  const root = newTermTrieNode();

  for (const entry of entries) {
    for (const value of [entry.source, ...entry.aliases]) {
      const term = matchKey(value);
      const characters = [...term];
      const firstCharacter = characters[0];
      const lastCharacter = characters.at(-1);
      if (firstCharacter === undefined || lastCharacter === undefined) {
        throw new GlossaryConflictError("normalized glossary term must not be empty");
      }
      terms.push({ entryId: entry.id, term, characters });
      let node = root;
      for (const character of characters) {
        let child = node.children.get(character);
        if (child === undefined) {
          child = newTermTrieNode();
          node.children.set(character, child);
        }
        node = child;
      }
      if (node.entryId !== undefined && node.entryId !== entry.id) {
        throw new GlossaryConflictError("normalized term conflicts between glossary entries");
      }
      node.entryId = entry.id;
      node.term = term;
      node.firstCharacter = firstCharacter;
      node.lastCharacter = lastCharacter;
    }
  }

  for (const { entryId, characters } of terms) {
    for (let start = 0; start < characters.length; start += 1) {
      let node = root;
      for (let end = start; end < characters.length; end += 1) {
        const character = characters[end];
        if (character === undefined) break;
        const child = node.children.get(character);
        if (child === undefined) break;
        node = child;
        if (
          node.entryId !== undefined &&
          node.entryId !== entryId &&
          hasTermPatternBoundaries(characters, start, end + 1, node)
        ) {
          throw new GlossaryConflictError("normalized term conflicts between glossary entries");
        }
      }
    }
  }
}

function contentHash(spec: {
  readonly id: string;
  readonly version: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly entries: readonly (GlossaryEntry | CompiledGlossaryEntry)[];
}): string {
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex");
}

interface CompileGlossaryInternalOptions extends CompileGlossaryOptions {
  readonly opaqueIdsByEntryId?: ReadonlyMap<string, string>;
  readonly masterHash?: string;
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

/**
 * Compiles the approved mapping and its inverse as one immutable pair. This
 * catches forward and reverse term conflicts, including token-boundary
 * overlaps, before a version can be pinned for either lane.
 */
export function compileGlossaryPair(
  spec: GlossarySpec,
  options: CompileGlossaryOptions = {},
): CompiledGlossaryPair {
  const forward = compileGlossaryInternal(spec, options);
  const opaqueIdsByEntryId = new Map<string, string>();
  for (const candidate of spec.entries) {
    const entryId = requireText(candidate.id, "glossary entry id");
    opaqueIdsByEntryId.set(entryId, deriveOpaqueTermId(candidate));
  }
  const reverse = compileGlossaryInternal(reverseGlossarySpec({
    id: forward.id,
    version: forward.version,
    sourceLanguage: forward.sourceLanguage,
    targetLanguage: forward.targetLanguage,
    entries: spec.entries,
  }), {
    masterHash: forward.hash,
    opaqueIdsByEntryId,
  });
  return Object.freeze({ forward, reverse });
}

export function compileGlossary(
  spec: GlossarySpec,
  options: CompileGlossaryOptions = {},
): CompiledGlossary {
  return compileGlossaryInternal(spec, options);
}

function compileGlossaryInternal(
  spec: GlossarySpec,
  options: CompileGlossaryInternalOptions = {},
): CompiledGlossary {
  const id = requireText(spec.id, "glossary id");
  const version = requireText(spec.version, "glossary version");
  const sourceLanguage = requireText(spec.sourceLanguage, "source language");
  const targetLanguage = requireText(spec.targetLanguage, "target language");
  assertGlossaryResourceBounds(spec.entries);
  const ids = new Set<string>();
  const ownersByTerm = new Map<string, string>();

  const entries = spec.entries.map((candidate, index): GlossaryEntry => {
    const entryId = requireText(candidate.id, `entries[${index}].id`);
    if (ids.has(entryId)) throw new GlossaryConflictError("duplicate glossary entry id");
    ids.add(entryId);
    const source = requireText(candidate.source, `entries[${index}].source`);
    if (candidate.targetExact.trim().length === 0) {
      throw new GlossaryConflictError(`entries[${index}].targetExact must not be empty`);
    }

    const sourceKey = matchKey(source);
    const aliasesByKey = new Map<string, string>();
    const entryTerms = new Set<string>([sourceKey]);
    for (const aliasValue of candidate.aliases) {
      const alias = requireText(aliasValue, `entries[${index}].aliases`);
      const key = matchKey(alias);
      if (entryTerms.has(key)) {
        throw new GlossaryConflictError("ambiguous normalized term is repeated within a glossary entry");
      }
      entryTerms.add(key);
      aliasesByKey.set(key, alias);
    }
    const aliases = [...aliasesByKey.values()].sort((a, b) => matchKey(a).localeCompare(matchKey(b)));
    for (const term of [source, ...aliases]) {
      const key = matchKey(term);
      const owner = ownersByTerm.get(key);
      if (owner !== undefined && owner !== entryId) {
        throw new GlossaryConflictError("normalized term conflicts between glossary entries");
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

  const frozenMasterEntries = Object.freeze(entries);
  assertNoCrossEntryTermOverlaps(frozenMasterEntries);
  const frozenEntries = Object.freeze(frozenMasterEntries.map((entry): CompiledGlossaryEntry => Object.freeze({
    id: options.opaqueIdsByEntryId?.get(entry.id) ?? deriveOpaqueTermId(entry),
    source: entry.source,
    aliases: Object.freeze([...entry.aliases]),
    targetExact: entry.targetExact,
  })).sort((a, b) => a.id.localeCompare(b.id)));
  const hash = options.masterHash ?? contentHash({
    id,
    version,
    sourceLanguage,
    targetLanguage,
    entries: frozenEntries,
  });
  const directionalHash = contentHash({
    id,
    version,
    sourceLanguage,
    targetLanguage,
    entries: frozenEntries,
  });
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
    termId?: string,
  ): BypassedGlossaryResult => {
    const alert: GlossaryAlert = Object.freeze({
      type: "glossary_control_bypassed",
      code,
      message,
      ...(termId === undefined ? {} : { termId }),
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
      const bound = { text, glossaryHash: hash, bindings: Object.freeze(bindings) };
      Object.defineProperty(bound, "directionalHash", {
        value: directionalHash,
        enumerable: false,
        writable: false,
        configurable: false,
      });
      return Object.freeze(bound) as InternalBoundGlossaryText;
    },
    authorize(translatedText: string, bound: BoundGlossaryText): GlossaryAuthorizationResult {
      const expected = bound.bindings.map((binding) => binding.placeholder);
      const observed = [...translatedText.matchAll(/\u27e6GLOSSARY_[A-Z0-9_-]+\u27e7/gu)].map((match) => match[0]);
      const boundDirectionalHash = (bound as Partial<InternalBoundGlossaryText>).directionalHash;
      if (
        bound.glossaryHash !== hash ||
        boundDirectionalHash !== directionalHash
      ) {
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
        return bypass(
          "placeholder_duplicate",
          `placeholder ${duplicate} occurred more than once`,
          translatedText,
          expected,
          observed,
          attributableTermId(bound.bindings.filter((binding) => binding.placeholder === duplicate)),
        );
      }
      const unknown = observed.find((placeholder) => !expectedSet.has(placeholder));
      if (unknown !== undefined) {
        return bypass("placeholder_unknown", `unknown placeholder ${unknown}`, translatedText, expected, observed);
      }
      const missing = expected.find((placeholder) => !seen.has(placeholder));
      if (missing !== undefined) {
        const missingBindings = bound.bindings.filter((binding) => !seen.has(binding.placeholder));
        return bypass(
          "placeholder_missing",
          `required placeholder ${missing} is missing`,
          translatedText,
          expected,
          observed,
          attributableTermId(missingBindings),
        );
      }
      if (observed.some((placeholder, index) => placeholder !== expected[index])) {
        return bypass("placeholder_reordered", "glossary placeholders changed order", translatedText, expected, observed);
      }

      let text = translatedText;
      for (const binding of bound.bindings) {
        text = text.replaceAll(binding.placeholder, () => binding.targetExact);
      }
      const guaranteedTargetExact = bound.bindings.map((binding) => binding.targetExact);
      const absentBindings = bound.bindings.filter((binding) => !text.includes(binding.targetExact));
      if (absentBindings.length > 0) {
        return bypass(
          "target_exact_missing",
          "target exact missing after reinsertion",
          translatedText,
          expected,
          observed,
          attributableTermId(absentBindings),
        );
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
