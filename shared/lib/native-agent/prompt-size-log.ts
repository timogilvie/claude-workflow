/**
 * Prompt Size Sample Log
 *
 * Append-only JSONL log at `.wavemill/evals/stage-prompt-sizes.jsonl` that
 * records per-stage native-agent prompt sizes for the purpose of deriving
 * stage-specific context window floors empirically.
 *
 * Two sample sources are recorded from the native loop:
 *   - `preflight-estimate`: token estimate produced before dispatch.
 *   - `run-peak`: peak `input + cacheRead + cacheWrite` observed across turns.
 *
 * Design notes:
 *   - Append-only files are lock-free per project conventions.
 *   - All I/O is fail-open: any error is swallowed so logging never breaks a
 *     run. Callers may attach a `.catch(() => {})` for extra safety.
 *   - Malformed lines are silently skipped by the reader.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonlRecord } from '../jsonl-utils.ts';
import { resolveEvalsDir } from '../evals-paths.ts';

const LOG_FILENAME = 'stage-prompt-sizes.jsonl';

export type PromptSizeSampleSource = 'preflight-estimate' | 'run-peak';

export interface PromptSizeSample {
  recordedAt: string;
  stage: string;
  model: string;
  provider?: string;
  source: PromptSizeSampleSource;
  promptTokens: number;
  contextWindowLimit?: number;
  session?: string;
  issue?: string;
}

export function resolvePromptSizeLogPath(repoDir?: string): string {
  return join(resolveEvalsDir(undefined, repoDir).dir, LOG_FILENAME);
}

/**
 * Append a prompt-size sample. Fail-open: any I/O error is swallowed and the
 * returned promise resolves either way. The reason to keep it async is that
 * callers already treat it as a fire-and-forget promise inside the loop.
 */
export async function appendPromptSizeSample(
  repoDir: string | undefined,
  sample: PromptSizeSample,
): Promise<void> {
  try {
    const path = resolvePromptSizeLogPath(repoDir);
    appendJsonlRecord(path, sample);
  } catch {
    // Swallow: logging must never break a native run.
  }
}

/**
 * Read all samples from the log. Missing file returns []. Malformed lines are
 * silently skipped.
 */
export function readPromptSizeSamples(repoDir?: string): PromptSizeSample[] {
  const path = resolvePromptSizeLogPath(repoDir);
  if (!existsSync(path)) {
    return [];
  }
  const content = readFileSync(path, 'utf-8');
  const samples: PromptSizeSample[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      samples.push(JSON.parse(line) as PromptSizeSample);
    } catch {
      // Skip malformed JSONL entries.
    }
  }
  return samples;
}
