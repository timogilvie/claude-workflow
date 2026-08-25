#!/usr/bin/env -S npx tsx
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import {
  formatReviewScopeGuardResult,
  validateReviewScope,
} from '../shared/lib/review-scope-guard.ts';

const EXIT_OK = 0;
const EXIT_POLICY = 1;
const EXIT_TOOL = 2;

runTool({
  name: 'check-review-scope',
  description: 'Validate review-iteration changes against the task-owned file baseline',
  options: {
    'repo-dir': { type: 'string', description: 'Repository directory' },
    'feature-dir': { type: 'string', description: 'Task feature directory' },
    'since-commit': { type: 'string', description: 'Review base commit recorded before coding' },
    'base-ref': { type: 'string', description: 'Explicit base ref for committed diff inspection' },
    'head-ref': { type: 'string', description: 'Head ref to inspect (default: HEAD)' },
    'no-working-tree': { type: 'boolean', description: 'Do not include staged/working-tree changes' },
    json: { type: 'boolean', description: 'Emit machine-readable JSON' },
  },
  examples: [
    'npx tsx tools/check-review-scope.ts --repo-dir . --since-commit abc123',
    'npx tsx tools/check-review-scope.ts --repo-dir . --feature-dir features/my-task',
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
        includeWorkingTree: !args['no-working-tree'],
        writeBaseline: true,
      });

      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatReviewScopeGuardResult(result));
      }
      process.exit(result.ok ? EXIT_OK : EXIT_POLICY);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (args.json) {
        console.log(JSON.stringify({ ok: false, error: message }, null, 2));
      } else {
        console.error(`Review scope guard error: ${message}`);
      }
      process.exit(EXIT_TOOL);
    }
  },
});
