import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

function makeTempRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'check-soft-gates-tool-'));
  mkdirSync(join(repoDir, 'features'), { recursive: true });
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  return repoDir;
}

describe('check-soft-gates --all', () => {
  const tempDirs: string[] = [];

  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves workflow task worktrees to feature directories', () => {
    const repoDir = makeTempRepo();
    tempDirs.push(repoDir);
    const slug = 'all-mode-feature';
    const featureDir = join(repoDir, 'features', slug);
    mkdirSync(featureDir, { recursive: true });

    writeFileSync(
      join(repoDir, '.wavemill', 'workflow-state.json'),
      JSON.stringify({
        tasks: {
          'HOK-3001': {
            slug,
            worktree: repoDir,
          },
        },
      }),
      'utf-8',
    );
    writeFileSync(
      join(featureDir, 'selected-task.json'),
      JSON.stringify({ taskId: 'HOK-3001', featureName: slug, workflowType: 'feature' }),
      'utf-8',
    );
    writeFileSync(
      join(featureDir, 'feature-state.json'),
      JSON.stringify({
        schemaVersion: '1.0',
        derivedAt: new Date().toISOString(),
        issueId: 'HOK-3001',
        slug,
        branch: null,
        prNumber: null,
        prUrl: null,
        currentPhase: 'coding',
        normalizedState: 'completed',
        contract: null,
        route: null,
        stages: { planning: null, coding: null, review: null, ready: null },
        evidence: [],
        blockers: [],
        failureReason: null,
        artifactSources: {
          stagesFromWorktree: false,
          stagesFromArchive: false,
          routeFromWorktree: false,
          routeFromArchive: false,
          evalRecordUsed: false,
        },
        outcome: {
          completed: true,
          merged: null,
          ciPassed: null,
          reviewPassed: null,
          readyPassed: null,
          manualIntervention: null,
          interventionCount: null,
          reverted: null,
          evalScore: null,
          costUsd: null,
          durationSeconds: null,
        },
      }),
      'utf-8',
    );
    writeFileSync(join(featureDir, '.coding-complete'), '', 'utf-8');

    const stdout = execFileSync(
      'pnpm',
      ['exec', 'tsx', 'tools/check-soft-gates.ts', '--repo', repoDir, '--all', '--dry-run', '--json'],
      { cwd: process.cwd(), encoding: 'utf-8' },
    );
    const result = JSON.parse(stdout) as {
      checkedTargets: number;
      summary: { checked: number };
      results: Array<{ warnings: Array<{ gate: string; issueId: string | null }> }>;
    };

    assert.equal(result.checkedTargets, 1);
    assert.equal(result.summary.checked, 1);
    assert.equal(result.results[0].warnings[0]?.gate, 'completion_without_evidence');
    assert.equal(result.results[0].warnings[0]?.issueId, 'HOK-3001');
  });
});
