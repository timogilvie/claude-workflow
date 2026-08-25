#!/usr/bin/env -S npx tsx
import { fileURLToPath } from 'node:url';
import {
  REVIEW_SCOPE_GUARD_EXIT_OK,
  REVIEW_SCOPE_GUARD_EXIT_POLICY,
  REVIEW_SCOPE_GUARD_EXIT_TOOL,
  formatReviewScopeGuardText,
  runReviewScopeGuard,
} from '../shared/lib/review-scope-guard.ts';

interface CliArgs {
  repoDir: string;
  integrationRef?: string;
  format: 'json' | 'text';
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    repoDir: process.cwd(),
    format: 'text',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(REVIEW_SCOPE_GUARD_EXIT_OK);
    }
    if (arg === '--json') {
      args.format = 'json';
      continue;
    }
    if (arg === '--format') {
      const value = argv[index + 1];
      if (value !== 'json' && value !== 'text') {
        throw new Error('--format must be either json or text');
      }
      args.format = value;
      index += 1;
      continue;
    }
    if (arg === '--repo-dir') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--repo-dir requires a value');
      }
      args.repoDir = value;
      index += 1;
      continue;
    }
    if (arg === '--integration-ref') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--integration-ref requires a value');
      }
      args.integrationRef = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp(): void {
  console.log(`check-review-scope - block out-of-scope staged files before review-fix commits

Usage:
  npx tsx tools/check-review-scope.ts [--repo-dir <dir>] [--integration-ref <ref>] [--json]

Exit codes:
  0  staged paths are permitted
  1  policy failure: one or more staged paths are out of scope
  2  tool/config/git failure: scope could not be verified
`);
}

function exitCodeForStatus(status: 'pass' | 'fail' | 'error'): number {
  if (status === 'pass') {
    return REVIEW_SCOPE_GUARD_EXIT_OK;
  }
  if (status === 'fail') {
    return REVIEW_SCOPE_GUARD_EXIT_POLICY;
  }
  return REVIEW_SCOPE_GUARD_EXIT_TOOL;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = runReviewScopeGuard({
      repoDir: args.repoDir,
      integrationRef: args.integrationRef,
    });
    if (args.format === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatReviewScopeGuardText(result));
    }
    process.exit(exitCodeForStatus(result.status));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`review-scope-guard: tool error\nNo review commit may be created because the review scope guard could not verify staged scope.\n\nError: ${message}`);
    process.exit(REVIEW_SCOPE_GUARD_EXIT_TOOL);
  }
}
