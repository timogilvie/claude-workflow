#!/usr/bin/env -S npx tsx
/**
 * Persist the review-scope baseline artifact at the coding→review handoff.
 *
 * The controller invokes this once the coding phase completes, so the guard
 * runs against a persisted `.review-scope-baseline.json` snapshot of the
 * task deliverable rather than falling back to the merge-base every time
 * (HOK-2913). Any failure is reported to stderr and returns a non-zero exit,
 * but the handoff is still allowed to proceed — the merge-base fallback in
 * the guard remains available as the legacy path.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
import { writeReviewScopeBaseline } from '../shared/lib/review-scope-guard.ts';

function currentBranch(repoDir: string): string | undefined {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function slugFromBranch(branch: string | undefined): string | undefined {
  if (!branch) {
    return undefined;
  }
  const match = branch.match(/^(?:task|feature|bugfix|bug)\/(.+)$/);
  return match?.[1];
}

function resolveFeatureDir(repoDir: string, explicit?: string, slug?: string): string | undefined {
  if (explicit) {
    return resolve(explicit);
  }
  if (!slug) {
    return undefined;
  }
  for (const root of ['features', 'bugs']) {
    const candidate = join(repoDir, root, slug);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveSinceCommit(featureDir: string, explicit?: string): string | undefined {
  if (explicit) {
    return explicit;
  }
  const selectedTaskPath = join(featureDir, 'selected-task.json');
  if (!existsSync(selectedTaskPath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(selectedTaskPath, 'utf-8')) as { reviewBaseCommit?: string };
    return parsed.reviewBaseCommit ?? undefined;
  } catch {
    return undefined;
  }
}

runTool({
  name: 'write-review-scope-baseline',
  description:
    'Snapshot the coding deliverable and write .review-scope-baseline.json into the '
    + 'task feature directory so the review-scope guard evaluates against a persisted '
    + 'baseline rather than the merge-base fallback. Invoked at the coding→review handoff.',
  options: {
    'repo-dir': { type: 'string', description: 'Repository directory' },
    'feature-dir': { type: 'string', description: 'Task feature directory (autodetected from branch when omitted)' },
    'since-commit': { type: 'string', description: 'Review base commit (autodetected from selected-task.json)' },
    'head-ref': { type: 'string', description: 'Head ref to snapshot (default: HEAD)' },
    json: { type: 'boolean', description: 'Emit machine-readable JSON' },
  },
  examples: [
    'npx tsx tools/write-review-scope-baseline.ts --repo-dir .',
    'npx tsx tools/write-review-scope-baseline.ts --repo-dir . --feature-dir features/HOK-123',
  ],
  async run({ args }) {
    const repoDir = resolveRepoDir(args['repo-dir'] as string | undefined);
    const branch = currentBranch(repoDir);
    const slug = slugFromBranch(branch);
    const featureDir = resolveFeatureDir(
      repoDir,
      args['feature-dir'] as string | undefined,
      slug,
    );
    if (!featureDir) {
      const message = 'unable to resolve feature directory for review-scope baseline';
      if (args.json) {
        console.log(JSON.stringify({ written: false, reason: 'no_feature_dir', branch, slug }, null, 2));
      } else {
        console.error(message);
      }
      process.exit(1);
    }
    const sinceCommit = resolveSinceCommit(featureDir, args['since-commit'] as string | undefined);
    if (!sinceCommit) {
      const message = 'unable to resolve review base commit for review-scope baseline';
      if (args.json) {
        console.log(JSON.stringify({
          written: false,
          reason: 'no_since_commit',
          featureDir,
        }, null, 2));
      } else {
        console.error(message);
      }
      process.exit(1);
    }
    try {
      const baseline = writeReviewScopeBaseline({
        repoDir,
        featureDir,
        sinceCommit,
        headRef: (args['head-ref'] as string | undefined) ?? 'HEAD',
      });
      if (!baseline) {
        const message = 'writeReviewScopeBaseline returned null; baseline not written';
        if (args.json) {
          console.log(JSON.stringify({ written: false, reason: 'null_baseline' }, null, 2));
        } else {
          console.error(message);
        }
        process.exit(1);
      }
      if (args.json) {
        console.log(JSON.stringify({
          written: true,
          featureDir,
          sinceCommit: baseline.sinceCommit,
          headRef: baseline.headRef,
          paths: baseline.paths,
        }, null, 2));
      } else {
        console.log(
          `Wrote review-scope baseline for ${basename(featureDir)}: `
          + `${baseline.paths.length} path(s), sinceCommit=${baseline.sinceCommit.slice(0, 8)}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (args.json) {
        console.log(JSON.stringify({ written: false, reason: 'error', error: message }, null, 2));
      } else {
        console.error(`Failed to write review-scope baseline: ${message}`);
      }
      process.exit(1);
    }
  },
});
