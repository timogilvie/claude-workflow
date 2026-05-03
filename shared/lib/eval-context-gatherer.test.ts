/**
 * Tests for eval-context-gatherer module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import * as shellUtils from './shell-utils.ts';
import {
  computeWallClockSeconds,
  fetchIssueData,
  formatIssueAsPrompt,
  fetchPrContext,
  gatherEvalContext,
  gatherStageArtifacts,
  convertToRoutingDecision,
  fetchRoutingDecision,
  fetchRoutingCompleteRawWithArchive,
} from './eval-context-gatherer.ts';

// Mock shell-utils
vi.mock('./shell-utils.ts', () => ({
  escapeShellArg: (arg: string) => `'${arg}'`,
  execShellCommand: vi.fn(),
}));

describe('eval-context-gatherer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fetchIssueData', () => {
    it('should fetch and parse issue data', () => {
      const mockIssue = {
        identifier: 'HOK-870',
        title: 'Test Issue',
        description: 'Test description',
      };

      vi.mocked(shellUtils.execShellCommand).mockReturnValue(
        JSON.stringify(mockIssue)
      );

      const result = fetchIssueData('HOK-870', '/repo');

      expect(result).toEqual(mockIssue);
      expect(shellUtils.execShellCommand).toHaveBeenCalledWith(
        expect.stringContaining('HOK-870'),
        expect.objectContaining({ cwd: '/repo' })
      );
    });

    it('should return null on fetch failure', () => {
      vi.mocked(shellUtils.execShellCommand).mockImplementation(() => {
        throw new Error('fetch failed');
      });

      const result = fetchIssueData('HOK-870', '/repo');

      expect(result).toBeNull();
    });

    it('should return null on JSON parse failure', () => {
      vi.mocked(shellUtils.execShellCommand).mockReturnValue('invalid json');

      const result = fetchIssueData('HOK-870', '/repo');

      expect(result).toBeNull();
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

      expect(result).toContain('HOK-870: Test Issue');
      expect(result).toContain('Test description');
    });

    it('should handle missing description', () => {
      const issue = {
        identifier: 'HOK-870',
        title: 'Test Issue',
      };

      const result = formatIssueAsPrompt(issue, 'HOK-870');

      expect(result).toContain('HOK-870: Test Issue');
    });

    it('should handle null issue', () => {
      const result = formatIssueAsPrompt(null, 'HOK-870');

      expect(result).toBe('Issue: HOK-870 (details unavailable)');
    });
  });

  describe('fetchPrContext', () => {
    it('should fetch PR URL and diff', () => {
      vi.mocked(shellUtils.execShellCommand)
        .mockReturnValueOnce('https://github.com/user/repo/pull/123')
        .mockReturnValueOnce('diff --git a/file.ts b/file.ts\n...');

      const result = fetchPrContext('123', '/repo');

      expect(result.url).toBe('https://github.com/user/repo/pull/123');
      expect(result.diff).toContain('diff --git');
    });

    it('should handle URL fetch failure gracefully', () => {
      vi.mocked(shellUtils.execShellCommand)
        .mockImplementationOnce(() => { throw new Error('failed'); })
        .mockReturnValueOnce('diff content');

      const result = fetchPrContext('123', '/repo');

      expect(result.url).toBe('');
      expect(result.diff).toBe('diff content');
    });

    it('should handle diff fetch failure gracefully', () => {
      vi.mocked(shellUtils.execShellCommand)
        .mockReturnValueOnce('https://github.com/user/repo/pull/123')
        .mockImplementationOnce(() => { throw new Error('failed'); });

      const result = fetchPrContext('123', '/repo');

      expect(result.url).toBe('https://github.com/user/repo/pull/123');
      expect(result.diff).toBe('(PR diff unavailable)');
    });

    it('should handle both fetch failures gracefully', () => {
      vi.mocked(shellUtils.execShellCommand).mockImplementation(() => {
        throw new Error('failed');
      });

      const result = fetchPrContext('123', '/repo');

      expect(result.url).toBe('');
      expect(result.diff).toBe('(PR diff unavailable)');
    });
  });

  describe('gatherEvalContext', () => {
    it('should gather all context successfully', () => {
      const mockIssue = {
        identifier: 'HOK-870',
        title: 'Test Issue',
        description: 'Test description',
      };

      vi.mocked(shellUtils.execShellCommand)
        .mockReturnValueOnce(JSON.stringify(mockIssue)) // issue fetch
        .mockReturnValueOnce('https://github.com/user/repo/pull/123') // PR URL
        .mockReturnValueOnce('diff content'); // PR diff

      const result = gatherEvalContext({
        issueId: 'HOK-870',
        prNumber: '123',
        repoDir: '/repo',
      });

      expect(result.taskPrompt).toContain('HOK-870: Test Issue');
      expect(result.prDiff).toBe('diff content');
      expect(result.prUrl).toBe('https://github.com/user/repo/pull/123');
      expect(result.issueData).toEqual(mockIssue);
    });

    it('should use provided prUrl if given', () => {
      vi.mocked(shellUtils.execShellCommand)
        .mockReturnValueOnce('https://github.com/user/repo/pull/123') // PR URL (ignored)
        .mockReturnValueOnce('diff content'); // PR diff

      const result = gatherEvalContext({
        prNumber: '123',
        prUrl: 'https://custom.url',
        repoDir: '/repo',
      });

      expect(result.prUrl).toBe('https://custom.url');
    });

    it('should handle missing issueId', () => {
      vi.mocked(shellUtils.execShellCommand)
        .mockReturnValueOnce('https://github.com/user/repo/pull/123')
        .mockReturnValueOnce('diff content');

      const result = gatherEvalContext({
        prNumber: '123',
        repoDir: '/repo',
      });

      expect(result.taskPrompt).toBe('Issue:  (details unavailable)');
      expect(result.issueData).toBeNull();
    });

    it('should handle missing prNumber', () => {
      const mockIssue = {
        identifier: 'HOK-870',
        title: 'Test Issue',
        description: 'Test description',
      };

      vi.mocked(shellUtils.execShellCommand)
        .mockReturnValueOnce(JSON.stringify(mockIssue));

      const result = gatherEvalContext({
        issueId: 'HOK-870',
        repoDir: '/repo',
      });

      expect(result.prDiff).toBe('');
      expect(result.prUrl).toBe('');
    });

    it('should handle all fetch failures gracefully', () => {
      vi.mocked(shellUtils.execShellCommand).mockImplementation(() => {
        throw new Error('failed');
      });

      const result = gatherEvalContext({
        issueId: 'HOK-870',
        prNumber: '123',
        repoDir: '/repo',
      });

      expect(result.taskPrompt).toContain('details unavailable');
      expect(result.prDiff).toBe('(PR diff unavailable)');
      expect(result.prUrl).toBe('');
      expect(result.issueData).toBeNull();
    });
  });

  describe('computeWallClockSeconds', () => {
    it('should return null when git log is empty', () => {
      vi.mocked(shellUtils.execShellCommand).mockReturnValue('');

      const result = computeWallClockSeconds('/repo', 'task/test');

      expect(result).toBeNull();
      expect(shellUtils.execShellCommand).toHaveBeenCalledWith(
        expect.stringContaining("git log 'main'..'task/test' --format=\"%ct\" --reverse"),
        expect.objectContaining({ cwd: '/repo' })
      );
    });

    it('should return null for a single commit timestamp', () => {
      vi.mocked(shellUtils.execShellCommand).mockReturnValue('1710000000');

      const result = computeWallClockSeconds('/repo', 'task/test');

      expect(result).toBeNull();
    });

    it('should return the elapsed seconds for multiple commits', () => {
      vi.mocked(shellUtils.execShellCommand).mockReturnValue(
        '1710000000\n1710000015\n1710000120'
      );

      const result = computeWallClockSeconds('/repo', 'task/test');

      expect(result).toBe(120);
    });

    it('should ignore malformed timestamps when valid endpoints remain', () => {
      vi.mocked(shellUtils.execShellCommand).mockReturnValue(
        '1710000000\nnot-a-number\n1710000060\n0'
      );

      const result = computeWallClockSeconds('/repo', 'task/test');

      expect(result).toBe(60);
    });

    it('should return null on git errors', () => {
      vi.mocked(shellUtils.execShellCommand).mockImplementation(() => {
        throw new Error('git failed');
      });

      const result = computeWallClockSeconds('/repo', 'missing-branch');

      expect(result).toBeNull();
    });
  });

  describe('convertToRoutingDecision', () => {
    it('should build candidates from unique models', () => {
      const result = convertToRoutingDecision({
        planner: 'claude-sonnet-4-5-20250929',
        coder: 'claude-opus-4-6',
        reviewer: 'claude-haiku-4-5-20251001',
      });

      expect(result.candidates).toHaveLength(3);
      expect(result.candidates.map((c) => c.modelId)).toEqual([
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

      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.map((c) => c.modelId)).toEqual([
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

      expect(result.chosen).toEqual({
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

      expect(result.decisionPolicyVersion).toBe('baseline');
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

      expect(result.decisionRationale).toContain('planDepth=light');
      expect(result.decisionRationale).toContain('codeDepth=medium');
      expect(result.decisionRationale).toContain('reviewMode=static');
    });

    it('should handle missing depth/mode fields', () => {
      const result = convertToRoutingDecision({
        planner: 'model-a',
        coder: 'model-b',
        reviewer: 'model-c',
      });

      expect(result.decisionRationale).toContain('planner=model-a');
      expect(result.decisionRationale).not.toContain('planDepth');
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

      expect(result).not.toBeNull();
      expect(result!.candidates).toHaveLength(3);
      expect(result!.decisionPolicyVersion).toBe('baseline');
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should return null for missing file', () => {
      const tmpDir = makeTmpDir();
      fs.mkdirSync(nodePath.join(tmpDir, 'features', 'my-feature'), { recursive: true });

      const result = fetchRoutingDecision(tmpDir, 'my-feature');

      expect(result).toBeNull();
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('should return null for invalid JSON', () => {
      const tmpDir = makeTmpDir();
      const featureDir = nodePath.join(tmpDir, 'features', 'my-feature');
      fs.mkdirSync(featureDir, { recursive: true });
      fs.writeFileSync(nodePath.join(featureDir, '.routing-complete'), 'not json');

      const result = fetchRoutingDecision(tmpDir, 'my-feature');

      expect(result).toBeNull();
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

      expect(result).toBeNull();
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
        expect(fetchRoutingCompleteRawWithArchive(repoDir, slug, issueId, worktreeDir)).toEqual({
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
        expect(fetchRoutingCompleteRawWithArchive(repoDir, slug, issueId)).toEqual({
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
        expect(fetchRoutingCompleteRawWithArchive(repoDir, 'my-feature', issueId)).toBeNull();
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
        expect(fetchRoutingCompleteRawWithArchive(repoDir, 'my-feature', issueId)).toEqual({
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
      const archiveDir = nodePath.join(repoDir, '.wavemill', 'evals', 'artifacts', issueId);
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(archiveDir, 'routing-complete.json'),
        JSON.stringify({
          planner: 'model-a',
          coder: 'model-b',
          reviewer: 'model-c',
          codeDepth: 'deep',
          reviewMode: 'static+llm',
        }),
      );

      try {
        const result = gatherStageArtifacts(repoDir, issueId, branch);
        expect(result.routingDecision).toEqual({
          candidates: [
            { agentType: 'claude', modelId: 'model-a' },
            { agentType: 'claude', modelId: 'model-b' },
            { agentType: 'claude', modelId: 'model-c' },
          ],
          chosen: { agentType: 'claude', modelId: 'model-b' },
          decisionPolicyVersion: 'baseline',
          decisionRationale:
            'Routing: planner=model-a, coder=model-b, reviewer=model-c; codeDepth=deep, reviewMode=static+llm',
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
        expect(result.routingDecision).toBeUndefined();
      } finally {
        fs.rmSync(repoDir, { recursive: true, force: true });
      }
    });
  });
});
