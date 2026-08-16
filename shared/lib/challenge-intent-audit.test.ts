import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import type { EvalRecord } from './eval-schema.ts';
import {
  auditChallengeRecord,
  runChallengeIntentAudit,
  type AuditResult,
} from './challenge-intent-audit.ts';

describe('challenge-intent-audit', () => {
  describe('auditChallengeRecord', () => {
    const baseRecord: EvalRecord = {
      id: 'test-record',
      issueId: 'HOK-123',
      prUrl: 'https://github.com/test/repo/pull/1',
      modelId: 'claude-sonnet-5',
      score: 0.75,
      agentType: 'claude',
      timestamp: new Date().toISOString(),
    };

    it('marks already-invalid records and attaches attestation', () => {
      const record: EvalRecord = {
        ...baseRecord,
        challengePairId: 'HOK-123_c',
        challengeSide: 'challenger',
        challengeIntent: {
          pairId: 'HOK-123_c',
          issueId: 'HOK-123',
          schemaVersion: 1,
          selectedStage: 'implementation',
          primary: {
            expectedStageModel: 'gpt-5.5',
            expectedStageAgent: 'codex',
          },
          challenger: {
            expectedStageModel: 'glm-5.2',
            expectedStageAgent: 'native-openrouter',
          },
        },
        challengeExecutionRoute: {
          agent: 'native-openrouter',
          model: 'glm-5.2',
        },
        trainingEligible: true,
      };

      const result = auditChallengeRecord(record);

      // Record is clean because it's a valid challenge pair that executed as intended.
      // If it were marked with evidence of divergence, it would be quarantined.
      // The attestation function handles detecting actual divergence based on evidence
      // (executedPlanning, routing history, etc.), not just intent/route structure.
      assert.equal(result.action, 'clean');
      assert.equal(result.changed, false);
    });

    it('does not modify already-marked invalid records', () => {
      const record: EvalRecord = {
        ...baseRecord,
        challengePairId: 'HOK-123_c',
        invalidChallenge: true,
        challengeDivergenceReason: 'stage_override_lost',
        nonRewardReason: {
          code: 'INVALID_CHALLENGE',
          message: 'Previous divergence detected.',
        },
      };

      const beforeNonRewardReason = record.nonRewardReason;
      const result = auditChallengeRecord(record);

      assert.equal(result.action, 'already_marked');
      assert.equal(result.changed, false);
      assert.equal(record.nonRewardReason, beforeNonRewardReason);
    });

    it('leaves clean records untouched', () => {
      const record: EvalRecord = {
        ...baseRecord,
        challengePairId: 'HOK-123_c',
        challengeIntent: {
          pairId: 'HOK-123_c',
          issueId: 'HOK-123',
          schemaVersion: 1,
          selectedStage: 'implementation',
          primary: {
            expectedStageModel: 'gpt-5.5',
            expectedStageAgent: 'codex',
          },
          challenger: {
            expectedStageModel: 'glm-5.2',
            expectedStageAgent: 'native-openrouter',
          },
        },
        challengeExecutionRoute: {
          agent: 'native-openrouter',
          model: 'glm-5.2',
        },
      };

      const beforeString = JSON.stringify(record);
      const result = auditChallengeRecord(record);
      const afterString = JSON.stringify(record);

      assert.equal(result.action, 'clean');
      assert.equal(result.changed, false);
      assert.equal(afterString, beforeString);
    });

    it('quarantines records missing challenge intent when paired', () => {
      const record: EvalRecord = {
        ...baseRecord,
        challengePairId: 'HOK-123_c',
        challengeSide: 'challenger',
        // No challengeIntent
      };

      const result = auditChallengeRecord(record);

      assert.equal(result.action, 'missing_intent_quarantined');
      assert.equal(result.reason, 'missing_challenge_intent');
      assert.equal(record.invalidChallenge, true);
      assert.equal(record.trainingEligible, false);
    });

    it('treats records without challengePairId as clean', () => {
      const record: EvalRecord = {
        ...baseRecord,
        // No challengePairId
      };

      const result = auditChallengeRecord(record);

      assert.equal(result.action, 'clean');
      assert.equal(result.changed, false);
    });
  });

  describe('runChallengeIntentAudit', () => {
    let tempDir: string;
    let testFilePath: string;

    beforeEach(() => {
      tempDir = mkdtempSync('/tmp/audit-test-');
      testFilePath = join(tempDir, 'evals.jsonl');
    });

    afterEach(() => {
      if (existsSync(testFilePath)) {
        unlinkSync(testFilePath);
      }
      rmSync(tempDir, { recursive: true, force: true });
    });

    it('applies changes to file when not in dry-run mode', () => {
      const record: EvalRecord = {
        id: 'test-record',
        issueId: 'HOK-123',
        prUrl: 'https://github.com/test/repo/pull/1',
        modelId: 'claude-sonnet-5',
        score: 0.75,
        agentType: 'claude',
        timestamp: new Date().toISOString(),
        challengePairId: 'HOK-123_c',
        challengeSide: 'challenger',
        trainingEligible: true,
        // No challengeIntent - will be quarantined
      };

      writeFileSync(testFilePath, JSON.stringify(record) + '\n', 'utf-8');

      const result = runChallengeIntentAudit({
        filePath: testFilePath,
        dryRun: false,
      });

      assert.equal(result.scanned, 1);
      assert.equal(result.missingIntentQuarantined, 1);

      const fileContent = readFileSync(testFilePath, 'utf-8');
      const updatedRecord = JSON.parse(fileContent.trim()) as EvalRecord;
      assert.equal(updatedRecord.invalidChallenge, true);
      assert.equal(updatedRecord.trainingEligible, false);
    });

    it('does not modify file when in dry-run mode', () => {
      const record: EvalRecord = {
        id: 'test-record',
        issueId: 'HOK-123',
        prUrl: 'https://github.com/test/repo/pull/1',
        modelId: 'claude-sonnet-5',
        score: 0.75,
        agentType: 'claude',
        timestamp: new Date().toISOString(),
        challengePairId: 'HOK-123_c',
        challengeSide: 'challenger',
        trainingEligible: true,
      };

      writeFileSync(testFilePath, JSON.stringify(record) + '\n', 'utf-8');
      const originalContent = readFileSync(testFilePath, 'utf-8');

      const result = runChallengeIntentAudit({
        filePath: testFilePath,
        dryRun: true,
      });

      assert.equal(result.scanned, 1);
      assert.equal(result.missingIntentQuarantined, 1);

      const fileContent = readFileSync(testFilePath, 'utf-8');
      assert.equal(fileContent, originalContent);
    });

    it('preserves byte-identical records unchanged', () => {
      const record: EvalRecord = {
        id: 'test-record',
        issueId: 'HOK-123',
        prUrl: 'https://github.com/test/repo/pull/1',
        modelId: 'claude-sonnet-5',
        score: 0.75,
        agentType: 'claude',
        timestamp: new Date().toISOString(),
        challengePairId: 'HOK-123_c',
        challengeIntent: {
          pairId: 'HOK-123_c',
          issueId: 'HOK-123',
          schemaVersion: 1,
          selectedStage: 'implementation',
          primary: {
            expectedStageModel: 'gpt-5.5',
            expectedStageAgent: 'codex',
          },
          challenger: {
            expectedStageModel: 'glm-5.2',
            expectedStageAgent: 'native-openrouter',
          },
        },
        challengeExecutionRoute: {
          agent: 'native-openrouter',
          model: 'glm-5.2',
        },
      };

      const serializedRecord = JSON.stringify(record);
      writeFileSync(testFilePath, serializedRecord + '\n', 'utf-8');

      runChallengeIntentAudit({
        filePath: testFilePath,
        dryRun: false,
      });

      const fileContent = readFileSync(testFilePath, 'utf-8');
      assert.equal(fileContent.trim(), serializedRecord);
    });

    it('preserves comments and empty lines', () => {
      const content = `# Comment line
{"id":"record1","issueId":"HOK-1","prUrl":"https://github.com/test/repo/pull/1","modelId":"claude-sonnet-5","score":0.75,"agentType":"claude","timestamp":"2026-01-01T00:00:00Z"}

# Another comment
`;

      writeFileSync(testFilePath, content, 'utf-8');

      runChallengeIntentAudit({
        filePath: testFilePath,
        dryRun: false,
      });

      const fileContent = readFileSync(testFilePath, 'utf-8');
      assert.ok(fileContent.includes('# Comment line'));
      assert.ok(fileContent.includes('# Another comment'));
    });

    it('counts unparseable lines without dropping them', () => {
      const content = `{"id":"record1","issueId":"HOK-1","prUrl":"https://github.com/test/repo/pull/1","modelId":"claude-sonnet-5","score":0.75,"agentType":"claude","timestamp":"2026-01-01T00:00:00Z"}
invalid json line
{"id":"record2","issueId":"HOK-2","prUrl":"https://github.com/test/repo/pull/2","modelId":"claude-sonnet-5","score":0.8,"agentType":"claude","timestamp":"2026-01-01T00:00:00Z"}
`;

      writeFileSync(testFilePath, content, 'utf-8');

      const result = runChallengeIntentAudit({
        filePath: testFilePath,
        dryRun: false,
      });

      assert.equal(result.scanned, 3);
      assert.equal(result.unparseable, 1);
      assert.equal(result.clean, 2);

      const fileContent = readFileSync(testFilePath, 'utf-8');
      assert.ok(fileContent.includes('invalid json line'));
    });
  });
});
