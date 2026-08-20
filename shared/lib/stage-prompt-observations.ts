import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_MODEL_REGISTRY,
  getModel,
  type ModelRegistry,
  type NativeProviderName,
  type SupportedModelStage,
} from './model-registry.ts';

export interface AppendStagePromptObservationInput {
  repoDir: string;
  stage: SupportedModelStage;
  model: string;
  provider: NativeProviderName | string;
  peakRequestTokens: number;
  totalInputTokens: number;
  turns: number;
  registry?: ModelRegistry;
  source?: string;
  now?: Date;
}

export function stagePromptObservationsPath(repoDir: string): string {
  return join(repoDir, '.wavemill', 'evals', 'stage-prompt-observations.jsonl');
}

export function appendStagePromptObservation(input: AppendStagePromptObservationInput): void {
  try {
    if (!Number.isFinite(input.peakRequestTokens) || input.peakRequestTokens <= 0) {
      return;
    }
    const path = stagePromptObservationsPath(input.repoDir);
    mkdirSync(join(input.repoDir, '.wavemill', 'evals'), { recursive: true });
    const registry = input.registry ?? DEFAULT_MODEL_REGISTRY;
    const capabilities = getModel(registry, input.model);
    const record = {
      ts: (input.now ?? new Date()).toISOString(),
      stage: input.stage,
      model: input.model,
      provider: input.provider,
      peakRequestTokens: input.peakRequestTokens,
      totalInputTokens: input.totalInputTokens,
      turns: input.turns,
      ...(capabilities ? { contextWindowTokens: capabilities.contextWindowTokens } : {}),
      source: input.source ?? 'native-agent-loop',
    };
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf-8');
  } catch {
    // Observability must never fail a native run.
  }
}
