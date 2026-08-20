import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { backfillChallengeStageFile } from './backfill-challenge-stage.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'challenge-stage-backfill-'));
  tempDirs.push(dir);
  return dir;
}

function writeJsonl(file: string, records: unknown[]): void {
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf-8');
}

function readJsonl(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function evalFileWith(records: unknown[], challengeRecords: unknown[] = []): string {
  const dir = makeDir();
  const evals = join(dir, 'evals.jsonl');
  writeJsonl(evals, records);
  if (challengeRecords.length > 0) {
    writeJsonl(join(dir, 'challenge-records.jsonl'), challengeRecords);
  }
  return evals;
}

describe('backfillChallengeStageFile', () => {
  it('recovers challengeStage from the record challengeIntent', () => {
    const file = evalFileWith([
      {
        id: 'intent-record',
        challengePairId: 'pair-intent',
        challengeIntent: { selectedStage: 'plan' },
      },
    ]);

    const summary = backfillChallengeStageFile(file);
    const [record] = readJsonl(file);

    assert.equal(summary.recovered_from_intent, 1);
    assert.equal(record.challengeStage, 'plan');
  });

  it('recovers challengeStage from challenge-records variedStage', () => {
    const file = evalFileWith(
      [{ id: 'varied-stage-record', challengePairId: 'pair-varied-stage' }],
      [{ challengePairId: 'pair-varied-stage', variedStage: 'review' }],
    );

    const summary = backfillChallengeStageFile(file);
    const [record] = readJsonl(file);

    assert.equal(summary.recovered_from_pair_records, 1);
    assert.equal(record.challengeStage, 'review');
  });

  it('recovers challengeStage from challengeType when it uniquely maps to a stage', () => {
    const file = evalFileWith(
      [{ id: 'type-record', challengePairId: 'pair-type' }],
      [{ challengePairId: 'pair-type', challengeType: 'coder-only' }],
    );

    const summary = backfillChallengeStageFile(file);
    const [record] = readJsonl(file);

    assert.equal(summary.recovered_from_pair_records, 1);
    assert.equal(record.challengeStage, 'implementation');
  });

  it('marks multi-variable challengeType as unrecoverable without defaulting', () => {
    const file = evalFileWith(
      [{ id: 'multi-record', challengePairId: 'pair-multi' }],
      [{ challengePairId: 'pair-multi', challengeType: 'multi-variable' }],
    );

    const summary = backfillChallengeStageFile(file);
    const [record] = readJsonl(file);

    assert.equal(summary.unrecoverable, 1);
    assert.equal(record.challengeStage, 'unrecoverable');
    assert.deepEqual(record.eligibilityErrors, ['missing_challenge_stage']);
  });

  it('marks pair-record stage disagreements as unrecoverable', () => {
    const file = evalFileWith(
      [{ id: 'disagreement-record', challengePairId: 'pair-disagreement' }],
      [
        { challengePairId: 'pair-disagreement', variedStage: 'plan' },
        { challengePairId: 'pair-disagreement', variedStage: 'review' },
      ],
    );

    const summary = backfillChallengeStageFile(file);
    const [record] = readJsonl(file);

    assert.equal(summary.disagreements, 1);
    assert.deepEqual(summary.disagreementPairIds, ['pair-disagreement']);
    assert.equal(summary.unrecoverable, 1);
    assert.equal(record.challengeStage, 'unrecoverable');
    assert.deepEqual(record.eligibilityErrors, ['missing_challenge_stage']);
  });

  it('is idempotent after a record is backfilled', () => {
    const file = evalFileWith(
      [{ id: 'idempotent-record', challengePairId: 'pair-idempotent' }],
      [{ challengePairId: 'pair-idempotent', variedStage: 'plan' }],
    );

    const first = backfillChallengeStageFile(file);
    const second = backfillChallengeStageFile(file);
    const [record] = readJsonl(file);

    assert.equal(first.changed, 1);
    assert.equal(second.changed, 0);
    assert.equal(second.already_had_stage, 1);
    assert.equal(record.challengeStage, 'plan');
  });
});
