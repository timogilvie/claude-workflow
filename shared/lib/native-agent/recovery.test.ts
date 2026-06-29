import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LoopStopReason } from './loop.ts';
import type { TranscriptEvent } from './transcript.ts';
import {
  buildBlockedStageResult,
  buildRecoveryArtifact,
  createStallMonitor,
  deriveTurnObservations,
  detectStall,
  serializeRecoveryArtifact,
  type RuntimeTurnObservation,
  type ToolObservation,
} from './recovery.ts';

function tool(overrides: Partial<ToolObservation> = {}): ToolObservation {
  return {
    tool: 'read_file',
    isError: false,
    mutating: false,
    argsFingerprint: 'fp-default',
    ...overrides,
  };
}

function turn(
  turnIndex: number,
  input: Partial<RuntimeTurnObservation> = {},
): RuntimeTurnObservation {
  return {
    turnIndex,
    toolEvents: input.toolEvents ?? [],
    touchedArtifacts: input.touchedArtifacts ?? [],
  };
}

function stalled(
  turns: readonly RuntimeTurnObservation[],
  stopReason?: LoopStopReason,
) {
  const result = detectStall(turns, { stopReason });
  assert.equal(result.stalled, true);
  return result;
}

describe('recovery', () => {
  it('detects repeated tool failure at threshold and not below it', () => {
    const below = detectStall([
      turn(0, { toolEvents: [tool({ tool: 'git_status', isError: true })] }),
      turn(1, { toolEvents: [tool({ tool: 'git_status', isError: true })] }),
    ]);
    assert.deepEqual(below, { stalled: false });

    const result = stalled([
      turn(0, { toolEvents: [tool({ tool: 'git_status', isError: true })] }),
      turn(1, { toolEvents: [tool({ tool: 'git_status', isError: true })] }),
      turn(2, { toolEvents: [tool({ tool: 'git_status', isError: true })] }),
    ]);

    assert.equal(result.primary.stallType, 'repeated_tool_failure');
    assert.equal(result.primary.count, 3);
  });

  it('detects repeated patch rejection at threshold and not below it', () => {
    const below = detectStall([
      turn(0, { toolEvents: [tool({ tool: 'apply_patch', isError: true, mutating: true, patchRejectionCode: 'anchor_mismatch' })] }),
      turn(1, { toolEvents: [tool({ tool: 'apply_patch', isError: true, mutating: true, patchRejectionCode: 'anchor_mismatch' })] }),
    ]);
    assert.deepEqual(below, { stalled: false });

    const result = stalled([
      turn(0, { toolEvents: [tool({ tool: 'apply_patch', isError: true, mutating: true, patchRejectionCode: 'anchor_mismatch' })] }),
      turn(1, { toolEvents: [tool({ tool: 'apply_patch', isError: true, mutating: true, patchRejectionCode: 'old_text_not_found' })] }),
      turn(2, { toolEvents: [tool({ tool: 'apply_patch', isError: true, mutating: true, patchRejectionCode: 'anchor_mismatch' })] }),
    ]);

    assert.equal(result.primary.stallType, 'repeated_patch_rejection');
    assert.equal(result.primary.count, 3);
    assert.deepEqual(result.primary.involved.sort(), ['anchor_mismatch', 'old_text_not_found']);
  });

  it('detects no touched artifacts at threshold and not below it', () => {
    const below = detectStall([
      turn(0),
      turn(1),
      turn(2),
      turn(3),
    ]);
    assert.deepEqual(below, { stalled: false });

    const result = stalled([
      turn(0),
      turn(1),
      turn(2),
      turn(3),
      turn(4),
    ]);
    assert.equal(result.primary.stallType, 'no_touched_artifacts');
    assert.equal(result.primary.count, 5);
  });

  it('detects no new info at threshold and not below it', () => {
    const sharedRead = tool({ tool: 'read_file', argsFingerprint: 'fp-shared' });
    const below = detectStall([
      turn(0, { toolEvents: [sharedRead] }),
      turn(1, { toolEvents: [sharedRead] }),
      turn(2, { toolEvents: [sharedRead] }),
    ]);
    assert.deepEqual(below, { stalled: false });

    const result = stalled([
      turn(0, { toolEvents: [sharedRead] }),
      turn(1, { toolEvents: [sharedRead] }),
      turn(2, { toolEvents: [sharedRead] }),
      turn(3, { toolEvents: [sharedRead] }),
      turn(4, { toolEvents: [sharedRead] }),
    ]);

    assert.equal(result.primary.stallType, 'no_new_info');
    assert.equal(result.primary.count, 4);
  });

  it('treats missing fingerprints as new information', () => {
    const result = detectStall([
      turn(0, { toolEvents: [tool({ argsFingerprint: 'fp-1' })] }),
      turn(1, { toolEvents: [tool({ argsFingerprint: 'fp-1' })] }),
      turn(2, { toolEvents: [tool({ argsFingerprint: 'fp-1' })] }),
      turn(3, { toolEvents: [tool({ argsFingerprint: undefined })] }),
    ]);

    assert.deepEqual(result, { stalled: false });
  });

  it('detects budget exhaustion', () => {
    const result = stalled([turn(0, { touchedArtifacts: ['src/app.ts'] })], 'token_limit');
    assert.equal(result.primary.stallType, 'budget_exhausted');
    assert.equal(result.primary.involved[0], 'token_limit');
  });

  it('returns not stalled for healthy progression', () => {
    const result = detectStall([
      turn(0, { toolEvents: [tool({ tool: 'read_file', argsFingerprint: 'fp-1' })] }),
      turn(1, { toolEvents: [tool({ tool: 'apply_patch', mutating: true })], touchedArtifacts: ['src/app.ts'] }),
      turn(2, { toolEvents: [tool({ tool: 'read_file', argsFingerprint: 'fp-2' })] }),
      turn(3, { toolEvents: [tool({ tool: 'apply_patch', mutating: true })], touchedArtifacts: ['src/app.ts'] }),
    ]);

    assert.deepEqual(result, { stalled: false });
  });

  it('uses deterministic stall priority when multiple conditions fire', () => {
    const result = stalled([
      turn(0, { toolEvents: [tool({ tool: 'read_file', argsFingerprint: 'fp-1' })] }),
      turn(1, { toolEvents: [tool({ tool: 'apply_patch', isError: true, mutating: true, patchRejectionCode: 'anchor_mismatch' })] }),
      turn(2, { toolEvents: [tool({ tool: 'apply_patch', isError: true, mutating: true, patchRejectionCode: 'anchor_mismatch' })] }),
      turn(3, { toolEvents: [tool({ tool: 'apply_patch', isError: true, mutating: true, patchRejectionCode: 'anchor_mismatch' })] }),
      turn(4, { toolEvents: [tool({ tool: 'apply_patch', isError: true, mutating: true, patchRejectionCode: 'anchor_mismatch' })] }),
    ]);

    assert.equal(result.all.length >= 2, true);
    assert.equal(result.primary.stallType, 'repeated_patch_rejection');
  });

  it('tracks the last useful activity and null when none exists', () => {
    const withProgress = stalled([
      turn(0, { toolEvents: [tool({ tool: 'apply_patch', mutating: true })], touchedArtifacts: ['src/first.ts'] }),
      turn(1),
      turn(2),
      turn(3),
      turn(4),
      turn(5),
    ]);
    assert.deepEqual(withProgress.lastUsefulActivity, {
      turnIndex: 0,
      description: 'touched src/first.ts',
    });

    const withoutProgress = stalled([turn(0), turn(1), turn(2), turn(3), turn(4)]);
    assert.equal(withoutProgress.lastUsefulActivity, null);
  });

  it('builds blocked stage results with diagnostics and hints', () => {
    const detection = stalled([
      turn(0, { toolEvents: [tool({ tool: 'apply_patch', isError: true, mutating: true, patchRejectionCode: 'anchor_mismatch' })] }),
      turn(1, { toolEvents: [tool({ tool: 'apply_patch', isError: true, mutating: true, patchRejectionCode: 'anchor_mismatch' })] }),
      turn(2, { toolEvents: [tool({ tool: 'apply_patch', isError: true, mutating: true, patchRejectionCode: 'anchor_mismatch' })] }),
    ]);

    const blocked = buildBlockedStageResult(detection, { stage: 'coding' });
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.stallType, 'repeated_patch_rejection');
    assert.match(blocked.message, /coding stage blocked/i);
    assert.equal(blocked.diagnostics.length >= 1, true);
    assert.equal(blocked.nextActionHints.length >= 1, true);
  });

  it('builds redacted recovery artifacts with truncated recent turns', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwx123456';
    const detection = stalled([
      turn(0, { touchedArtifacts: [`src/${secret}.ts`] }),
      turn(1),
      turn(2),
      turn(3),
      turn(4),
      turn(5),
    ]);

    const artifact = buildRecoveryArtifact({
      detection,
      turns: [
        turn(0, { touchedArtifacts: [`src/${secret}.ts`] }),
        turn(1),
        turn(2),
        turn(3),
        turn(4),
        turn(5),
      ],
      stage: 'coding',
      stopReason: 'turn_limit',
      recentTurnLimit: 2,
      budget: { turnsCompleted: 6, toolCallsExecuted: 3, totalCostUsd: 1.25 },
    });

    assert.equal(artifact.schemaVersion, 1);
    assert.equal(artifact.recentTurns.length, 2);
    assert.deepEqual(artifact.budget, { turnsCompleted: 6, toolCallsExecuted: 3, totalCostUsd: 1.25 });
    const serialized = serializeRecoveryArtifact(artifact);
    assert.doesNotMatch(serialized, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(serialized, /\[REDACTED:openai_key\]/);
  });

  it('stops incrementally with the stall monitor', () => {
    const monitor = createStallMonitor();
    monitor.recordTurn(turn(0, { toolEvents: [tool({ tool: 'git_status', isError: true })] }));
    assert.equal(monitor.shouldStop(), false);
    monitor.recordTurn(turn(1, { toolEvents: [tool({ tool: 'git_status', isError: true })] }));
    assert.equal(monitor.shouldStop(), false);
    monitor.recordTurn(turn(2, { toolEvents: [tool({ tool: 'git_status', isError: true })] }));
    assert.equal(monitor.shouldStop(), true);
  });

  it('derives turn observations from transcript events', () => {
    const events: TranscriptEvent[] = [
      {
        type: 'turn_started',
        seq: 1,
        sessionId: 'session',
        timestamp: 1,
        turnIndex: 0,
      },
      {
        type: 'tool_result',
        seq: 2,
        sessionId: 'session',
        timestamp: 2,
        toolCallId: 'call-1',
        toolName: 'apply_patch',
        isError: true,
        content: 'patch rejected',
        redacted: false,
        details: {
          error: 'patch_rejected',
          diagnostics: { code: 'anchor_mismatch' },
          changedFiles: ['src/app.ts'],
        },
        metadata: {
          provenance: { tool: 'apply_patch', argsFingerprint: 'fp-apply' },
        },
      },
      {
        type: 'turn_ended',
        seq: 3,
        sessionId: 'session',
        timestamp: 3,
        turnIndex: 0,
        stopReason: 'tool_result',
        toolResultCount: 1,
      },
      {
        type: 'turn_started',
        seq: 4,
        sessionId: 'session',
        timestamp: 4,
        turnIndex: 1,
      },
      {
        type: 'tool_result',
        seq: 5,
        sessionId: 'session',
        timestamp: 5,
        toolCallId: 'call-2',
        toolName: 'read_file',
        isError: false,
        content: 'ok',
        redacted: false,
        details: { note: 'read only' },
        metadata: {
          provenance: { tool: 'read_file', argsFingerprint: 'fp-read' },
        },
      },
      {
        type: 'turn_ended',
        seq: 6,
        sessionId: 'session',
        timestamp: 6,
        turnIndex: 1,
        stopReason: 'stop',
        toolResultCount: 1,
      },
    ];

    const result = deriveTurnObservations(events);
    assert.deepEqual(result, [
      {
        turnIndex: 0,
        toolEvents: [
          {
            tool: 'apply_patch',
            isError: true,
            argsFingerprint: 'fp-apply',
            mutating: true,
            patchRejectionCode: 'anchor_mismatch',
          },
        ],
        touchedArtifacts: ['src/app.ts'],
      },
      {
        turnIndex: 1,
        toolEvents: [
          {
            tool: 'read_file',
            isError: false,
            argsFingerprint: 'fp-read',
            mutating: false,
          },
        ],
        touchedArtifacts: [],
      },
    ]);
  });
});
