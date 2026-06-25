import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResourceRef } from '../resource-registry.ts';
import { logPromptUsage } from '../prompt-registry.ts';
import { registerNativeRuntime } from '../resource-adapters/native-runtime-adapter.ts';
import { recordUse } from '../resource-manifest.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const NATIVE_PHASE_PROMPT_PATH = resolve(__dirname, '../../../tools/prompts/native-read-only-phase.md');

const FALLBACK_NATIVE_PROMPT = [
  'You are a read-only native planning agent.',
  'Investigate the codebase using read-only tools and produce an implementation plan.',
  'Do not modify any files.',
].join('\n');

export function loadNativePhasePrompt(repoDir?: string): {
  content: string;
  promptRef: ResourceRef | null;
} {
  let content = FALLBACK_NATIVE_PROMPT;

  try {
    if (existsSync(NATIVE_PHASE_PROMPT_PATH)) {
      content = readFileSync(NATIVE_PHASE_PROMPT_PATH, 'utf-8');
    }
  } catch (err) {
    console.warn(`[native-prompts] Failed to read native phase prompt template: ${(err as Error).message}`);
  }

  const promptRef = logPromptUsage(NATIVE_PHASE_PROMPT_PATH, content, { dir: repoDir });
  return { content, promptRef };
}

export function registerAndRecordNativeProvenance(options: {
  sessionId: string;
  phase: string;
  provider: string;
  model: string;
  api: string;
  tools: readonly { name: string; class: string }[];
  promptRef: ResourceRef | null | undefined;
  repoDir?: string;
}): void {
  try {
    const refs = registerNativeRuntime({
      phase: options.phase,
      provider: options.provider,
      model: options.model,
      api: options.api,
      tools: options.tools,
      promptRef: options.promptRef,
      repoDir: options.repoDir,
    });
    if (refs.runtime) recordUse(options.sessionId, options.phase, refs.runtime, options.repoDir);
    if (refs.toolSet) recordUse(options.sessionId, options.phase, refs.toolSet, options.repoDir);
  } catch (err) {
    console.warn(`[native-prompts] Failed to record native provenance: ${(err as Error).message}`);
  }
}
