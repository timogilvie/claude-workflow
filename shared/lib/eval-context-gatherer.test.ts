/**
 * Tests for eval-context-gatherer module.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import type { ExecSyncOptions } from 'node:child_process';
import type { PrDiffResult } from './pr-diff-provider.ts';
import {
  computePhaseDurations,
  computeWallClockSeconds,
  evalContextGathererDeps,
  fetchIssueData,
  formatIssueAsPrompt,
  fetchPrContext,
  gatherEvalContext,
  gatherStageArtifacts,
  convertToRoutingDecision,
  fetchRoutingDecision,
  fetchRoutingCompleteRawWithArchive,
} from './eval-context-gatherer.ts';

const defaultDeps = { ...evalContextGathererDeps };
type ExecCall = { command: string; options?: ExecSyncOptions };
type ExecHandler = (command: string, options?: ExecSyncOptions) => string;

let execCalls: ExecCall[] = [];

function diffResult(text: string): PrDiffResult {
  return {
    kind: 'diff',
    text,
    source: 'gh-pr-diff',
    bytes: Buffer.byteLength(text),
    attempts: ['test'],
  };
}

function unavailableDiffResult(): PrDiffResult {
  return {
    kind: 'unavailable',
    reason: 'gh_error',
    detail: 'failed',
    attempts: ['test'],
  };
}

function setExecMock(handler: ExecHandler): void {
  evalContextGathererDeps.execShellCommand = (command, options) => {
    execCalls.push({ command, options });
    return handler(command, options);
  };
}

function mockExecSequence(...values: Array<string | Error>): void {
  let index = 0;
  setExecMock(() => {
    const value = values[index++] ?? '';
    if (value instanceof Error) throw value;
    return value;
  });
}

describe('eval-context-gatherer', () => {
  beforeEach(() => {
    execCalls = [];
    Object.assign(evalContextGathererDeps, defaultDeps);
    evalContextGathererDeps.fetchPrDiff = () => unavailableDiffResult();
  });

  afterEach(() => {
    Object.assign(evalContextGathererDeps, defaultDeps);
  });

  describe('fetchIssueData', () => {
    it('should fetch and parse issue data', () => {
      const mockIssue = {
        identifier: 'HOK-870',
        title: 'Test Issue',
        description: 'Test description',
      };

      mockExecSequence(JSON.stringify(mockIssue));

      const result = fetchIssueData('HOK-870', '/repo');

      assert.deepEqual(result, mockIssue);
      assert.ok(execCalls[0].command.includes('HOK-870'));
      assert.equal(execCalls[0].options?.cwd, '/repo');
    });

    it('should return null on fetch failure', () => {
      mockExecSequence(new Error('fetch failed'));

      const result = fetchIssueData('HOK-870', '/repo');

      assert.equal(result, null);
    });

    it('should return null on JSON parse failure', () => {
      mockExecSequence('invalid json');

      const result = fetchIssueData('HOK-870', '/repo');

      assert.equal(result, null);
    });
  });

  describe('formatIssueAsPrompt', () => {
    it('should format issue with all fields', () => {
      const issue = {
        identifier: 'HOK-870',
        title: 'Test Issue',
        description: 'Test description',
      };

      const result = formatIssueAsPrompt(issue, 'HOK-870');

      assert.ok(result.includes('HOK-870: Test Issue'));
      assert.ok(result.includes('Test description'));
    });

    it('should handle missing description', () => {
      const issue = {
        identifier: 'HOK-870',
        title: 'Test Issue',
      };

      const result = formatIssueAsPrompt(issue, 'HOK-870');

      assert.ok(result.includes('HOK-870: Test Issue'));
    });

    it('should handle null issue', () => {
      const result = formatIssueAsPrompt(null, 'HOK-870');

      assert.equal(result, 'Issue: HOK-870 (details unavailable)');
    });
  });

  describe('fetchPrContext', () => {
    it('should fetch PR URL and diff', () => {
      mockExecSequence('https://github.com/user/repo/pull/123');
      evalContextGathererDeps.fetchPrDiff = () => diffResult('diff --git a/file.ts b/file.ts\n...');

      const result = fetchPrContext('123', '/repo');

      assert.equal(result.url, 'https://github.com/user/repo/pull/123');
      assert.ok(result.diff.includes('diff --git'));
    });

    it('should handle URL fetch failure gracefully', () => {
      mockExecSequence(new Error('failed'));
      evalContextGathererDeps.fetchPrDiff = () => diffResult('diff content');

      const result = fetchPrContext('123', '/repo');

      assert.equal(result.url, '');
      assert.equal(result.diff, 'diff content');
    });

    it('should handle diff fetch failure gracefully', () => {
      mockExecSequence('https://github.com/user/repo/pull/123');
      evalContextGathererDeps.fetchPrDiff = () => unavailableDiffResult();

      const result = fetchPrContext('123', '/repo');

      assert.equal(result.url, 'https://github.com/user/repo/pull/123');
      assert.equal(result.diff, '');
      assert.equal(result.availability.available, false);
    });

    it('should handle both fetch failures gracefully', () => {
      mockExecSequence(new Error('failed'));

      const result = fetchPrContext('123', '/repo');

      assert.equal(result.url, '');
      assert.equal(result.diff, '');
      assert.equal(result.availability.available, false);
    });
  });

  describe('gatherEvalContext', () => {
    it('should gather all context successfully', () => {
      const mockIssue = {
        identifier: 'HOK-870',
        title: 'Test Issue',
        description: 'Test description',
      };

      mockExecSequence(
        JSON.stringify(mockIssue),
        'https://github.com/user/repo/pull/123',
      );
      evalContextGathererDeps.fetchPrDiff = () => diffResult('diff content');

      const result = gatherEvalContext({
        issueId: 'HOK-870',
        prNumber: '123',
        repoDir: '/repo',
      });

      assert.ok(result.taskPrompt.includes('HOK-870: Test Issue'));
      assert.equal(result.prDiff, 'diff content');
      assert.equal(result.prUrl, 'https://github.com/user/repo/pull/123');
      assert.deepEqual(result.issueData, mockIssue);
    });

    it('should use provided prUrl if given', () => {
      mockExecSequence('https://github.com/user/repo/pull/123');
      evalContextGathererDeps.fetchPrDiff = () => diffResult('diff content');

      const result = gatherEvalContext({
        prNumber: '123',
        prUrl: 'https://custom.url',
        repoDir: '/repo',
      });

      assert.equal(result.prUrl, 'https://custom.url');
    });

    it('should handle missing issueId', () => {
      mockExecSequence('https://github.com/user/repo/pull/123');
      evalContextGathererDeps.fetchPrDiff = () => diffResult('diff content');

      const result = gatherEvalContext({
        prNumber: '123',
        repoDir: '/repo',
      });

      assert.equal(result.taskPrompt, 'Issue:  (details unavailable)');
      assert.equal(result.issueData, null);
    });

    it('should handle missing prNumber', () => {
      const mockIssue = {
        identifier: 'HOK-870',
        title: 'Test Issue',
        description: 'Test description',
      };

      mockExecSequence(JSON.stringify(mockIssue));

      const result = gatherEvalContext({
        issueId: 'HOK-870',
        repoDir: '/repo',
      });

      assert.equal(result.prDiff, '');
      assert.equal(result.prUrl, '');
    });

    it('should handle all fetch failures gracefully', () => {
      setExecMock(() => {
        throw new Error('failed');
      });

      const result = gatherEvalContext({
        issueId: 'HOK-870',
        prNumber: '123',
        repoDir: '/repo',
      });

      assert.ok(result.taskPrompt.includes('details unavailable'));
      assert.equal(result.prDiff, '');
      assert.equal(result.prDiffAvailability.available, false);
      assert.equal(result.prUrl, '');
      assert.equal(result.issueData, null);
    });
  });

  describe('computeWallClockSeconds', () => {
    it('should return null when git log is empty', () => {
      mockExecSequence('');

      const result = computeWallClockSeconds('/repo', 'task/test');

      assert.equal(result, null);
      assert.ok(execCalls[0].command.includes("git log 'main'..'task/test' --format=\"%ct\" --reverse"));
      assert.equal(execCalls[0].options?.cwd, '/repo');
    });

    it('should return null for a single commit timestamp', () => {
      mockExecSequence('1710000000');

      const result = computeWallClockSeconds('/repo', 'task/test');

      assert.equal(result, null);
    });

    it('should return the elapsed seconds for multiple commits', () => {
      mockExecSequence('1710000000\n1710000015\n1710000120');

      const result = computeWallClockSeconds('/repo', 'task/test');

      assert.equal(result, 120);
    });

    it('should ignore malformed timestamps when valid endpoints remain', () => {
      mockExecSequence('1710000000\nnot-a-number\n1710000060\n0');

      const result = computeWallClockSeconds('/repo', 'task/test');

      assert.equal(result, 60);
    });

    it('should return null on git errors', () => {
      setExecMock(() => {
        throw new Error('git failed');
      });

      const result = computeWallClockSeconds('/repo', 'missing-branch');

      assert.equal(result, null);
    });
  });

  describe('computePhaseDurations', () => {
    function makeTmpDir(): string {
      return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'phase-durations-'));
    }

    it('returns all completed phase durations and total', () => {
      const repoDir = makeTmpDir();
      const featureDir = nodePath.join(repoDir, 'features', 'accurate-wall-clock');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(featureDir, '.planning-result.json'),
        JSON.stringify({
          startedAt: '2026-05-31T10:00:00.000Z',
          finishedAt: '2026-05-31T10:05:30.000Z',
        }),
      );
      fs.writeFileSync(
        nodePath.join(featureDir, '.coding-result.json'),
        JSON.stringify({
          startedAt: '2026-05-31T10:06:00.000Z',
          finishedAt: '2026-05-31T10:21:00.000Z',
        }),
      );
      fs.writeFileSync(
        nodePath.join(featureDir, '.review-result.json'),
        JSON.stringify({
          startedAt: '2026-05-31T10:21:00.000Z',
          finishedAt: '2026-05-31T10:24:15.000Z',
        }),
      );

      try {
        assert.deepEqual(computePhaseDurations(repoDir, 'accurate-wall-clock'), {
          planning: 330,
          coding: 900,
          review: 195,
          total: 1425,
        });
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('leaves missing phase files undefined', () => {
      const repoDir = makeTmpDir();
      const featureDir = nodePath.join(repoDir, 'features', 'accurate-wall-clock');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(featureDir, '.coding-result.json'),
        JSON.stringify({
          startedAt: '2026-05-31T10:06:00.000Z',
          finishedAt: '2026-05-31T10:21:00.000Z',
        }),
      );

      try {
        assert.deepEqual(computePhaseDurations(repoDir, 'accurate-wall-clock'), {
          coding: 900,
          total: 900,
        });
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('ignores incomplete phase result files', () => {
      const repoDir = makeTmpDir();
      const featureDir = nodePath.join(repoDir, 'features', 'accurate-wall-clock');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(featureDir, '.planning-result.json'),
        JSON.stringify({
          startedAt: '2026-05-31T10:00:00.000Z',
        }),
      );

      try {
        assert.equal(computePhaseDurations(repoDir, 'accurate-wall-clock'), undefined);
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  describe('convertToRoutingDecision', () => {
    it('should build candidates from unique models', () => {
      const result = convertToRoutingDecision({
        planner: 'claude-sonnet-4-5-20250929',
        coder: 'claude-opus-4-6',
        reviewer: 'claude-haiku-4-5-20251001',
      });

      assert.equal(result.candidates.length, 3);
      assert.deepEqual(result.candidates.map((c) => c.modelId), [
        'claude-sonnet-4-5-20250929',
        'claude-opus-4-6',
        'claude-haiku-4-5-20251001',
      ]);
    });

    it('should deduplicate models when planner and coder are the same', () => {
      const result = convertToRoutingDecision({
        planner: 'claude-sonnet-4-5-20250929',
        coder: 'claude-sonnet-4-5-20250929',
        reviewer: 'claude-haiku-4-5-20251001',
      });

      assert.equal(result.candidates.length, 2);
      assert.deepEqual(result.candidates.map((c) => c.modelId), [
        'claude-sonnet-4-5-20250929',
        'claude-haiku-4-5-20251001',
      ]);
    });

    it('should set chosen to coder model', () => {
      const result = convertToRoutingDecision({
        planner: 'claude-sonnet-4-5-20250929',
        coder: 'claude-opus-4-6',
        reviewer: 'claude-haiku-4-5-20251001',
      });

      assert.deepEqual(result.chosen, {
        agentType: 'claude',
        modelId: 'claude-opus-4-6',
      });
    });

    it('should set decisionPolicyVersion to baseline', () => {
      const result = convertToRoutingDecision({
        planner: 'model-a',
        coder: 'model-b',
        reviewer: 'model-c',
      });

      assert.equal(result.decisionPolicyVersion, 'baseline');
      assert.equal(result.routeArtifactSchemaVersion, '1.1');
      assert.equal(result.policyResolverVersion, '1.0.0');
    });

    it('maps stage-aware routing metadata into structured policy fields', () => {
      const result = convertToRoutingDecision({
        planner: 'model-a',
        coder: 'model-b',
        reviewer: 'model-c',
        routingMode: 'stage-aware',
        provenance: {
          source: 'live',
          inputKind: 'issue',
          routerMode: 'normal',
        },
      });

      assert.equal(result.decisionPolicyVersion, 'stage-aware');
      assert.equal(result.routeMode, 'stage-aware');
      assert.equal(result.operatingModeDependency, 'normal');
    });

    it('maps hokusai routing metadata into structured policy fields', () => {
      const result = convertToRoutingDecision({
        planner: 'model-a',
        coder: 'model-b',
        reviewer: 'model-c',
        routingMode: 'hokusai',
        provenance: {
          source: 'live',
          inputKind: 'issue',
          routerMode: 'normal',
        },
      });

      assert.equal(result.decisionPolicyVersion, 'hokusai');
      assert.equal(result.routeMode, 'hokusai');
    });

    it('preserves operating mode separately from policy source', () => {
      const result = convertToRoutingDecision({
        planner: 'model-a',
        coder: 'model-b',
        reviewer: 'model-c',
        routingMode: 'stage-aware',
        provenance: {
          source: 'live',
          inputKind: 'issue',
          routerMode: 'survival',
        },
      });

      assert.equal(result.decisionPolicyVersion, 'stage-aware');
      assert.equal(result.operatingModeDependency, 'survival');
    });

    it('should include depth and mode in rationale', () => {
      const result = convertToRoutingDecision({
        planner: 'model-a',
        coder: 'model-b',
        reviewer: 'model-c',
        planDepth: 'light',
        codeDepth: 'medium',
        reviewMode: 'static',
      });

      assert.ok(result.decisionRationale.includes('planDepth=light'));
      assert.ok(result.decisionRationale.includes('codeDepth=medium'));
      assert.ok(result.decisionRationale.includes('reviewMode=static'));
    });

    it('should handle missing depth/mode fields', () => {
      const result = convertToRoutingDecision({
        planner: 'model-a',
        coder: 'model-b',
        reviewer: 'model-c',
      });

      assert.ok(result.decisionRationale.includes('planner=model-a'));
      assert.equal(result.decisionRationale.includes('planDepth'), false);
    });
  });

  describe('fetchRoutingDecision', () => {
    function makeTmpDir(): string {
      return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'eval-test-'));
    }

    it('should load valid routing file', () => {
      const tmpDir = makeTmpDir();
      const featureDir = nodePath.join(tmpDir, 'features', 'my-feature');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(featureDir, '.routing-complete'),
        JSON.stringify({
          planner: 'model-a',
          coder: 'model-b',
          reviewer: 'model-c',
          planDepth: 'light',
          codeDepth: 'medium',
          reviewMode: 'static',
        })
      );

      const result = fetchRoutingDecision(tmpDir, 'my-feature');

      assert.notEqual(result, null);
      assert.equal(result!.candidates.length, 3);
      assert.equal(result!.decisionPolicyVersion, 'baseline');
      assert.equal(result!.routeArtifactSchemaVersion, '1.1');
      assert.equal(result!.policyResolverVersion, '1.0.0');
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should derive stage-aware routing metadata from the routing file', () => {
      const tmpDir = makeTmpDir();
      const featureDir = nodePath.join(tmpDir, 'features', 'my-feature');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(featureDir, '.routing-complete'),
        JSON.stringify({
          planner: 'model-a',
          coder: 'model-b',
          reviewer: 'model-c',
          routingMode: 'stage-aware',
          provenance: {
            source: 'live',
            inputKind: 'issue',
            routerMode: 'survival',
          },
        })
      );

      const result = fetchRoutingDecision(tmpDir, 'my-feature');

      assert.notEqual(result, null);
      assert.equal(result!.decisionPolicyVersion, 'stage-aware');
      assert.equal(result!.routeMode, 'stage-aware');
      assert.equal(result!.operatingModeDependency, 'survival');
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should return null for missing file', () => {
      const tmpDir = makeTmpDir();
      fs.mkdirSync(nodePath.join(tmpDir, 'features', 'my-feature'), { recursive: true });

      const result = fetchRoutingDecision(tmpDir, 'my-feature');

      assert.equal(result, null);
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should return null for invalid JSON', () => {
      const tmpDir = makeTmpDir();
      const featureDir = nodePath.join(tmpDir, 'features', 'my-feature');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(nodePath.join(featureDir, '.routing-complete'), 'not json');

      const result = fetchRoutingDecision(tmpDir, 'my-feature');

      assert.equal(result, null);
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should return null when required fields missing', () => {
      const tmpDir = makeTmpDir();
      const featureDir = nodePath.join(tmpDir, 'features', 'my-feature');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(featureDir, '.routing-complete'),
        JSON.stringify({ planner: 'model-a' }) // missing coder and reviewer
      );

      const result = fetchRoutingDecision(tmpDir, 'my-feature');

      assert.equal(result, null);
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('fetchRoutingCompleteRawWithArchive', () => {
    function makeTmpDir(): string {
      return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'routing-complete-'));
    }

    it('returns worktree routing data when present', () => {
      const repoDir = makeTmpDir();
      const worktreeDir = nodePath.join(repoDir, 'worktree');
      const slug = 'my-feature';
      const issueId = 'HOK-1328';
      const featureDir = nodePath.join(worktreeDir, 'features', slug);
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(featureDir, '.routing-complete'),
        JSON.stringify({
          planner: 'model-a',
          coder: 'model-b',
          reviewer: 'model-c',
        }),
      );

      try {
        assert.deepEqual(fetchRoutingCompleteRawWithArchive(repoDir, slug, issueId, worktreeDir), {
          planner: 'model-a',
          coder: 'model-b',
          reviewer: 'model-c',
        });
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('falls back to archived routing data when worktree is missing', () => {
      const repoDir = makeTmpDir();
      const slug = 'my-feature';
      const issueId = 'HOK-1328';
      const archiveDir = nodePath.join(repoDir, '.wavemill', 'evals', 'artifacts', issueId);
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(archiveDir, 'routing-complete.json'),
        JSON.stringify({
          planner: 'model-a',
          coder: 'model-b',
          reviewer: 'model-c',
        }),
      );

      try {
        assert.deepEqual(fetchRoutingCompleteRawWithArchive(repoDir, slug, issueId), {
          planner: 'model-a',
          coder: 'model-b',
          reviewer: 'model-c',
        });
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('returns null for malformed archived routing data', () => {
      const repoDir = makeTmpDir();
      const issueId = 'HOK-1328';
      const archiveDir = nodePath.join(repoDir, '.wavemill', 'evals', 'artifacts', issueId);
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(nodePath.join(archiveDir, 'routing-complete.json'), '{"planner":true}');

      try {
        assert.equal(fetchRoutingCompleteRawWithArchive(repoDir, 'my-feature', issueId), null);
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('preserves maxCostUsd from archived routing data', () => {
      const repoDir = makeTmpDir();
      const issueId = 'HOK-1328';
      const archiveDir = nodePath.join(repoDir, '.wavemill', 'evals', 'artifacts', issueId);
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(archiveDir, 'routing-complete.json'),
        JSON.stringify({
          planner: 'model-a',
          coder: 'model-b',
          reviewer: 'model-c',
          maxCostUsd: 7.5,
        }),
      );

      try {
        assert.deepEqual(fetchRoutingCompleteRawWithArchive(repoDir, 'my-feature', issueId), {
          planner: 'model-a',
          coder: 'model-b',
          reviewer: 'model-c',
          maxCostUsd: 7.5,
        });
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });

  describe('gatherStageArtifacts archived routing', () => {
    function makeTmpDir(): string {
      return fs.mkdtempSync(nodePath.join(os.tmpdir(), 'stage-artifacts-'));
    }

    it('converts archived raw routing data into a routing decision', () => {
      const repoDir = makeTmpDir();
      const issueId = 'HOK-1494';
      const branch = 'task/fix-archived-routing';
      const featureDir = nodePath.join(repoDir, 'features', 'fix-archived-routing');
      const archiveDir = nodePath.join(repoDir, '.wavemill', 'evals', 'artifacts', issueId);
      fs.mkdirSync(featureDir, { recursive: true });
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(archiveDir, 'routing-complete.json'),
        JSON.stringify({
          planner: 'model-a',
          coder: 'model-b',
          reviewer: 'model-c',
          expectedSuccess: 0.8,
          expectedCost: 2.5,
          confidence: 0.7,
          reasoning: ['repo risk', 'balanced route'],
          signals: {
            taskType: 'feature',
            riskScore: 0.4,
            taskDifficulty: 'medium',
          },
          codeDepth: 'deep',
          reviewMode: 'static+llm',
        }),
      );
      fs.writeFileSync(
        nodePath.join(featureDir, '.planning-result.json'),
        JSON.stringify({
          stage: 'planning',
          status: 'completed',
          agent: 'codex',
          model: 'claude-sonnet-4-6',
          startedAt: '2026-05-31T10:00:00.000Z',
          finishedAt: '2026-05-31T10:02:00.000Z',
        }),
      );

      try {
        const result = gatherStageArtifacts(repoDir, issueId, branch);
        assert.deepEqual(result.routingDecision, {
          candidates: [
            { agentType: 'claude', modelId: 'model-a' },
            { agentType: 'claude', modelId: 'model-b' },
            { agentType: 'claude', modelId: 'model-c' },
          ],
          chosen: { agentType: 'claude', modelId: 'model-b' },
          decisionPolicyVersion: 'baseline',
          decisionRationale:
            'Routing: planner=model-a, coder=model-b, reviewer=model-c; codeDepth=deep, reviewMode=static+llm',
          routeArtifactSchemaVersion: '1.1',
          policyResolverVersion: '1.0.0',
        });
        assert.deepEqual(result.routePrediction, {
          expectedSuccess: 0.8,
          expectedCostUsd: 2.5,
          confidence: 0.7,
          riskScore: 0.4,
          taskType: 'feature',
          taskDifficulty: 'medium',
          topFeatures: ['repo risk', 'balanced route', 'taskType=feature', 'taskDifficulty=medium', 'riskScore=0.4'],
          rationaleSummary: 'repo risk balanced route',
        });
        assert.deepEqual(result.executedPlanning, {
          agent: 'codex',
          model: 'claude-sonnet-4-6',
          status: 'completed',
          source: '.planning-result.json',
        });
        assert.deepEqual(result.planningExecutionOutcome, {
          agent: 'codex',
          model: 'claude-sonnet-4-6',
          status: 'completed',
          source: '.planning-result.json',
        });
        assert.deepEqual(result.phaseDurations, {
          planning: 120,
          total: 120,
        });
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('omits routingDecision when archived routing data is malformed', () => {
      const repoDir = makeTmpDir();
      const issueId = 'HOK-1494';
      const branch = 'task/fix-archived-routing';
      const archiveDir = nodePath.join(repoDir, '.wavemill', 'evals', 'artifacts', issueId);
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(nodePath.join(archiveDir, 'routing-complete.json'), '{"planner":true}');

      try {
        const result = gatherStageArtifacts(repoDir, issueId, branch);
        assert.equal(result.routingDecision, undefined);
        assert.equal(result.routePrediction, undefined);
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('loads latest per-role resolved-model routing from archived routing.jsonl', () => {
      const repoDir = makeTmpDir();
      const issueId = 'HOK-1632';
      const branch = 'task/emit-routing';
      const archiveDir = nodePath.join(repoDir, '.wavemill', 'evals', 'artifacts', issueId);
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(archiveDir, 'routing.jsonl'),
        [
          JSON.stringify({
            role: 'planner',
            requestedSelector: { kind: 'pinned', modelId: 'gpt-5.5' },
            resolvedModelId: 'gpt-5.5',
            sourceLayer: 'user',
          }),
          JSON.stringify({
            role: 'planner',
            requestedSelector: { kind: 'pinned', modelId: 'gpt-5.4' },
            resolvedModelId: 'gpt-5.4',
            sourceLayer: 'policy',
          }),
          'not json',
          JSON.stringify({
            role: 'reviewer',
            requestedSelector: { kind: 'pinned', modelId: 'claude-sonnet-4-6' },
            resolvedModelId: 'claude-sonnet-4-6',
            sourceLayer: 'user',
          }),
        ].join('\n'),
      );

      try {
        const result = gatherStageArtifacts(repoDir, issueId, branch);
        assert.equal(result.routing?.planner?.resolvedModelId, 'gpt-5.4');
        assert.equal(result.routing?.reviewer?.resolvedModelId, 'claude-sonnet-4-6');
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('omits executed planning when planning-result is malformed', () => {
      const repoDir = makeTmpDir();
      const issueId = 'HOK-1728';
      const branch = 'task/clarify-routing';
      const featureDir = nodePath.join(repoDir, 'features', 'clarify-routing');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(nodePath.join(featureDir, '.planning-result.json'), 'not json');

      try {
        const result = gatherStageArtifacts(repoDir, issueId, branch);
        assert.equal(result.executedPlanning, undefined);
        assert.equal(result.planningExecutionOutcome, undefined);
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('loads structured successful planning execution outcome', () => {
      const repoDir = makeTmpDir();
      const issueId = 'HOK-2593';
      const branch = 'task/capture-planning-outcome';
      const featureDir = nodePath.join(repoDir, 'features', 'capture-planning-outcome');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(featureDir, '.planning-result.json'),
        JSON.stringify({
          stage: 'planning',
          status: 'awaiting_user',
          agent: 'native',
          model: 'claude-sonnet-5',
          failureReason: null,
          artifacts: {
            type: 'planning',
            planArtifactValid: true,
            approvalReady: true,
            bounds: {
              maxTurns: 40,
              maxToolCalls: 120,
              maxWallClockMs: 1200000,
            },
            usage: {
              turnsCompleted: 12,
              toolCallsExecuted: 31,
              wallClockMs: 300000,
              totalInputTokens: 10000,
              totalOutputTokens: 2000,
              totalCostUsd: 0.25,
            },
            promptRef: {
              id: 'native-planning',
              version: 'sha256:abc',
            },
          },
        }),
      );

      try {
        const result = gatherStageArtifacts(repoDir, issueId, branch);
        assert.deepEqual(result.planningExecutionOutcome, {
          agent: 'native',
          model: 'claude-sonnet-5',
          status: 'awaiting_user',
          failureReason: null,
          planArtifactValid: true,
          approvalReady: true,
          bounds: {
            maxTurns: 40,
            maxToolCalls: 120,
            maxWallClockMs: 1200000,
          },
          usage: {
            turnsCompleted: 12,
            toolCallsExecuted: 31,
            wallClockMs: 300000,
            totalInputTokens: 10000,
            totalOutputTokens: 2000,
            totalCostUsd: 0.25,
          },
          promptRef: {
            id: 'native-planning',
            version: 'sha256:abc',
          },
          source: '.planning-result.json',
        });
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });

    it('loads structured turn_limit planning execution outcome', () => {
      const repoDir = makeTmpDir();
      const issueId = 'HOK-2593';
      const branch = 'task/planner-hit-limit';
      const featureDir = nodePath.join(repoDir, 'features', 'planner-hit-limit');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(featureDir, '.planning-result.json'),
        JSON.stringify({
          stage: 'planning',
          status: 'failed',
          agent: 'native',
          model: 'moonshotai/kimi-k2.7-code',
          failureReason: 'turn_limit',
          artifacts: {
            type: 'planning',
            planArtifactValid: false,
            approvalReady: false,
            bounds: { maxTurns: 40 },
            usage: { turnsCompleted: 40, toolCallsExecuted: 72 },
          },
        }),
      );

      try {
        const result = gatherStageArtifacts(repoDir, issueId, branch);
        assert.deepEqual(result.planningExecutionOutcome, {
          agent: 'native',
          model: 'moonshotai/kimi-k2.7-code',
          status: 'failed',
          failureReason: 'turn_limit',
          planArtifactValid: false,
          approvalReady: false,
          bounds: { maxTurns: 40 },
          usage: { turnsCompleted: 40, toolCallsExecuted: 72 },
          source: '.planning-result.json',
        });
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});
