import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getHokusaiContributionsConfig } from './config.ts';
import { getContributionConsentStatus } from './hokusai-consent.ts';
import { listUnexportedEntries, updateExportCursor, type QueueAccessOptions } from './hokusai-queue.ts';
import { resolveContributionExportPath, resolveHokusaiQueuePaths } from './hokusai-queue-paths.ts';

export interface ExportQueueResult {
  status: 'disabled' | 'unconfigured' | 'exported' | 'empty';
  exportedCount: number;
  path?: string;
}

function defaultExportPath(repoDir?: string): string {
  return resolveHokusaiQueuePaths(repoDir).exportDir;
}

export async function exportPendingContributions(
  opts: QueueAccessOptions = {},
): Promise<ExportQueueResult> {
  const consent = getContributionConsentStatus(opts);
  if (!consent.submissionAllowed) {
    return { status: 'disabled', exportedCount: 0 };
  }

  const config = getHokusaiContributionsConfig(opts.repoDir);
  const configuredPath = config.exportPath;
  if (!configuredPath) {
    return { status: 'unconfigured', exportedCount: 0 };
  }

  const entries = listUnexportedEntries(opts);
  if (entries.length === 0) {
    return { status: 'empty', exportedCount: 0 };
  }

  const now = opts.now ?? new Date();
  const dateStamp = now.toISOString().slice(0, 10);
  const baseDir = resolveContributionExportPath(configuredPath || defaultExportPath(opts.repoDir), opts.repoDir);
  const exportPath = join(baseDir, `contributions-${dateStamp}.jsonl`);

  mkdirSync(dirname(exportPath), { recursive: true });
  for (const entry of entries) {
    appendFileSync(exportPath, `${JSON.stringify(entry.row)}\n`, 'utf-8');
  }

  await updateExportCursor(entries.length, opts);
  return { status: 'exported', exportedCount: entries.length, path: exportPath };
}
