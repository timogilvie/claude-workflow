#!/usr/bin/env -S npx tsx

import { execSync } from 'node:child_process';
import { loadWavemillConfig, validateDriftConfiguration } from '../shared/lib/config.ts';

function inferRepo(): string | null {
  try {
    const remote = execSync('git config --get remote.origin.url', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = remote.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function inferBranch(): string {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'auto/integration';
  } catch {
    return 'auto/integration';
  }
}

async function main(): Promise<void> {
  const repoDir = process.argv[2] || process.cwd();
  const config = loadWavemillConfig(repoDir);
  if (!config.prePrVerification?.enabled) {
    return;
  }

  const repo = inferRepo();
  if (!repo) {
    console.warn('CI contract drift: skipped; unable to infer GitHub repo.');
    return;
  }

  await validateDriftConfiguration(config, repoDir, repo, inferBranch());
}

main().catch((err) => {
  console.warn(`CI contract drift: skipped; ${(err as Error).message}`);
});
