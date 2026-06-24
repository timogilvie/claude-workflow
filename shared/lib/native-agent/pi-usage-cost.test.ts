import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { computeWorkflowCost } from '../workflow-cost.ts';
import { NativeSessionAdapter, piUsageToSessionModelUsage } from './pi-usage-cost.ts';

function setupNativeSessionsDir() {
  const worktreePath = mkdtempSync(join(tmpdir(), 'native-session-cost-'));
  const sessionsDir = join(worktreePath, '.wavemill', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });

  return {
    worktreePath,
    sessionsDir,
    cleanup: () => rmSync(worktreePath, { recursive: true, force: true }),
  };
}

function writeSessionFixture(sessionsDir: string, name: string, content: string): string {
  const filePath = join(sessionsDir, name);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function loadNativeFixture(): string {
  return readFileSync(
    new URL('./fixtures/native-session.jsonl', import.meta.url),
    'utf-8',
  );
}

function buildLegacyNativeSession(worktreePath: string): string {
  return [
    JSON.stringify({
      seq: 0,
      sessionId: 'legacy-native-session',
      timestamp: 1750000100,
      type: 'session_started',
      model: 'claude-opus-4-6',
      api: 'hokusai-mock',
      provider: 'hokusai',
      worktreePath,
    }),
    JSON.stringify({
      seq: 1,
      sessionId: 'legacy-native-session',
      timestamp: 1750000101,
      type: 'assistant_message',
      model: 'claude-opus-4-6',
      stopReason: 'stop',
      usage: {
        input: 10,
        output: 5,
        cacheRead: 3,
        cacheWrite: 2,
        totalTokens: 20,
      },
      rawContent: [{ type: 'text', text: 'legacy turn' }],
      replayContent: [{ type: 'text', text: 'legacy turn' }],
      redacted: true,
    }),
  ].join('\n') + '\n';
}

describe('piUsageToSessionModelUsage', () => {
  it('maps Pi usage fields into the shared session usage shape', () => {
    assert.deepEqual(
      piUsageToSessionModelUsage({
        input: 1200,
        output: 350,
        cacheRead: 800,
        cacheWrite: 64,
        totalTokens: 2414,
      }),
      {
        inputTokens: 1200,
        outputTokens: 350,
        cacheReadTokens: 800,
        cacheCreationTokens: 64,
      },
    );
  });

  it('defaults missing usage fields to zero', () => {
    assert.deepEqual(
      piUsageToSessionModelUsage({
        input: 7,
        output: 3,
      }),
      {
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    );

    assert.deepEqual(piUsageToSessionModelUsage(undefined), {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});

describe('NativeSessionAdapter', () => {
  it('aggregates native session usage from JSONL fixtures', () => {
    const { worktreePath, sessionsDir, cleanup } = setupNativeSessionsDir();
    try {
      writeSessionFixture(sessionsDir, 'native-session.jsonl', loadNativeFixture());

      const adapter = new NativeSessionAdapter();
      const result = adapter.scan({
        worktreePath,
        branchName: 'task/native-session-costs',
      });

      assert.ok(result);
      assert.equal(result.sessionCount, 1);
      assert.equal(result.turnCount, 2);
      assert.deepEqual(result.models['claude-opus-4-6'], {
        inputTokens: 1200,
        cacheCreationTokens: 80,
        cacheReadTokens: 400,
        outputTokens: 300,
      });
      assert.deepEqual(result.models['unknown-native-model'], {
        inputTokens: 900,
        cacheCreationTokens: 40,
        cacheReadTokens: 200,
        outputTokens: 100,
      });
    } finally {
      cleanup();
    }
  });

  it('returns null when branch metadata does not match', () => {
    const { worktreePath, sessionsDir, cleanup } = setupNativeSessionsDir();
    try {
      writeSessionFixture(sessionsDir, 'native-session.jsonl', loadNativeFixture());

      const adapter = new NativeSessionAdapter();
      const result = adapter.scan({
        worktreePath,
        branchName: 'task/other-branch',
      });

      assert.equal(result, null);
    } finally {
      cleanup();
    }
  });

  it('matches legacy native sessions by persisted worktree path when gitBranch is absent', () => {
    const { worktreePath, sessionsDir, cleanup } = setupNativeSessionsDir();
    try {
      writeSessionFixture(sessionsDir, 'legacy-session.jsonl', buildLegacyNativeSession(worktreePath));

      const adapter = new NativeSessionAdapter();
      const result = adapter.scan({
        worktreePath,
        branchName: 'task/any-branch',
      });

      assert.ok(result);
      assert.equal(result.sessionCount, 1);
      assert.equal(result.turnCount, 1);
      assert.deepEqual(result.models['claude-opus-4-6'], {
        inputTokens: 10,
        cacheCreationTokens: 2,
        cacheReadTokens: 3,
        outputTokens: 5,
      });
    } finally {
      cleanup();
    }
  });
});

describe('computeWorkflowCost native integration', () => {
  it('prices native sessions before Claude/Codex fallback and preserves unknown models at zero cost', () => {
    const { worktreePath, sessionsDir, cleanup } = setupNativeSessionsDir();
    try {
      writeSessionFixture(sessionsDir, 'native-session.jsonl', loadNativeFixture());

      const result = computeWorkflowCost({
        worktreePath,
        branchName: 'task/native-session-costs',
        agentType: 'codex',
        pricingTable: {
          'claude-opus-4-6': {
            inputCostPerMTok: 15,
            outputCostPerMTok: 75,
            cacheWriteCostPerMTok: 18.75,
            cacheReadCostPerMTok: 1.5,
          },
        },
      });

      assert.equal(result.status, 'success');
      assert.equal(result.sessionCount, 1);
      assert.equal(result.turnCount, 2);
      assert.ok(result.totalCostUsd > 0);
      assert.equal(result.models['claude-opus-4-6'].costUsd, 0.0426);
      assert.equal(result.models['unknown-native-model'].costUsd, 0);
      assert.equal(result.models['unknown-native-model'].inputTokens, 900);
      assert.equal(result.models['unknown-native-model'].cacheCreationTokens, 40);
      assert.equal(result.models['unknown-native-model'].cacheReadTokens, 200);
      assert.equal(result.models['unknown-native-model'].outputTokens, 100);
      assert.deepEqual(result.pricingUsed, {
        'claude-opus-4-6': {
          inputCostPerMTok: 15,
          outputCostPerMTok: 75,
          cacheWriteCostPerMTok: 18.75,
          cacheReadCostPerMTok: 1.5,
        },
      });
    } finally {
      cleanup();
    }
  });
});
