import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createDeniedMutationRecord,
  createExecutedMutationRecord,
  createFailedMutationRecord,
  recordMutationOutcome,
} from './mutation-record.ts';

const context = {
  tool: 'github_create_pr' as const,
  phase: 'review' as const,
  action: 'create_pr' as const,
  target: { repo: 'owner/repo', pullRequest: 42 },
};

describe('workflow-tools: mutation record', () => {
  it('creates executed records with result payloads', () => {
    const record = createExecutedMutationRecord(context, { ok: true, idempotencyKey: 'github_create_pr:test' });

    assert.deepEqual(record, {
      ...context,
      outcome: 'executed',
      result: { ok: true, idempotencyKey: 'github_create_pr:test' },
    });
  });

  it('creates denied records with transcript-safe denial details', () => {
    const record = createDeniedMutationRecord(context, {
      code: 'ready_mutation_denied',
      reason: 'ready_mutation_denied: general PR creation not allowed in ready phase',
    });

    assert.deepEqual(record, {
      ...context,
      outcome: 'denied',
      code: 'ready_mutation_denied',
      reason: 'ready_mutation_denied: general PR creation not allowed in ready phase',
    });
  });

  it('creates failed records with sanitized error summaries', () => {
    const record = createFailedMutationRecord(context, new Error('boom'));

    assert.deepEqual(record, {
      ...context,
      outcome: 'failed',
      code: 'external_error',
      reason: 'github_create_pr failed: boom',
      error: {
        name: 'Error',
        message: 'boom',
      },
    });
  });

  it('warns and continues when the record sink fails', async () => {
    const warnings: string[] = [];

    await recordMutationOutcome(
      createDeniedMutationRecord(context, {
        code: 'ready_mutation_denied',
        reason: 'ready_mutation_denied: denied for test',
      }),
      {
        sink: async () => {
          throw new Error('sink failed');
        },
        warn: (message, error) => {
          warnings.push(`${message} :: ${String(error)}`);
        },
      },
    );

    assert.deepEqual(warnings, [
      '[workflow-tools] Failed to record mutation outcome for github_create_pr/denied :: Error: sink failed',
    ]);
  });
});
