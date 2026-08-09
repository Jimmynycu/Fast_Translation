export type TranslationProviderId = 'palabra' | 'openai_native' | 'openai_controlled';

export type TranslationMode = 'fast' | 'balanced' | 'accurate';

export interface TranslationBehavior {
  readonly version: 1;
  readonly mode: TranslationMode;
  readonly inputCommit: 'continuous' | 'speech_end';
  readonly transcriptPolicy: 'provisional_revisions' | 'final_only';
  readonly holdbackMs: number;
  readonly maxBufferedAudioMs: number;
  readonly interruption: 'cut_destination';
  readonly requirements: Readonly<{
    revisions: boolean;
    cancellation: boolean;
    deterministicGlossary: boolean;
  }>;
}

const behaviors: Readonly<Record<TranslationMode, TranslationBehavior>> = {
  fast: {
    version: 1,
    mode: 'fast',
    inputCommit: 'continuous',
    transcriptPolicy: 'provisional_revisions',
    holdbackMs: 0,
    maxBufferedAudioMs: 800,
    interruption: 'cut_destination',
    requirements: { revisions: true, cancellation: true, deterministicGlossary: false },
  },
  balanced: {
    version: 1,
    mode: 'balanced',
    inputCommit: 'continuous',
    transcriptPolicy: 'final_only',
    holdbackMs: 250,
    maxBufferedAudioMs: 1600,
    interruption: 'cut_destination',
    requirements: { revisions: false, cancellation: true, deterministicGlossary: false },
  },
  accurate: {
    version: 1,
    mode: 'accurate',
    inputCommit: 'speech_end',
    transcriptPolicy: 'final_only',
    holdbackMs: 700,
    maxBufferedAudioMs: 2400,
    interruption: 'cut_destination',
    requirements: { revisions: false, cancellation: true, deterministicGlossary: false },
  },
};

export function resolveTranslationBehavior(mode: TranslationMode): TranslationBehavior {
  return behaviors[mode];
}
