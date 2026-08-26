#!/usr/bin/env -S npx tsx
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import {
  REVIEW_SCOPE_GUARD_EXIT_OK,
  REVIEW_SCOPE_GUARD_EXIT_POLICY,
  REVIEW_SCOPE_GUARD_EXIT_TOOL,
  REVIEW_SCOPE_GUARD_UNVERIFIED_MESSAGE,
  formatReviewScopeGuardResult,
  validateReviewScope,
} from '../shared/lib/review-scope-guard.ts';

function exitCodeForStatus(status: 'pass' | 'fail' | 'error'): number {
  if (status === 'pass') {
    return REVIEW_SCOPE_GUARD_EXIT_OK;
  }
  if (status === 'fail') {
    return REVIEW_SCOPE_GUARD_EXIT_POLICY;
  }
  return REVIEW_SCOPE_GUARD_EXIT_TOOL;
}

runTool({
  name: 'check-review-scope',
  description:
    'Block out-of-scope staged files before review-fix commits. With no arguments beyond '
    + '--repo-dir, scope is derived from git (merge base against the integration branch) '
    + 'and the staged index plus working tree are fully evaluated. '
    + 'Exit codes: 0 in scope, 1 policy violation, 2 tool/git failure (scope unverified).',
  options: {
    'repo-dir': { type: 'string', description: 'Repository directory' },
    'feature-dir': { type: 'string', description: 'Task feature directory (optional narrowing signal)' },
    'since-commit': { type: 'string', description: 'Review base commit recorded before coding' },
    'base-ref': { type: 'string', description: 'Explicit base ref for committed diff inspection' },
    'head-ref': { type: 'string', description: 'Head ref to inspect (default: HEAD)' },
    'integration-ref': { type: 'string', description: 'Integration ref for merge-base scope derivation (default: configured integration branch)' },
    'no-working-tree': { type: 'boolean', description: 'Do not include staged/working-tree changes' },
    json: { type: 'boolean', description: 'Emit machine-readable JSON' },
  },
  examples: [
    'npx tsx tools/check-review-scope.ts --repo-dir .',
    'npx tsx tools/check-review-scope.ts --repo-dir . --since-commit abc123',
    'npx tsx tools/check-review-scope.ts --repo-dir . --integration-ref auto/integration',
  ],
  async run({ args }) {
    try {
      const repoDir = resolveRepoDir(args['repo-dir'] as string | undefined);
      const result = validateReviewScope({
        repoDir,
        featureDir: args['feature-dir'] as string | undefined,
        sinceCommit: args['since-commit'] as string | undefined,
        baseRef: args['base-ref'] as string | undefined,
        headRef: (args['head-ref'] as string | undefined) ?? 'HEAD',
        integrationRef: args['integration-ref'] as string | undefined,
        includeWorkingTree: !args['no-working-tree'],
        writeBaseline: true,
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
