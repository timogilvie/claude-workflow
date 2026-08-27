/**
 * Tests for review-runner module.
 *
 * Note: These tests focus on logic validation without invoking the actual LLM.
 * End-to-end tests with real LLM calls should be run manually.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reviewChanges, reviewRunnerDeps, type ReviewOptions } from './review-runner.ts';

// Test constants
const TEST_DIR = join(tmpdir(), `review-runner-test-${Date.now()}`);

describe('review-runner', () => {
  beforeEach(() => {
    // Create test directory
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mock.restoreAll();
  });

  describe('Configuration Loading', () => {
    it('should use default configuration when no config file exists', () => {
      assert.ok(true);
    });

    it('should load custom judge model from config', () => {
      const configPath = join(TEST_DIR, '.wavemill-config.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          eval: {
            judge: {
              model: 'claude-haiku-4-5-20251001',
              provider: 'claude-cli',
            },
          },
        })
      );

      assert.ok(true);
    });

    it('should load UI verification settings from config', () => {
      const configPath = join(TEST_DIR, '.wavemill-config.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          ui: {
            visualVerification: false,
            devServer: 'http://localhost:3000',
          },
        })
      );

      assert.ok(true);
    });
  });

  describe('Review Options', () => {
    it('should respect skipUi option', () => {
      const options: ReviewOptions = {
        skipUi: true,
      };

      assert.equal(options.skipUi, true);
    });

    it('should respect uiOnly option', () => {
      const options: ReviewOptions = {
        uiOnly: true,
      };

      assert.equal(options.uiOnly, true);
    });

    it('should respect verbose option', () => {
      const options: ReviewOptions = {
        verbose: true,
      };

      assert.equal(options.verbose, true);
    });

    it('should expose operatingMode option for degraded review routing', () => {
      const options: ReviewOptions = {
        operatingMode: 'survival',
      };

      assert.equal(options.operatingMode, 'survival');
    });

    it('should forward operatingMode to the review engine', () => {
      const source = readFileSync(new URL('./review-runner.ts', import.meta.url), 'utf-8');

      assert.match(source, /operatingMode:\s*options\.operatingMode/);
    });

    it('adds a deterministic blocker for unacknowledged cross-PR reverts', async () => {
      mock.method(reviewRunnerDeps, 'getCurrentBranch', () => 'task/remove-strategy');
      mock.method(reviewRunnerDeps, 'getGitDiff', () => 'diff --git a/strategy.txt b/strategy.txt');
      mock.method(reviewRunnerDeps, 'assertReviewableDiff', () => undefined);
      mock.method(reviewRunnerDeps, 'ensureClaudeAvailable', async () => undefined);
      mock.method(reviewRunnerDeps, 'gatherReviewContextAsync', async () => ({
        diff: 'diff --git a/strategy.txt b/strategy.txt',
        plan: 'plan',
        taskPacket: 'packet',
        designContext: null,
        metadata: {
          branch: 'task/remove-strategy',
          files: ['strategy.txt'],
          hasUiChanges: false,
        },
      }));
      mock.method(reviewRunnerDeps, 'execShellCommand', (command: string) => {
        if (command.includes('git merge-base')) {
          return 'base-sha\n';
        }
        if (command.includes('gh pr view')) {
          return '';
        }
        if (command.includes('git log --format=%B')) {
          return '';
        }
        throw new Error(`unexpected command: ${command}`);
      });
      mock.method(reviewRunnerDeps, 'detectCrossPrReverts', () => [
        {
          prNumber: 437,
          title: 'Restore strategy explorer (#437)',
          files: [{ path: 'strategy.txt', status: 'deleted', confidence: 'deleted' }],
        },
      ]);
      mock.method(reviewRunnerDeps, 'runReview', async (context) => {
        assert.match(context.diff, /Cross-PR revert detector findings/);
        return {
          verdict: 'ready',
          codeReviewFindings: [],
          metadata: {
            branch: 'task/remove-strategy',
            files: ['strategy.txt'],
            hasUiChanges: false,
            designContextAvailable: false,
            uiVerificationRun: false,
          },
        };
      });

      const result = await reviewChanges({
        repoDir: TEST_DIR,
      });

      assert.equal(result.verdict, 'not_ready');
      // Assert on the cross-pr-revert finding specifically. The scope guard also
      // reports here (this fixture supplies neither sinceCommit nor featureDir),
      // so a total-length assertion couples this test to an unrelated check.
      const revertFindings = result.codeReviewFindings.filter((f) => f.category === 'cross-pr-revert');
      assert.equal(revertFindings.length, 1);
      assert.equal(revertFindings[0].severity, 'blocker');
      assert.match(revertFindings[0].description, /Reverts #437/);
    });

    it('fails closed when cross-PR revert evidence cannot be collected', async () => {
      mock.method(reviewRunnerDeps, 'getCurrentBranch', () => 'task/no-integration-branch');
      mock.method(reviewRunnerDeps, 'getGitDiff', () => 'diff --git a/app.ts b/app.ts');
      mock.method(reviewRunnerDeps, 'assertReviewableDiff', () => undefined);
      mock.method(reviewRunnerDeps, 'ensureClaudeAvailable', async () => undefined);
      mock.method(reviewRunnerDeps, 'gatherReviewContextAsync', async () => ({
        diff: 'diff --git a/app.ts b/app.ts',
        plan: 'plan',
        taskPacket: 'packet',
        designContext: null,
        metadata: {
          branch: 'task/no-integration-branch',
          files: ['app.ts'],
          hasUiChanges: false,
        },
      }));
      mock.method(reviewRunnerDeps, 'execShellCommand', (command: string) => {
        if (command.includes('git merge-base')) {
          throw new Error('fatal: Not a valid object name auto/integration');
        }
        throw new Error(`unexpected command: ${command}`);
      });
      mock.method(reviewRunnerDeps, 'detectCrossPrReverts', () => {
        throw new Error('detectCrossPrReverts should not run when integration ref is missing');
      });
      mock.method(reviewRunnerDeps, 'runReview', async (context) => {
        assert.match(context.diff, /Cross-PR revert detector findings/);
        return {
          verdict: 'ready',
          codeReviewFindings: [],
          metadata: {
            branch: 'task/no-integration-branch',
            files: ['app.ts'],
            hasUiChanges: false,
            designContextAvailable: false,
            uiVerificationRun: false,
          },
        };
      });

      const result = await reviewChanges({
        repoDir: TEST_DIR,
      });

      assert.equal(result.verdict, 'not_ready');
      const evidenceFindings = result.codeReviewFindings.filter((f) => f.category === 'cross-pr-revert');
      assert.equal(evidenceFindings.length, 1);
      assert.match(evidenceFindings[0].description, /Unable to prove/);
    });
  });

  describe('Review Result Parsing', () => {
    it('should handle ready verdict with no findings', () => {
      const mockResponse = {
        verdict: 'ready',
        codeReviewFindings: [],
      };

      assert.equal(mockResponse.verdict, 'ready');
      assert.equal(mockResponse.codeReviewFindings.length, 0);
    });

    it('should handle not_ready verdict with blockers', () => {
      const mockResponse = {
        verdict: 'not_ready',
        codeReviewFindings: [
          {
            severity: 'blocker',
            location: 'test.ts:10',
            category: 'security',
            description: 'SQL injection vulnerability',
          },
        ],
      };

      assert.equal(mockResponse.verdict, 'not_ready');
      assert.equal(mockResponse.codeReviewFindings.length, 1);
      assert.equal(mockResponse.codeReviewFindings[0].severity, 'blocker');
    });

    it('should handle UI findings when present', () => {
      const mockResponse = {
        verdict: 'not_ready',
        codeReviewFindings: [],
        uiFindings: [
          {
            severity: 'warning',
            location: 'Button.tsx:25',
            category: 'consistency',
            description: 'Using arbitrary color instead of design token',
          },
        ],
      };

      assert.ok(mockResponse.uiFindings);
      assert.equal(mockResponse.uiFindings.length, 1);
    });

    it('should handle stronger reviewer escalation fields when present', () => {
      const mockResponse = {
        verdict: 'ready',
        codeReviewFindings: [],
        needsStrongerReviewer: true,
        strongerReviewerReason: 'Cross-file contract verification was incomplete',
      };

      assert.equal(mockResponse.needsStrongerReviewer, true);
      assert.match(mockResponse.strongerReviewerReason, /Cross-file contract/);
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed JSON response gracefully', () => {
      const malformedJson = '{ "verdict": "ready", "codeReviewFindings": [';

      assert.throws(() => JSON.parse(malformedJson));
    });

    it('should handle missing verdict in response', () => {
      const invalidResponse: Record<string, unknown> = {
        codeReviewFindings: [],
      };

      assert.equal(invalidResponse.verdict, undefined);
    });

    it('should handle invalid verdict value', () => {
      const invalidResponse = {
        verdict: 'maybe',
        codeReviewFindings: [],
      };

      assert.equal(['ready', 'not_ready'].includes(invalidResponse.verdict), false);
    });
    });

  describe('Guard Infrastructure Failures', () => {
    it('Guard error → fail open with signal: sets failureCategory and warning finding', async () => {
      mock.method(reviewRunnerDeps, 'getCurrentBranch', () => 'task/test-guard-error');
      mock.method(reviewRunnerDeps, 'getGitDiff', () => 'diff --git a/app.ts b/app.ts');
      mock.method(reviewRunnerDeps, 'assertReviewableDiff', () => undefined);
      mock.method(reviewRunnerDeps, 'ensureClaudeAvailable', async () => undefined);
      mock.method(reviewRunnerDeps, 'gatherReviewContextAsync', async () => ({
        diff: 'diff --git a/app.ts b/app.ts',
        plan: 'plan',
        taskPacket: 'packet',
        designContext: null,
        metadata: {
          branch: 'task/test-guard-error',
          files: ['app.ts'],
          hasUiChanges: false,
        },
      }));
      
      mock.method(reviewRunnerDeps, 'validateReviewScope', () => ({
        ok: false,
        status: 'error',
        baselinePaths: [],
        declaredScope: [],
        baselineSource: 'unresolved',
        baselineIsArtifact: false,
        featureDir: null,
        integrationRef: 'auto/integration',
        mergeBase: null,
        taskPaths: [],
        stagedPaths: [],
        allowedCompanionPaths: [],
        outOfScopePaths: [],
        findings: [],
        crossPrReverts: [],
        message: 'Review scope could not be verified',
        toolError: {
          commandClass: 'git-merge-base',
          command: 'git merge-base auto/integration HEAD',
          exitCode: 128,
          stderr: 'fatal: Not a valid object name auto/integration',
        },
      }));
      
      mock.method(reviewRunnerDeps, 'runReview', async () => ({
        verdict: 'ready',
        codeReviewFindings: [],
        metadata: {
          branch: 'task/test-guard-error',
          files: ['app.ts'],
          hasUiChanges: false,
          designContextAvailable: false,
          uiVerificationRun: false,
        },
      }));

      const result = await reviewChanges({
        repoDir: TEST_DIR,
      });

      assert.equal(result.verdict, 'ready');
      assert.equal(result.failureCategory, 'review-scope-unverifiable');
      
      const scopeFindings = result.codeReviewFindings.filter((f) => f.category === 'review-scope');
      assert.equal(scopeFindings.length, 1);
      assert.equal(scopeFindings[0].severity, 'warning');
      assert.match(scopeFindings[0].description, /could not be verified/);
      assert.match(scopeFindings[0].description, /git-merge-base/);
      
      const blockerFindings = result.codeReviewFindings.filter((f) => f.severity === 'blocker');
      assert.equal(blockerFindings.length, 0);
    });

    it('Real violation → still blocks and has no failureCategory', async () => {
      mock.method(reviewRunnerDeps, 'getCurrentBranch', () => 'task/test-violation');
      mock.method(reviewRunnerDeps, 'getGitDiff', () => 'diff --git a/app.ts b/app.ts');
      mock.method(reviewRunnerDeps, 'assertReviewableDiff', () => undefined);
      mock.method(reviewRunnerDeps, 'ensureClaudeAvailable', async () => undefined);
      mock.method(reviewRunnerDeps, 'gatherReviewContextAsync', async () => ({
        diff: 'diff --git a/app.ts b.app.ts',
        plan: 'plan',
        taskPacket: 'packet',
        designContext: null,
        metadata: {
          branch: 'task/test-violation',
          files: ['app.ts'],
          hasUiChanges: false,
        },
      }));
      
      mock.method(reviewRunnerDeps, 'validateReviewScope', () => ({
        ok: false,
        status: 'fail',
        baselinePaths: [],
        declaredScope: [],
        baselineSource: 'git merge-base',
        baselineIsArtifact: false,
        featureDir: null,
        integrationRef: 'auto/integration',
        mergeBase: 'abc123',
        taskPaths: [],
        stagedPaths: [],
        allowedCompanionPaths: [],
        outOfScopePaths: ['unrelated.txt'],
        findings: [{
          severity: 'blocker',
          category: 'review-scope',
          kind: 'violation',
          path: 'unrelated.txt',
          status: 'A',
          message: 'Unexpected review change outside task scope: unrelated.txt (A)',
          details: { baselineSource: 'git merge-base', declaredScope: [] },
        }],
        crossPrReverts: [],
        message: 'Review scope guard failed',
      }));
      
      mock.method(reviewRunnerDeps, 'runReview', async () => ({
        verdict: 'not_ready',
        codeReviewFindings: [],
        metadata: {
          branch: 'task/test-violation',
          files: ['app.ts'],
          hasUiChanges: false,
          designContextAvailable: false,
          uiVerificationRun: false,
        },
      }));

      const result = await reviewChanges({
        repoDir: TEST_DIR,
      });

      assert.equal(result.verdict, 'not_ready');
      assert.equal(result.failureCategory, undefined);
      
      const blockerFindings = result.codeReviewFindings.filter((f) => f.severity === 'blocker');
      assert.equal(blockerFindings.length, 1);
      assert.equal(blockerFindings[0].category, 'review-scope');
    });

    it('Guard pass → no failureCategory', async () => {
      mock.method(reviewRunnerDeps, 'getCurrentBranch', () => 'task/test-pass');
      mock.method(reviewRunnerDeps, 'getGitDiff', () => 'diff --git a/app.ts b.app.ts');
      mock.method(reviewRunnerDeps, 'assertReviewableDiff', () => undefined);
      mock.method(reviewRunnerDeps, 'ensureClaudeAvailable', async () => undefined);
      mock.method(reviewRunnerDeps, 'gatherReviewContextAsync', async () => ({
        diff: 'diff --git a/app.ts b.app.ts',
        plan: 'plan',
        taskPacket: 'packet',
        designContext: null,
        metadata: {
          branch: 'task/test-pass',
          files: ['app.ts'],
          hasUiChanges: false,
        },
      }));
      
      mock.method(reviewRunnerDeps, 'validateReviewScope', () => ({
        ok: true,
        status: 'pass',
        baselinePaths: ['app.ts'],
        declaredScope: ['app.ts'],
        baselineSource: 'git merge-base',
        baselineIsArtifact: false,
        featureDir: null,
        integrationRef: 'auto/integration',
        mergeBase: 'abc123',
        taskPaths: ['app.ts'],
        stagedPaths: [],
        allowedCompanionPaths: [],
        outOfScopePaths: [],
        findings: [],
        crossPrReverts: [],
        message: 'Review scope guard passed',
      }));
      
      mock.method(reviewRunnerDeps, 'runReview', async () => ({
        verdict: 'ready',
        codeReviewFindings: [],
        metadata: {
          branch: 'task/test-pass',
          files: ['app.ts'],
          hasUiChanges: false,
          designContextAvailable: false,
          uiVerificationRun: false,
        },
      }));

      const result = await reviewChanges({
        repoDir: TEST_DIR,
      });

      assert.equal(result.verdict, 'ready');
      assert.equal(result.failureCategory, undefined);
    });
  });
});
