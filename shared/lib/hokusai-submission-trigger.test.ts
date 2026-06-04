import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it, mock } from 'node:test';
import { clearConfigCache } from './config.ts';
import { saveUserConfig } from './hokusai-consent.ts';
import type { EvalRecord, RoutingDecision } from './eval-schema.ts';
import { hokusaiSubmissionTriggerDeps, triggerHokusaiSubmission } from './hokusai-submission-trigger.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeRepoConfig(repoDir: string, enabled: boolean): void {
  writeFileSync(join(repoDir, '.wavemill-config.json'), `${JSON.stringify({
    hokusai: {
      dataSubmission: {
        enabled,
        consentVersion: '1.0',
      },
      contributions: {
        enabled: true,
        endpoint: 'https://example.com/contributions',
        batchSize: 10,
      },
    },
  }, null, 2)}\n`);
}

function makeRepo(enabled = true): { repoDir: string; configDir: string } {
  const repoDir = makeTempDir('hokusai-submission-repo-');
  const configDir = makeTempDir('hokusai-submission-config-');
  writeRepoConfig(repoDir, enabled);
  saveUserConfig({
    hokusai: {
      enabled: true,
      consentedAt: '2026-05-31T12:00:00.000Z',
      consentVersion: '1.0',
    },
  }, configDir);
  return { repoDir, configDir };
}

function makeRoutingDecision(): RoutingDecision {
  return {
    candidates: [{ agentType: 'codex', modelId: 'gpt-5.4' }],
    chosen: { agentType: 'codex', modelId: 'gpt-5.4' },
    decisionPolicyVersion: 'baseline',
    decisionRationale: 'Use the implementation model.',
  };
}

function makeEligibleRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id: 'eval-123',
    issueId: 'HOK-1243',
    schemaVersion: '1.27.0',
    originalPrompt: 'Trigger Hokusai after eval completion',
    modelId: 'gpt-5.4',
    modelVersion: 'gpt-5.4',
    score: 0.9,
    scoreBand: 'Minor Feedback',
    timeSeconds: 42,
    timestamp: '2026-06-01T12:00:00.000Z',
    interventionRequired: false,
    interventionCount: 1,
    interventionDetails: ['Clarified one edge case'],
    rationale: 'Looks good.',
    workflowCost: 3.5,
    outcomes: {
      success: true,
    },
    routingDecision: makeRoutingDecision(),
    constraints: {
      maxCostUsd: 5,
    },
    ...overrides,
  };
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  clearConfigCache();
  mock.restoreAll();
});

