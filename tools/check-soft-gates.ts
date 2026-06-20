#!/usr/bin/env -S npx tsx

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { runSoftGates, type SoftGateRunResult } from '../shared/lib/soft-gates.ts';

interface SoftGateTarget {
  taskId?: string;
  slug?: string;
  featureDir?: string;
}

function readWorkflowState(repoDir: string): Record<string, unknown> | null {
  const statePath = join(repoDir, '.wavemill', 'workflow-state.json');
  if (!existsSync(statePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function listTargetsFromWorkflowState(repoDir: string): SoftGateTarget[] {
  const workflowState = readWorkflowState(repoDir);
  const tasks = workflowState?.tasks;
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) {
    return [];
  }

  const targets: SoftGateTarget[] = [];
  for (const [taskId, rawTask] of Object.entries(tasks as Record<string, unknown>)) {
    if (!rawTask || typeof rawTask !== 'object' || Array.isArray(rawTask)) {
      continue;
    }
    const task = rawTask as Record<string, unknown>;
    const slug = typeof task.slug === 'string' ? task.slug : undefined;
    const featureDir = typeof task.worktree === 'string' ? task.worktree : undefined;
    targets.push({ taskId, slug, featureDir });
  }
  return targets;
}

runTool({
  name: 'check-soft-gates',
  description: 'Emit non-blocking soft-gate warnings for normalized task artifact drift',
  positional: {
    name: 'taskId',
    description: 'Optional Linear task ID (e.g. HOK-1234) to scope checks',
    required: false,
  },
  options: {
    repo: {
      type: 'string',
      description: 'Repository root directory (default: current working directory)',
    },
    'feature-dir': {
      type: 'string',
      description: 'Direct path to a feature directory',
    },
    slug: {
      type: 'string',
      description: 'Feature slug to resolve',
    },
    all: {
      type: 'boolean',
      description: 'Check every task listed in workflow-state.json',
    },
    json: {
      type: 'boolean',
      description: 'Print machine-readable results',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Evaluate gates without writing the JSONL log or stderr lines',
    },
    'suppress-window': {
      type: 'string',
      description: 'Dedup suppression window in seconds (default: 21600)',
    },
  },
  examples: [
    'npx tsx tools/check-soft-gates.ts HOK-2263',
    'npx tsx tools/check-soft-gates.ts --slug my-feature',
    'npx tsx tools/check-soft-gates.ts --all',
    'npx tsx tools/check-soft-gates.ts --all --dry-run --json',
  ],
  async run({ args, positional }) {
    const repoDir = resolve((args.repo as string | undefined) ?? process.cwd());
    const dryRun = args['dry-run'] === true;
    const asJson = args.json === true;
    const suppressWindowSeconds = parseSuppressWindow(args['suppress-window'] as string | undefined);
    const positionalTaskId = positional[0] as string | undefined;

    const targets = args.all === true
      ? listTargetsFromWorkflowState(repoDir)
      : [{
        taskId: positionalTaskId,
        slug: args.slug as string | undefined,
        featureDir: args['feature-dir'] as string | undefined,
      }];

    const results = await Promise.all(targets.map((target) => runSoftGates({
      repoDir,
      ...target,
      dryRun,
      suppressWindowSeconds,
    })));

    if (asJson) {
      console.log(JSON.stringify({
        repoDir,
        checkedTargets: results.length,
        summary: summarizeResults(results),
        results,
      }, null, 2));
      return;
    }

    printSummary(repoDir, results, dryRun);
  },
});

function parseSuppressWindow(raw: string | undefined): number {
  if (!raw) {
    return 21600;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 21600;
  }
  return Math.floor(parsed);
}

function summarizeResults(results: SoftGateRunResult[]): { checked: number; emitted: number; suppressed: number } {
  return results.reduce(
    (summary, result) => ({
      checked: summary.checked + result.checked,
      emitted: summary.emitted + result.emitted,
      suppressed: summary.suppressed + result.suppressed,
    }),
    { checked: 0, emitted: 0, suppressed: 0 },
  );
}

function printSummary(repoDir: string, results: SoftGateRunResult[], dryRun: boolean): void {
  const summary = summarizeResults(results);
  console.log(`soft gates repo=${repoDir} checked=${summary.checked} emitted=${summary.emitted} suppressed=${summary.suppressed} dryRun=${dryRun}`);
  for (const result of results) {
    const first = result.warnings[0];
    const label = first?.issueId ?? first?.slug ?? 'unresolved';
    console.log(`soft gates target=${label} checked=${result.checked} emitted=${result.emitted} suppressed=${result.suppressed}`);
  }
}
