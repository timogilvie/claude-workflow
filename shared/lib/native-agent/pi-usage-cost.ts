import type { SessionModelUsage } from '../session-adapters.ts';
import type { TranscriptUsage } from './transcript.ts';

/**
 * Convert native transcript usage into the common session usage shape used by
 * workflow cost scanning.
 *
 * Field mapping mirrors the transcript schema:
 * - input -> inputTokens
 * - output -> outputTokens
 * - cacheRead -> cacheReadTokens
 * - cacheWrite -> cacheCreationTokens
 */
export function piUsageToSessionModelUsage(usage: TranscriptUsage | undefined): SessionModelUsage {
  return {
    inputTokens: usage?.input ?? 0,
    cacheCreationTokens: usage?.cacheWrite ?? 0,
    cacheReadTokens: usage?.cacheRead ?? 0,
    outputTokens: usage?.output ?? 0,
  };
}
