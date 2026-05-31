import { isAbsolute, join, resolve } from 'node:path';
import { resolveFromMainRepo } from './git-utils.ts';

const HOKUSAI_ROOT = join('.wavemill', 'hokusai');

export interface HokusaiQueuePaths {
  rootDir: string;
  queueDir: string;
  pendingPath: string;
  deadLetterPath: string;
  statePath: string;
  exportDir: string;
  ledgerPath: string;
}

export function resolveHokusaiQueuePaths(repoDir?: string): HokusaiQueuePaths {
  const rootDir = resolveFromMainRepo(HOKUSAI_ROOT, repoDir);
  return {
    rootDir,
    queueDir: join(rootDir, 'queue'),
    pendingPath: join(rootDir, 'queue', 'pending.jsonl'),
    deadLetterPath: join(rootDir, 'queue', 'dead-letter.jsonl'),
    statePath: join(rootDir, 'state.json'),
    exportDir: join(rootDir, 'export'),
    ledgerPath: join(rootDir, 'ledger.jsonl'),
  };
}

export function resolveHokusaiLedgerDir(repoDir?: string): string {
  return resolveFromMainRepo(HOKUSAI_ROOT, repoDir);
}

export function resolveHokusaiLedgerPath(repoDir?: string): string {
  return join(resolveHokusaiLedgerDir(repoDir), 'ledger.jsonl');
}

export function resolveContributionExportPath(exportPath: string, repoDir?: string): string {
  if (isAbsolute(exportPath)) {
    return resolve(exportPath);
  }
  return resolveFromMainRepo(exportPath, repoDir);
}
