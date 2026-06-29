import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_RECOVERY_THRESHOLDS,
  RECOVERY_ARTIFACT_SCHEMA_VERSION,
  analyzeRecovery,
  buildBlockedStageResult,
  buildRecoveryArtifact,
  detectStall,
  getRecoveryArtifactPath,
  writeRecoveryArtifact,
  type RecoveryInput,
  type TurnObservation,
} from './recovery.ts';

const CREATED_AT = '2026-06-29T12:34:56.789Z';

function observation(
  turnIndex: number,
  overrides: Partial<TurnObservation> = {},
): TurnObservation {
  return {
    turnIndex,
    readOnly: false,
    touchedArtifact: false,
    producedNewInformation: false,
    toolFailures: [],
    patchRejections: [],
    ...overrides,
  };
}

function input(overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  return {
    phase: 'coding',
    observations: [],
    stopReason: 'stop',
    ...overrides,
  };
}

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'native-agent-recovery-'));
}

function cleanupRepo(repoDir: string): void {
  rmSync(repoDir, { recursive: true, force: true });
}

describe('recovery stall detection', () => {
  it('detects budget exhaustion even without observations', () => {
    const detection = detectStall(input({ stopReason: 'token_limit' }));
    assert.equal(detection.stalled, true);
    if (detection.stalled) {
      assert.equal(detection.stallType, 'budget_exhaustion');
      assert.deepEqual(detection.lastUsefulActivity, null);
      assert.equal(detection.evidence.detail?.stopReason, 'token_limit');
    }
  });

  it('does not classify non-budget stop reasons as stalled', () => {
    const detection = detectStall(input({ stopReason: 'error' }));
    assert.deepEqual(detection, { stalled: false, lastUsefulActivity: null });
  });

  it('treats aborted/error exits as non-stalls even when non-progress signals fire', () => {
    const observations = [
      observation(1, { readOnly: true, touchedArtifact: true }),
      observation(2, { readOnly: true }),
      observation(3, { readOnly: true }),
      observation(4, { readOnly: true }),
      observation(5, { readOnly: true }),
      observation(6, { readOnly: true }),
    ];

    for (const stopReason of ['aborted', 'error'] as const) {
      const detection = detectStall(input({ stopReason, observations }));
      assert.equal(detection.stalled, false, `${stopReason} should not stall`);
      assert.deepEqual(
        detection.lastUsefulActivity,
        { turnIndex: 1, kind: 'touched_artifact' },
        `${stopReason} should still surface last useful activity`,
      );
    }
  });

  it('detects repeated tool failure at the threshold', () => {
    const detection = detectStall(input({
      observations: [
        observation(1, { toolFailures: [{ tool: 'read_file', signature: 'abc123' }] }),
        observation(2, { toolFailures: [{ tool: 'read_file', signature: 'abc123' }] }),
        observation(3, { toolFailures: [{ tool: 'read_file', signature: 'abc123' }] }),
      ],
    }));

    assert.equal(detection.stalled, true);
    if (detection.stalled) {
      assert.equal(detection.stallType, 'repeated_tool_failure');
      assert.deepEqual(detection.evidence.turnIndices, [1, 2, 3]);
      assert.deepEqual(detection.evidence.detail, { tool: 'read_file', signature: 'abc123' });
    }
  });

  it('does not detect repeated tool failure below the threshold', () => {
    const detection = detectStall(input({
      observations: [
        observation(1, { toolFailures: [{ tool: 'read_file', signature: 'abc123' }] }),
        observation(2, { toolFailures: [{ tool: 'read_file', signature: 'abc123' }] }),
      ],
    }));

    assert.deepEqual(detection, { stalled: false, lastUsefulActivity: null });
  });

  it('resets the repeated tool failure streak when an intervening turn succeeds', () => {
    const detection = detectStall(input({
      observations: [
        observation(1, { toolFailures: [{ tool: 'read_file', signature: 'abc123' }] }),
        observation(2, { toolFailures: [{ tool: 'read_file', signature: 'abc123' }] }),
        observation(3, { touchedArtifact: true }),
        observation(4, { toolFailures: [{ tool: 'read_file', signature: 'abc123' }] }),
        observation(5, { toolFailures: [{ tool: 'read_file', signature: 'abc123' }] }),
      ],
    }));

    assert.equal(detection.stalled, false);
    assert.deepEqual(detection.lastUsefulActivity, {
      turnIndex: 3,
      kind: 'touched_artifact',
    });
  });

  it('throws when a recovery threshold is not a positive integer', () => {
    for (const value of [0, -1, 1.5, Number.NaN] as const) {
      assert.throws(
        () => detectStall(input({ thresholds: { maxRepeatedToolFailures: value } })),
        RangeError,
        `expected RangeError for threshold value ${String(value)}`,
      );
    }
  });

  it('detects repeated patch rejection at the threshold', () => {
    const detection = detectStall(input({
      observations: [
        observation(1, { patchRejections: [{ code: 'context_mismatch', target: 'src/app.ts' }] }),
        observation(2, { patchRejections: [{ code: 'context_mismatch', target: 'src/app.ts' }] }),
        observation(3, { patchRejections: [{ code: 'context_mismatch', target: 'src/app.ts' }] }),
      ],
    }));

    assert.equal(detection.stalled, true);
    if (detection.stalled) {
      assert.equal(detection.stallType, 'repeated_patch_rejection');
      assert.deepEqual(detection.evidence.turnIndices, [1, 2, 3]);
      assert.deepEqual(detection.evidence.detail, {
        code: 'context_mismatch',
        target: 'src/app.ts',
      });
    }
  });

  it('does not detect repeated patch rejection below the threshold', () => {
    const detection = detectStall(input({
      observations: [
        observation(1, { patchRejections: [{ code: 'context_mismatch', target: 'src/app.ts' }] }),
        observation(2, { patchRejections: [{ code: 'context_mismatch', target: 'src/app.ts' }] }),
      ],
    }));

    assert.deepEqual(detection, { stalled: false, lastUsefulActivity: null });
  });

  it('detects a run with no touched artifacts at the threshold', () => {
    const threshold = DEFAULT_RECOVERY_THRESHOLDS.maxTurnsWithoutTouchedArtifact;
    const detection = detectStall(input({
      observations: Array.from({ length: threshold }, (_, index) => observation(index + 1)),
    }));

    assert.equal(detection.stalled, true);
    if (detection.stalled) {
      assert.equal(detection.stallType, 'no_touched_artifacts');
      assert.deepEqual(
        detection.evidence.turnIndices,
        Array.from({ length: threshold }, (_, index) => index + 1),
      );
    }
  });

  it('does not detect no touched artifacts below the threshold', () => {
    const threshold = DEFAULT_RECOVERY_THRESHOLDS.maxTurnsWithoutTouchedArtifact - 1;
    const detection = detectStall(input({
      observations: Array.from({ length: threshold }, (_, index) => observation(index + 1)),
    }));

    assert.deepEqual(detection, { stalled: false, lastUsefulActivity: null });
  });

  it('detects read-only turns with no new information at the threshold', () => {
    const threshold = DEFAULT_RECOVERY_THRESHOLDS.maxReadOnlyTurnsWithoutNewInfo;
    const detection = detectStall(input({
      observations: Array.from(
        { length: threshold },
        (_, index) => observation(index + 1, { readOnly: true }),
      ),
      thresholds: { maxTurnsWithoutTouchedArtifact: threshold + 1 },
    }));

    assert.equal(detection.stalled, true);
    if (detection.stalled) {
      assert.equal(detection.stallType, 'no_new_information');
      assert.deepEqual(
        detection.evidence.turnIndices,
        Array.from({ length: threshold }, (_, index) => index + 1),
      );
    }
  });

  it('does not detect no new information below the threshold', () => {
    const threshold = DEFAULT_RECOVERY_THRESHOLDS.maxReadOnlyTurnsWithoutNewInfo - 1;
    const detection = detectStall(input({
      observations: Array.from(
        { length: threshold },
        (_, index) => observation(index + 1, { readOnly: true }),
      ),
      thresholds: { maxTurnsWithoutTouchedArtifact: threshold + 2 },
    }));

    assert.deepEqual(detection, { stalled: false, lastUsefulActivity: null });
  });

  it('prefers budget exhaustion over other simultaneous stall conditions', () => {
    const detection = detectStall(input({
      stopReason: 'cost_limit',
      observations: [
        observation(1, { toolFailures: [{ tool: 'grep', signature: 'dup' }] }),
        observation(2, { toolFailures: [{ tool: 'grep', signature: 'dup' }] }),
        observation(3, { toolFailures: [{ tool: 'grep', signature: 'dup' }] }),
      ],
    }));

    assert.equal(detection.stalled, true);
    if (detection.stalled) {
      assert.equal(detection.stallType, 'budget_exhaustion');
    }
  });

  it('tracks the most recent useful activity', () => {
    const detection = detectStall(input({
      observations: [
        observation(1, { producedNewInformation: true }),
        observation(2),
        observation(3, { touchedArtifact: true }),
        observation(4),
        observation(5),
      ],
      thresholds: { maxTurnsWithoutTouchedArtifact: 2 },
    }));

    assert.equal(detection.stalled, true);
    assert.deepEqual(detection.lastUsefulActivity, {
      turnIndex: 3,
      kind: 'touched_artifact',
    });
  });

  it('attaches cleanup reports to recovery artifacts when provided', () => {
    const result = analyzeRecovery(input({
      stopReason: 'token_limit',
      observations: [observation(1)],
    }), {
      createdAt: CREATED_AT,
      cleanupReport: {
        reason: 'timeout',
        terminatedCommands: [],
        partialMutations: [],
        finalTreeState: 'dirty-unrecoverable',
        cleanupDecision: 'left-in-place',
        runTouchedPaths: ['src.ts'],
        rollbackResults: [],
        notes: ['left in place'],
      },
    });

    assert.equal(result.artifact?.schemaVersion, RECOVERY_ARTIFACT_SCHEMA_VERSION);
    assert.equal(result.artifact?.cleanupReport?.cleanupDecision, 'left-in-place');
    assert.equal(result.artifact?.cleanupReport?.finalTreeState, 'dirty-unrecoverable');
  });
});

