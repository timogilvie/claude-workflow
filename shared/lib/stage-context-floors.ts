import type { SupportedModelStage } from './model-registry.ts';

export interface StageContextFloor {
  floorTokens: number;
  provenance: string;
  provisional: boolean;
}

/**
 * Per-stage minimum context window a model must advertise to be eligible.
 *
 * Derived by `tools/derive-stage-context-floors.ts` from native-run prompt
 * observations: the p95 of peak request tokens, excluding runs whose prompt
 * filled the running model's own window. Those runs are the failures the floor
 * exists to prevent; counting them would ratchet the floor up after every
 * incident until only the largest-context models stayed eligible.
 *
 * Stages with too few measured samples keep a provisional 65,536 floor rather
 * than an assumed value.
 */
export const STAGE_CONTEXT_WINDOW_FLOORS: Record<SupportedModelStage, StageContextFloor> = Object.freeze({
  expansion: {
    floorTokens: 84_992,
    provenance: 'n=14; overflowDropped=0; p50=73700; p95=84021; max=84167; formula=roundUpTo1024(p95 of non-overflow samples); sources=native transcript bootstrap 2026-08-20',
    provisional: false,
  },
  planning: {
    floorTokens: 65_536,
    provenance: 'n=0; provisional floor because the bootstrap found no planning transcripts carrying usage',
    provisional: true,
  },
  coding: {
    floorTokens: 186_368,
    provenance: 'n=11; overflowDropped=2; p50=101101; p95=185423; max=207164; formula=roundUpTo1024(p95 of non-overflow samples); sources=native transcript bootstrap 2026-08-20 plus 2026-08-17 kimi-k2 incident seed',
    provisional: false,
  },
  review: {
    floorTokens: 65_536,
    provenance: 'n=0; provisional floor because the bootstrap found no review transcripts carrying usage',
    provisional: true,
  },
});

export function getStageContextFloor(stage: SupportedModelStage): number {
  return STAGE_CONTEXT_WINDOW_FLOORS[stage].floorTokens;
}
