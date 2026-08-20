import type { SupportedModelStage } from './model-registry.ts';

export interface StageContextFloor {
  floorTokens: number;
  provenance: string;
  provisional: boolean;
}

export const STAGE_CONTEXT_WINDOW_FLOORS: Record<SupportedModelStage, StageContextFloor> = Object.freeze({
  expansion: {
    floorTokens: 92_160,
    provenance: 'n=12; p95=83389; max=83389; formula=roundUpTo1024(max*1.10); sources=native transcript bootstrap 2026-08-19 plus incident seeds',
    provisional: false,
  },
  planning: {
    floorTokens: 65_536,
    provenance: 'n=0; p95=0; max=0; provisional floor because bootstrap found no planning transcripts with usage',
    provisional: true,
  },
  coding: {
    floorTokens: 228_352,
    provenance: 'n=11; p95=207164; max=207164; formula=roundUpTo1024(max*1.10); sources=2026-08-17 kimi-k2 provider 400 plus native transcript bootstrap 2026-08-19',
    provisional: false,
  },
  review: {
    floorTokens: 65_536,
    provenance: 'n=0; p95=0; max=0; provisional floor because bootstrap found no review transcripts with usage',
    provisional: true,
  },
});

export function getStageContextFloor(stage: SupportedModelStage): number {
  return STAGE_CONTEXT_WINDOW_FLOORS[stage].floorTokens;
}