describe('hokusai-submission-trigger', () => {
  it('skips queueing silently when data submission is disabled', async () => {
    const { repoDir, configDir } = makeRepo(false);
    const warn = mock.method(console, 'warn', () => undefined);

    await triggerHokusaiSubmission(makeEligibleRecord(), {
      repoDir,
      configDir,
      redactionSalt: 'a'.repeat(64),
    });

    assert.equal(existsSync(join(repoDir, '.wavemill', 'hokusai')), false);
    assert.equal(warn.mock.calls.length, 0);
  });

  it('redacts and enqueues an eligible record when submission is enabled', async () => {
    const { repoDir, configDir } = makeRepo(true);

    await triggerHokusaiSubmission(makeEligibleRecord(), {
      repoDir,
      configDir,
      redactionSalt: 'b'.repeat(64),
    });

    const pendingPath = join(repoDir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl');
    const lines = readFileSync(pendingPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 1);

    const entry = JSON.parse(lines[0]) as {
      row: {
        task_id?: string;
        harness?: string;
        success_under_budget?: boolean;
        actual_cost_usd?: number;
        wall_clock_seconds?: number;
        inputs?: Record<string, unknown>;
      };
    };

    assert.match(entry.row.task_id ?? '', /^redacted-[a-f0-9]{16}$/);
    assert.notEqual(entry.row.task_id, 'HOK-1243');
    assert.equal(entry.row.harness, 'wavemill');
    assert.equal(entry.row.success_under_budget, true);
    assert.equal(entry.row.actual_cost_usd, 3.5);
    assert.equal(entry.row.wall_clock_seconds, 42);
    assert.equal(entry.row.inputs?.planner_model, 'gpt-5.4');
    assert.equal(entry.row.inputs?.coder_model, 'gpt-5.4');
    assert.equal(entry.row.inputs?.reviewer_model, 'gpt-5.4');
    assert.equal(entry.row.inputs?.rubric_version, undefined);
    assert.equal(readFileSync(pendingPath, 'utf-8').includes('HOK-1243'), false);
  });

  it('enqueues missing cost as null without counting it under budget', async () => {
    const { repoDir, configDir } = makeRepo(true);

    await triggerHokusaiSubmission(makeEligibleRecord({ workflowCost: undefined }), {
      repoDir,
      configDir,
      redactionSalt: 'c'.repeat(64),
    });

    const pendingPath = join(repoDir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl');
    const [line] = readFileSync(pendingPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(line) as {
      row: {
        actual_cost_usd?: number | null;
        success_under_budget?: boolean;
      };
    };

    assert.equal(entry.row.actual_cost_usd, null);
    assert.equal(entry.row.success_under_budget, false);
  });

  it('warns and swallows redaction failures', async () => {
    const { repoDir, configDir } = makeRepo(true);
    const warn = mock.method(console, 'warn', () => undefined);
    mock.method(hokusaiSubmissionTriggerDeps, 'redactHokusaiSubmission', () => {
      throw new Error('redaction failed');
    });

    await triggerHokusaiSubmission(makeEligibleRecord(), {
      repoDir,
      configDir,
      redactionSalt: 'd'.repeat(64),
    });

    assert.equal(warn.mock.calls.length, 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /\[hokusai\] submission trigger failed: redaction failed/);
    assert.equal(existsSync(join(repoDir, '.wavemill', 'hokusai')), false);
  });

  it('warns and swallows enqueue failures', async () => {
    const { repoDir, configDir } = makeRepo(true);
    const warn = mock.method(console, 'warn', () => undefined);
    mock.method(hokusaiSubmissionTriggerDeps, 'enqueueContribution', async () => {
      throw new Error('queue unavailable');
    });

    await triggerHokusaiSubmission(makeEligibleRecord(), {
      repoDir,
      configDir,
      redactionSalt: 'e'.repeat(64),
    });

    assert.equal(warn.mock.calls.length, 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /\[hokusai\] submission trigger failed: queue unavailable/);
  });

  it('warns asynchronously when opportunistic drain rejects', async () => {
    const { repoDir, configDir } = makeRepo(true);
    const warn = mock.method(console, 'warn', () => undefined);
    mock.method(hokusaiSubmissionTriggerDeps, 'drainContributionQueue', async () => {
      throw new Error('drain failed');
    });

    await triggerHokusaiSubmission(makeEligibleRecord(), {
      repoDir,
      configDir,
      redactionSalt: 'f'.repeat(64),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(warn.mock.calls.length, 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /\[hokusai\] opportunistic drain failed: drain failed/);
    assert.equal(existsSync(join(repoDir, '.wavemill', 'hokusai', 'queue', 'pending.jsonl')), true);
  });

  it('does not await the opportunistic drain', async () => {
    const { repoDir, configDir } = makeRepo(true);
    let resolveDrain: (() => void) | undefined;

    mock.method(hokusaiSubmissionTriggerDeps, 'drainContributionQueue', () => new Promise((resolve) => {
      resolveDrain = resolve;
    }));

    const result = await Promise.race([
      triggerHokusaiSubmission(makeEligibleRecord(), {
        repoDir,
        configDir,
        redactionSalt: '0'.repeat(64),
      }).then(() => 'resolved'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 25)),
    ]);

    assert.equal(result, 'resolved');
    resolveDrain?.();
  });
});
