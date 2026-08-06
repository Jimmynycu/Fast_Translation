import { compileGlossary, type CompiledGlossary } from "../core/glossary.js";
import { DISCOVERY_CANDIDATES, type DiscoveryCandidate } from "./discovery.js";
import { BENCHMARK_MANIFEST, type BenchmarkDirection } from "./protocol.js";
import { evaluateTerminology, summarizeLatencies } from "./stats.js";

export interface MechanismSelfCheckReport {
  readonly verdict: "MECHANISM_PASS" | "MECHANISM_FAIL";
  readonly acceptanceVerdict: "NOT_RUN";
  readonly terminology: ReturnType<typeof evaluateTerminology>;
  readonly glossaryOverheadMs: ReturnType<typeof summarizeLatencies>;
  readonly limitations: readonly string[];
}

function candidatesFor(direction: BenchmarkDirection): readonly DiscoveryCandidate[] {
  return DISCOVERY_CANDIDATES.filter((candidate) => candidate.direction === direction);
}

function candidateGlossary(
  direction: BenchmarkDirection,
  candidates: readonly DiscoveryCandidate[],
): CompiledGlossary {
  return compileGlossary({
    id: `built-in-candidate-${direction.toLocaleLowerCase("en-US")}`,
    version: "candidate-mechanism-v1",
    sourceLanguage: candidates[0]?.sourceLanguage ?? "",
    targetLanguage: candidates[0]?.targetLanguage ?? "",
    entries: candidates.map((candidate) => ({
      id: candidate.id,
      source: candidate.sourceTerm,
      aliases: [],
      targetExact: candidate.provisionalTargetExact,
    })),
  });
}

export function runMechanismSelfCheck(
  now: () => number = () => performance.now(),
): MechanismSelfCheckReport {
  const observations: Parameters<typeof evaluateTerminology>[0][number][] = [];
  const timings: number[] = [];
  const candidatesByDirection = Object.freeze({
    A_TO_B: candidatesFor("A_TO_B"),
    B_TO_A: candidatesFor("B_TO_A"),
  });
  const glossaries = Object.freeze({
    A_TO_B: candidateGlossary("A_TO_B", candidatesByDirection.A_TO_B),
    B_TO_A: candidateGlossary("B_TO_A", candidatesByDirection.B_TO_A),
  });

  for (const direction of ["A_TO_B", "B_TO_A"] as const) {
    const glossary = glossaries[direction];
    for (const candidate of candidatesByDirection[direction]) {
      const bound = glossary.bind(candidate.sourceSentence);
      // This isolates our deterministic placeholder/reinsertion mechanism. It
      // deliberately does not pretend that an AI provider has passed.
      const authorized = glossary.authorize(bound.text, bound);
      observations.push({
        caseId: candidate.id,
        direction,
        expectedTargetExact: candidate.provisionalTargetExact,
        actualTargetText: authorized.text,
        isPositive: true,
        alertCodes: authorized.alerts.map((alert) => alert.code),
      });
    }
  }

  for (let index = 0; index < BENCHMARK_MANIFEST.latencyRuns.length; index += 1) {
    const run = BENCHMARK_MANIFEST.latencyRuns[index];
    if (run === undefined) throw new Error("Latency manifest contains an empty run");
    const candidates = candidatesByDirection[run.direction];
    const candidate = candidates[index % candidates.length];
    if (candidate === undefined) throw new Error("Latency self-check has no candidate");
    const glossary = glossaries[run.direction];
    const started = now();
    const bound = glossary.bind(candidate.sourceSentence);
    glossary.authorize(bound.text, bound);
    const elapsed = now() - started;
    if (!Number.isFinite(elapsed) || elapsed < 0) {
      throw new RangeError("Self-check clock must be finite and monotonic");
    }
    timings.push(elapsed);
  }

  const terminology = evaluateTerminology(observations);
  return Object.freeze({
    verdict: terminology.passed ? "MECHANISM_PASS" : "MECHANISM_FAIL",
    acceptanceVerdict: "NOT_RUN",
    terminology,
    glossaryOverheadMs: summarizeLatencies(timings),
    limitations: Object.freeze([
      "Candidate terms are provisional and require customer Glossary Owner approval.",
      "No STT, text translation, TTS, acoustic latency, Palabra, or human review was run.",
      "Run live discovery and the frozen 24-case formal corpus before any product go/no-go claim.",
    ]),
  });
}
