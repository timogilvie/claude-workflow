import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { SCHEMA_VERSION, type EvalRecord } from './eval-schema.ts';
import { migrateEvalCorpus } from './eval-corpus-migrator.ts';

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const repoDir = mkdtempSync(join(tmpdir(), 'eval-corpus-migrator-'));
  tempDirs.push(repoDir);
  return repoDir;
}

function makeTaskDescriptor(overrides: Partial<NonNullable<EvalRecord['taskDescriptor']>> = {}): NonNullable<EvalRecord['taskDescriptor']> {
  return {
    schema_version: '1.0',
    signals: {
      heuristic: {
        task_type: 'feature',
        languages: ['typescript'],
        framework_tags: [],
        files_touched: 1,
        repo_size_loc: 100,
        description_tokens: 10,
        is_greenfield: false,
        has_migration: false,
        has_ui: false,
        has_tests: true,
        cross_service: false,
      },
      learned: {
        complexity: 3,
        domain: 'backend',
        risk_flags: [],
      },
    },
    constraints: {
      models_available: ['gpt-5.4'],
      objective: 'balanced',
    },
    stages: {},
    ...overrides,
  };
}

function makeRecord(overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    id: `eval-${Math.random().toString(16).slice(2)}`,
    schemaVersion: SCHEMA_VERSION,
    originalPrompt: 'Ship the fix',
    modelId: 'gpt-5.4',
    modelVersion: 'gpt-5.4',
    score: 0.9,
    scoreBand: 'Minor Feedback',
    timeSeconds: 42,
    timestamp: '2026-05-01T12:00:00Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'Judge result is present.',
    taskDescriptor: makeTaskDescriptor(),
    ...overrides,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('eval-corpus-migrator', () => {
  it('fixes deterministic reviewer aliases and quarantines unfixable defects', () => {
    const repoDir = makeTempRepo();
    const evalsFile = join(repoDir, 'evals.jsonl');
    const quarantineFile = join(repoDir, 'quarantine.jsonl');
    writeFileSync(evalsFile, [
      JSON.stringify(makeRecord({ id: 'ok-1' })),
      JSON.stringify(makeRecord({
        id: 'fix-reviewer',
        taskDescriptor: {
          ...makeTaskDescriptor(),
          stages: {
            reviewer: { model: 'deep' },
          },
        },
      })),
      JSON.stringify(makeRecord({ id: 'bad-descriptor', taskDescriptor: undefined })),
      JSON.stringify(makeRecord({
        id: 'bad-models-available',
        taskDescriptor: {
          ...makeTaskDescriptor(),
          constraints: {
            ...makeTaskDescriptor().constraints,
            models_available: [],
          },
        },
      })),
      JSON.stringify(makeRecord({
        id: 'bad-stage-model',
        taskDescriptor: {
          ...makeTaskDescriptor(),
          stages: {
            planner: { model: 'missing-model' },
          },
        },
      })),
    ].join('\n') + '\n', 'utf-8');

    const summary = migrateEvalCorpus({
      evalsFile,
      quarantineFile,
      repoDir,
    });

    assert.equal(summary.inputRecordCount, 5);
    assert.equal(summary.unchanged, 1);
    assert.equal(summary.fixedInPlace, 1);
    assert.equal(summary.quarantined, 3);
    assert.equal(summary.conservationTotal, 5);
    assert.deepEqual(summary.quarantinedByCode, {
      EVAL_EMPTY_MODELS_AVAILABLE: 1,
      EVAL_MISSING_TASK_DESCRIPTOR: 1,
      EVAL_UNKNOWN_STAGE_MODEL: 1,
    });

    const kept = readFileSync(evalsFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(kept.length, 2);
    assert.equal(kept[1].taskDescriptor.stages.reviewer.model, 'claude-fable-5');

    const quarantined = readFileSync(quarantineFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(quarantined.length, 3);
    assert.equal(quarantined[0].quarantine_reason, 'EVAL_MISSING_TASK_DESCRIPTOR:taskDescriptor');
  });

  it('is idempotent on a clean migrated corpus', () => {
    const repoDir = makeTempRepo();
    const evalsFile = join(repoDir, 'evals.jsonl');
    const quarantineFile = join(repoDir, 'quarantine.jsonl');
    writeFileSync(evalsFile, [
      JSON.stringify(makeRecord({ id: 'ok-1' })),
      JSON.stringify(makeRecord({
        id: 'fix-reviewer',
        taskDescriptor: {
          ...makeTaskDescriptor(),
          stages: {
            reviewer: { model: 'deep' },
          },
        },
      })),
    ].join('\n') + '\n', 'utf-8');

    const first = migrateEvalCorpus({ evalsFile, quarantineFile, repoDir });
    assert.equal(first.fixedInPlace, 1);
    assert.equal(first.quarantined, 0);
    assert.ok(existsSync(quarantineFile));

    const second = migrateEvalCorpus({ evalsFile, quarantineFile, repoDir });
    assert.equal(second.fixedInPlace, 0);
    assert.equal(second.quarantined, 0);
    assert.equal(second.unchanged, 2);
  });

  it('supports dry-run without writing files', () => {
    const repoDir = makeTempRepo();
    const evalsFile = join(repoDir, 'evals.jsonl');
    const quarantineFile = join(repoDir, 'quarantine.jsonl');
    const original = JSON.stringify(makeRecord({
      id: 'fix-reviewer',
      taskDescriptor: {
        ...makeTaskDescriptor(),
        stages: {
          reviewer: { model: 'deep' },
        },
      },
    })) + '\n';
    writeFileSync(evalsFile, original, 'utf-8');

    const summary = migrateEvalCorpus({ evalsFile, quarantineFile, repoDir, dryRun: true });
    assert.equal(summary.fixedInPlace, 1);
    assert.equal(readFileSync(evalsFile, 'utf-8'), original);
    assert.equal(existsSync(quarantineFile), false);
  });

  it('clamps negative CI durationSeconds to zero during migration', () => {
    const repoDir = makeTempRepo();
    const evalsFile = join(repoDir, 'evals.jsonl');
    const quarantineFile = join(repoDir, 'quarantine.jsonl');
    writeFileSync(evalsFile, JSON.stringify(makeRecord({
      id: 'negative-ci-duration',
      outcomes: {
        ci: {
          checks: [
            {
              name: 'tests',
              status: 'pending',
              durationSeconds: -5,
            },
          ],
        },
      },
    })) + '\n', 'utf-8');

    const summary = migrateEvalCorpus({ evalsFile, quarantineFile, repoDir });
    assert.equal(summary.fixedInPlace, 1);
    assert.equal(summary.quarantined, 0);

    const migrated = JSON.parse(readFileSync(evalsFile, 'utf-8').trim());
    assert.equal(migrated.outcomes.ci.checks[0].durationSeconds, 0);
  });

  it('fails fast on malformed JSON lines', () => {
    const repoDir = makeTempRepo();
    const evalsFile = join(repoDir, 'evals.jsonl');
    const quarantineFile = join(repoDir, 'quarantine.jsonl');
    writeFileSync(evalsFile, `${JSON.stringify(makeRecord())}\n{"broken":\n`, 'utf-8');

    assert.throws(
      () => migrateEvalCorpus({ evalsFile, quarantineFile, repoDir }),
      /Malformed JSON/,
    );
  });
});
