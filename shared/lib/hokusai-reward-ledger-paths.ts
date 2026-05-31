import { join } from 'node:path';
import { resolveFromMainRepo } from './git-utils.ts';

const HOKUSAI_ROOT = join('.wavemill', 'hokusai');

export interface HokusaiRewardLedgerPaths {
  rootDir: string;
  ledgerPath: string;
}

export function resolveHokusaiRewardLedgerPaths(repoDir?: string): HokusaiRewardLedgerPaths {
  const rootDir = resolveFromMainRepo(HOKUSAI_ROOT, repoDir);
  return {
    rootDir,
    ledgerPath: join(rootDir, 'reward-ledger.json'),
  };
}
