#!/usr/bin/env -S npx tsx
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import {
  REVIEW_SCOPE_GUARD_EXIT_NO_PR,
  REVIEW_SCOPE_GUARD_EXIT_OK,
  REVIEW_SCOPE_GUARD_EXIT_POLICY,
  REVIEW_SCOPE_GUARD_EXIT_TOOL,
  REVIEW_SCOPE_GUARD_UNVERIFIED_MESSAGE,
  formatReviewScopeGuardResult,
  validateReviewScope,
} from '../shared/lib/review-scope-guard.ts';

function exitCodeForStatus(status: 'pass' | 'fail' | 'error' | 'no-pr'): number {
  if (status === 'pass') {
    return REVIEW_SCOPE_GUARD_EXIT_OK;
  }
  if (status === 'fail') {
    return REVIEW_SCOPE_GUARD_EXIT_POLICY;
  }
  if (status === 'no-pr') {
    return REVIEW_SCOPE_GUARD_EXIT_NO_PR;
  }
  return REVIEW_SCOPE_GUARD_EXIT_TOOL;
}

/**
 * Auto-detect the review base commit for the current task branch when the
 * caller did not pass --since-commit explicitly. Mirrors the same lookup
 * used by tools/review-changes.ts so a check-review-scope invocation writes
 * the baseline artifact reliably (HOK-2913) instead of leaving the fallback
 * as the norm.
 */
function autoDetectSinceCommit(repoDir: string): string | undefined {
  let branch = '';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
  const match = branch.match(/^(?:task|feature|bugfix|bug)\/(.+)$/);
  if (!match) {
    return undefined;
  }
  const slug = match[1];
  for (const dir of ['features', 'bugs']) {
    const taskPath = join(repoDir, dir, slug, 'selected-task.json');
    if (existsSync(taskPath)) {
      try {
        const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
        if (task.reviewBaseCommit) {
          return task.reviewBaseCommit as string;
        }
      } catch {
        // Ignore parse errors — fall through to merge-base fallback.
      }
    }
  }
  return undefined;
}

runTool({
  name: 'check-review-scope',
  description:
    'Block out-of-scope staged files before review-fix commits. With no arguments beyond '
    + '--repo-dir, scope is derived from git (merge base against the integration branch) '
    + 'and the staged index plus working tree are fully evaluated. '
    + 'Exit codes: 0 in scope, 1 policy violation, 2 tool/git failure (scope unverified), '
    + '3 scope OK but no pull request exists yet (with --check-pr).',
  options: {
    'repo-dir': { type: 'string', description: 'Repository directory' },
    'feature-dir': { type: 'string', description: 'Task feature directory (optional narrowing signal)' },
    'since-commit': { type: 'string', description: 'Review base commit recorded before coding' },
    'base-ref': { type: 'string', description: 'Explicit base ref for committed diff inspection' },
    'head-ref': { type: 'string', description: 'Head ref to inspect (default: HEAD)' },
    'integration-ref': { type: 'string', description: 'Integration ref for merge-base scope derivation (default: configured integration branch)' },
    'no-working-tree': { type: 'boolean', description: 'Do not include staged/working-tree changes' },
    'check-pr': { type: 'boolean', description: 'Detect whether the branch has a pull request; on scope pass with no PR, exit 3' },
    json: { type: 'boolean', description: 'Emit machine-readable JSON' },
  },
  examples: [
    'npx tsx tools/check-review-scope.ts --repo-dir .',
    'npx tsx tools/check-review-scope.ts --repo-dir . --since-commit abc123',
    'npx tsx tools/check-review-scope.ts --repo-dir . --integration-ref auto/integration',
    'npx tsx tools/check-review-scope.ts --repo-dir . --check-pr',
  ],
  async run({ args }) {
    try {
      const repoDir = resolveRepoDir(args['repo-dir'] as string | undefined);
      const explicitSinceCommit = args['since-commit'] as string | undefined;
      const sinceCommit = explicitSinceCommit ?? autoDetectSinceCommit(repoDir);
      const result = validateReviewScope({
        repoDir,
        featureDir: args['feature-dir'] as string | undefined,
        sinceCommit,
        baseRef: args['base-ref'] as string | undefined,
        headRef: (args['head-ref'] as string | undefined) ?? 'HEAD',
        integrationRef: args['integration-ref'] as string | undefined,
        includeWorkingTree: !args['no-working-tree'],
        writeBaseline: true,
        checkPullRequest: !!args['check-pr'],
      });

      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatReviewScopeGuardResult(result));
      }
      process.exit(exitCodeForStatus(result.status));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (args.json) {
        console.log(JSON.stringify({ ok: false, status: 'error', error: message }, null, 2));
      } else {
        console.error(`Review scope guard error (scope unverified): ${message}\n${REVIEW_SCOPE_GUARD_UNVERIFIED_MESSAGE}`);
      }
      process.exit(REVIEW_SCOPE_GUARD_EXIT_TOOL);
    }
  },
});
