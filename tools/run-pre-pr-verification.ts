#!/usr/bin/env tsx
import { getPrePrVerificationConfig } from '../shared/lib/config.ts';
import {
  prePrArtifactPath,
  runPrePrVerification,
  validateArtifactFreshness,
} from '../shared/lib/pre-pr-verification.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const worktreeDir = arg('--worktree');
const featureDir = arg('--feature-dir');
const baseRef = arg('--base-ref');
const mode = arg('--mode') ?? 'run';
const override = process.argv.includes('--override');
const operator = arg('--operator');
const reason = arg('--reason');

if (!worktreeDir || !featureDir || !baseRef) {
  console.error('Usage: run-pre-pr-verification.ts --worktree <path> --feature-dir <path> --base-ref <ref> [--mode run|validate]');
  process.exit(2);
}

try {
  if (mode === 'validate') {
    const result = await validateArtifactFreshness({
      artifactPath: prePrArtifactPath(featureDir),
      worktreeDir,
      baseRef,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.reason === 'passed' ? 0 : 1);
  }

  const config = getPrePrVerificationConfig(worktreeDir);
  if (!config?.enabled || config.policy === 'compatibility') {
    console.log(JSON.stringify({ status: 'compatibility', message: 'prePrVerification is not enabled or is compatibility mode' }, null, 2));
    process.exit(0);
  }
  if (override && (!operator || !reason)) {
    console.error('--override requires --operator and --reason');
    process.exit(2);
  }

  const artifact = await runPrePrVerification({
    worktreeDir,
    featureDir,
    baseRef,
    config,
    override: override ? { operator: operator!, reason: reason! } : undefined,
  });
  console.log(JSON.stringify(artifact, null, 2));
  process.exit(artifact.status === 'passed' ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
