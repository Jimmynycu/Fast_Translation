import type {
  GenerationRef,
  TranslationEvent,
  TranslationPort,
  TranslationProfile,
  TranslationRequest,
} from "../../core/types.js";

export class TranslationProfileUnavailableError extends Error {
  readonly profile: TranslationProfile;

  constructor(profile: TranslationProfile) {
    super(`Translation profile ${profile} is not configured on this Harness`);
    this.name = "TranslationProfileUnavailableError";
    this.profile = profile;
  }
}

export class TranslationProfileRouter implements TranslationPort {
  readonly #ports: ReadonlyMap<TranslationProfile, TranslationPort>;

  constructor(ports: ReadonlyMap<TranslationProfile, TranslationPort>) {
    if (ports.size === 0) throw new RangeError("At least one translation profile is required");
    this.#ports = new Map(ports);
  }

  has(profile: TranslationProfile): boolean {
    return this.#ports.has(profile);
  }

  available(): readonly TranslationProfile[] {
    return Object.freeze([...this.#ports.keys()].sort());
  }

  translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    const port = this.#ports.get(request.context.profile);
    if (port === undefined) throw new TranslationProfileUnavailableError(request.context.profile);
    return port.translate(request);
  }

  async cancel(generation: GenerationRef): Promise<void> {
    await Promise.allSettled(
      [...new Set(this.#ports.values())].map(async (port) => port.cancel(generation)),
    );
  }
}