describe('recovery stage results and artifacts', () => {
  it('builds a blocked stage result with diagnostics and next actions', () => {
    const detection = detectStall(input({
      observations: [
        observation(1, { toolFailures: [{ tool: 'read_file', signature: 'abc123' }] }),
        observation(2, { toolFailures: [{ tool: 'read_file', signature: 'abc123' }] }),
        observation(3, { toolFailures: [{ tool: 'read_file', signature: 'abc123' }] }),
      ],
    }));

    const stageResult = buildBlockedStageResult(detection);
    assert.equal(stageResult.status, 'blocked');
    if (stageResult.status === 'blocked') {
      assert.equal(stageResult.stallType, 'repeated_tool_failure');
      assert.equal(stageResult.diagnostics.length > 0, true);
      assert.equal(stageResult.nextActions.length > 0, true);
    }
  });

  it('redacts secrets from recovery artifacts', () => {
    const recoveryInput = input({
      observations: [
        observation(1, {
          toolFailures: [{ tool: 'search', signature: 'sk-ABCDEFGHIJKLMNOPQRSTUVWX' }],
        }),
        observation(2, {
          toolFailures: [{ tool: 'search', signature: 'sk-ABCDEFGHIJKLMNOPQRSTUVWX' }],
        }),
        observation(3, {
          toolFailures: [{ tool: 'search', signature: 'sk-ABCDEFGHIJKLMNOPQRSTUVWX' }],
        }),
      ],
    });
    const detection = detectStall(recoveryInput);
    assert.equal(detection.stalled, true);
    if (!detection.stalled) {
      return;
    }

    const artifact = buildRecoveryArtifact(recoveryInput, detection, CREATED_AT);
    const artifactJson = JSON.stringify(artifact);

    assert.equal(artifact.schemaVersion, RECOVERY_ARTIFACT_SCHEMA_VERSION);
    assert.equal(artifact.redactionApplied, true);
    assert.equal(artifactJson.includes('sk-ABCDEFGHIJKLMNOPQRSTUVWX'), false);
  });

  it('includes turn summaries and loop stats in artifacts', () => {
    const recoveryInput = input({
      observations: [
        observation(1, { readOnly: true, producedNewInformation: true }),
        observation(2, { readOnly: true }),
        observation(3, { readOnly: true }),
        observation(4, { readOnly: true }),
        observation(5, { readOnly: true }),
        observation(6, { readOnly: true }),
      ],
      thresholds: { maxTurnsWithoutTouchedArtifact: 10 },
      loopResult: {
        turnsCompleted: 6,
        toolCallsExecuted: 7,
        totalCostUsd: 1.25,
        wallClockMs: 8000,
      },
    });
    const detection = detectStall(recoveryInput);
    assert.equal(detection.stalled, true);
    if (!detection.stalled) {
      return;
    }

    const artifact = buildRecoveryArtifact(recoveryInput, detection, CREATED_AT);
    assert.deepEqual(artifact.turnSummary, {
      totalTurns: 6,
      readOnlyTurns: 6,
      turnsSinceUseful: 5,
    });
    assert.deepEqual(artifact.loopStats, recoveryInput.loopResult);
  });

  it('analyzes recovery and emits an artifact when stalled and timestamped', () => {
    const result = analyzeRecovery(input({
      observations: [
        observation(1, { patchRejections: [{ code: 'context_mismatch', target: 'src/app.ts' }] }),
        observation(2, { patchRejections: [{ code: 'context_mismatch', target: 'src/app.ts' }] }),
        observation(3, { patchRejections: [{ code: 'context_mismatch', target: 'src/app.ts' }] }),
      ],
    }), { createdAt: CREATED_AT });

    assert.equal(result.detection.stalled, true);
    assert.equal(result.stageResult.status, 'blocked');
    assert.equal(result.artifact?.createdAt, CREATED_AT);
  });

  it('writes recovery artifacts to the expected path atomically', () => {
    const repoDir = makeTempRepo();
    try {
      const recoveryInput = input({
        observations: [
          observation(1, { toolFailures: [{ tool: 'read_file', signature: 'abc123' }] }),
          observation(2, { toolFailures: [{ tool: 'read_file', signature: 'abc123' }] }),
          observation(3, { toolFailures: [{ tool: 'read_file', signature: 'abc123' }] }),
        ],
      });
      const detection = detectStall(recoveryInput);
      assert.equal(detection.stalled, true);
      if (!detection.stalled) {
        return;
      }

      const artifact = buildRecoveryArtifact(recoveryInput, detection, CREATED_AT);
      const outputPath = writeRecoveryArtifact(repoDir, artifact);

      assert.equal(outputPath, getRecoveryArtifactPath(repoDir, artifact));
      assert.deepEqual(JSON.parse(readFileSync(outputPath, 'utf-8')), artifact);
      assert.deepEqual(
        readdirSync(join(repoDir, '.wavemill/native-agent/recovery')).filter((entry) => entry.includes('.tmp')),
        [],
      );
    } finally {
      cleanupRepo(repoDir);
    }
  });
});
