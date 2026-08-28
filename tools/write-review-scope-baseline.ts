#!/usr/bin/env -S npx tsx
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import {
  ensureReviewScopeBaseline,
  resolveTaskFeatureDir,
} from '../shared/lib/review-scope-guard.ts';

runTool({
  name: 'write-review-scope-baseline',
  description:
    'Materialize the .review-scope-baseline.json artifact recording the committed coding '
    + 'path set at the coding→review handoff. Create-if-absent: an existing baseline is '
    + 'never regenerated. Exit codes: 0 baseline present (created or pre-existing), '
    + '1 baseline could not be materialized.',
  options: {
    'repo-dir': { type: 'string', description: 'Repository directory (worktree)' },
    'feature-dir': { type: 'string', description: 'Task feature directory owning the baseline (default: derived from branch)' },
    'since-commit': { type: 'string', description: 'Task start commit (default: merge base against the integration branch)' },
    'head-ref': { type: 'string', description: 'Head ref for the baseline diff (default: HEAD)' },
    'integration-ref': { type: 'string', description: 'Integration ref for merge-base derivation (default: configured integration branch)' },
    json: { type: 'boolean', description: 'Emit machine-readable JSON' },
  },
  examples: [
    'npx tsx tools/write-review-scope-baseline.ts --repo-dir .',
    'npx tsx tools/write-review-scope-baseline.ts --repo-dir . --feature-dir features/my-task',
  ],
  async run({ args }) {
    const repoDir = resolveRepoDir(args['repo-dir'] as string | undefined);
    const featureDir = (args['feature-dir'] as string | undefined)
      ?? resolveTaskFeatureDir(repoDir) ?? undefined;
    if (!featureDir) {
      console.error('write-review-scope-baseline: no feature directory resolved (pass --feature-dir)');
      process.exit(1);
    }

    try {
      const result = ensureReviewScopeBaseline({
        repoDir,
        featureDir,
        sinceCommit: args['since-commit'] as string | undefined,
        headRef: args['head-ref'] as string | undefined,
        integrationRef: args['integration-ref'] as string | undefined,
      });
      if (args.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `${result.created ? 'Created' : 'Kept existing'} review-scope baseline at ${result.baselinePath} `
          + `(${result.baseline.paths.length} path(s), since ${result.baseline.sinceCommit})`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`write-review-scope-baseline: ${message}`);
      process.exit(1);
    }
  },
});
