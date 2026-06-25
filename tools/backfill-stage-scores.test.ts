import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveProviderForModel, type LLMCallOptions, type LLMCallResult } from '../shared/lib/llm-cli.ts';
import { applyJudgeResponse, processBackfillRecord, type EvalRecord, type ProcessRecordDeps } from './backfill-stage-scores.ts';

describe('backfill-stage-scores provider routing', () => {
  it('routes gpt-5.5 (default model) to codex provider', () => {
    const provider = resolveProviderForModel('gpt-5.5');
    assert.equal(provider, 'codex');
  });

  it('routes claude-sonnet-4-6 to claude provider', () => {
    const provider = resolveProviderForModel('claude-sonnet-4-6');
    assert.equal(provider, 'claude');
  });

  it('routes claude-opus-4-8 to claude provider', () => {
    const provider = resolveProviderForModel('claude-opus-4-8');
    assert.equal(provider, 'claude');
  });

  it('routes gpt-4 to codex provider', () => {
    const provider = resolveProviderForModel('gpt-4');
    assert.equal(provider, 'codex');
  });

  it('routes o1-preview to codex provider', () => {
    const provider = resolveProviderForModel('o1-preview');
    assert.equal(provider, 'codex');
  });

  it('defaults to claude provider when model is undefined', () => {
    const provider = resolveProviderForModel(undefined);
    assert.equal(provider, 'claude');
  });

  it('handles claude-haiku correctly', () => {
    const provider = resolveProviderForModel('claude-haiku-4-5-20251001');
    assert.equal(provider, 'claude');
  });
});

describe('backfill-stage-scores record processing', () => {
  it('parses result.text and merges missing stage scores without overwriting existing scores', async () => {
    const record: EvalRecord = {
      id: 'eval-1',
      score: 4,
      scoreBand: 'good',
      originalPrompt: 'Build the thing',
      metadata: {
        stageScores: {
          implementation: { score: 5, rationale: 'existing implementation score' },
        },
      },
    };
    let capturedOptions: LLMCallOptions | undefined;
    const deps: ProcessRecordDeps = {
      resolveProviderForModel: () => 'codex',
      now: () => '2026-06-25T12:00:00.000Z',
      cwd: () => '/repo',
      callLLM: async (_prompt: string, options: LLMCallOptions): Promise<LLMCallResult> => {
        capturedOptions = options;
        return {
          text: JSON.stringify({
            score: 4,
            rationale: 'ok',
            interventionFlags: [],
            stageScores: {
              plan: { score: 3, rationale: 'new plan score' },
              review: { score: 4, rationale: 'new review score' },
              implementation: { score: 1, rationale: 'should not overwrite' },
            },
          }),
          rawOutput: 'ignored raw output',
          provider: 'codex',
          model: 'gpt-5.5',
        };
      },
    };

    const result = await processBackfillRecord(record, '{{TASK_PROMPT}}', 'gpt-5.5', deps);

    assert.equal(result.ok, true);
    assert.match(result.message, /OK \(stages: implementation, plan, review\)/);
    assert.equal(capturedOptions?.provider, 'codex');
    assert.equal(capturedOptions?.model, 'gpt-5.5');
    assert.equal(record.metadata?.backfilledAt, '2026-06-25T12:00:00.000Z');
    assert.deepEqual(record.metadata?.stageScores?.implementation, {
      score: 5,
      rationale: 'existing implementation score',
    });
    assert.deepEqual(record.metadata?.stageScores?.plan, {
      score: 3,
      rationale: 'new plan score',
    });
    assert.deepEqual(record.metadata?.stageScores?.review, {
      score: 4,
      rationale: 'new review score',
    });
  });

  it('leaves records unchanged when callLLM throws', async () => {
    const record: EvalRecord = {
      id: 'eval-2',
      score: 2,
      scoreBand: 'poor',
      originalPrompt: 'Build another thing',
      metadata: {
        stageScores: {
          expansion: { score: 2, rationale: 'existing expansion score' },
        },
      },
    };
    const before = JSON.stringify(record);
    const deps: ProcessRecordDeps = {
      resolveProviderForModel: () => 'codex',
      now: () => '2026-06-25T12:00:00.000Z',
      cwd: () => '/repo',
      callLLM: async () => {
        throw new Error('temporary model failure');
      },
    };

    const result = await processBackfillRecord(record, '{{TASK_PROMPT}}', 'gpt-5.5', deps);

    assert.equal(result.ok, false);
    assert.equal(result.message, 'ERROR: temporary model failure');
    assert.equal(JSON.stringify(record), before);
  });

  it('returns false for unparsable judge text without mutating the record', () => {
    const record: EvalRecord = {
      id: 'eval-3',
      score: 3,
      scoreBand: 'ok',
      originalPrompt: 'Build a third thing',
    };

    assert.equal(applyJudgeResponse(record, 'not json'), false);
    assert.deepEqual(record, {
      id: 'eval-3',
      score: 3,
      scoreBand: 'ok',
      originalPrompt: 'Build a third thing',
    });
  });
});
