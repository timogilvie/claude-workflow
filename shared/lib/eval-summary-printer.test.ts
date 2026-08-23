/**
 * Tests for eval-summary-printer module.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EvalRecord } from './eval-schema.ts';
import {
  formatScoreDisplay,
  formatCostDisplay,
  formatInterventionDisplay,
  formatDifficultyDisplay,
  formatTaskContextDisplay,
  formatRepoContextDisplay,
  formatRouteProvenanceDisplay,
  formatWorkflowCostOutcome,
  printEvalSummary,
} from './eval-summary-printer.ts';

describe('eval-summary-printer', () => {
  describe('formatScoreDisplay', () => {
    it('should format score with band', () => {
      assert.equal(formatScoreDisplay(0.95, 'excellent'), 'excellent (0.95)');
    });

    it('should round to 2 decimal places', () => {
      assert.equal(formatScoreDisplay(0.8567, 'good'), 'good (0.86)');
    });

    it('should handle zero score', () => {
      assert.equal(formatScoreDisplay(0, 'poor'), 'poor (0.00)');
    });
  });

  describe('formatCostDisplay', () => {
    it('should format cost with 4 decimal places', () => {
      assert.equal(formatCostDisplay(0.1234), ', workflow cost: $0.1234');
    });

    it('should handle small costs', () => {
      assert.equal(formatCostDisplay(0.0001), ', workflow cost: $0.0001');
    });

    it('should return empty string when cost is undefined', () => {
      assert.equal(formatCostDisplay(undefined), '');
    });

    it('should handle zero cost', () => {
      assert.equal(formatCostDisplay(0), ', workflow cost: $0.0000');
    });
  });

  describe('formatInterventionDisplay', () => {
    it('should format single intervention', () => {
      assert.equal(formatInterventionDisplay(1), '1 intervention(s) detected');
    });

    it('should format multiple interventions', () => {
      assert.equal(formatInterventionDisplay(5), '5 intervention(s) detected');
    });

    it('should handle no interventions', () => {
      assert.equal(formatInterventionDisplay(0), 'no interventions detected');
    });
  });

  describe('formatDifficultyDisplay', () => {
    it('should format difficulty info', () => {
      const result = formatDifficultyDisplay('medium', 150, 5, 'stratum-2', false);
      assert.equal(result, 'difficulty medium (150 LOC, 5 files, stratum: stratum-2)');
    });

    it('should include uncertain warning when diff is uncertain', () => {
      const result = formatDifficultyDisplay('hard', 300, 10, 'stratum-3', true);
      assert.ok(result.includes('⚠ UNCERTAIN — diff may be incomplete'));
    });
  });

  describe('formatTaskContextDisplay', () => {
    it('should format task context info', () => {
      const result = formatTaskContextDisplay('feature', 'new-feature', 'medium');
      assert.equal(result, 'task context feature / new-feature / complexity medium');
    });

    it('should handle bug type', () => {
      const result = formatTaskContextDisplay('bug', 'bugfix', 'low');
      assert.equal(result, 'task context bug / bugfix / complexity low');
    });
  });

  describe('formatRepoContextDisplay', () => {
    it('should format repo context info', () => {
      const result = formatRepoContextDisplay('TypeScript', 'private', 100);
      assert.equal(result, 'repo context TypeScript / private / 100 files');
    });

    it('should handle public repos', () => {
      const result = formatRepoContextDisplay('JavaScript', 'public', 50);
      assert.equal(result, 'repo context JavaScript / public / 50 files');
    });
  });

  describe('formatWorkflowCostOutcome', () => {
    it('should format cost outcome with single session', () => {
      const result = formatWorkflowCostOutcome(0.1234, 10, 1);
      assert.equal(result, 'workflow cost $0.1234 (10 turns across 1 session(s))');
    });

    it('should format cost outcome with multiple sessions', () => {
      const result = formatWorkflowCostOutcome(0.5678, 25, 3);
      assert.equal(result, 'workflow cost $0.5678 (25 turns across 3 session(s))');
    });
  });

  describe('formatRouteProvenanceDisplay', () => {
    it('should return empty string when route provenance is absent', () => {
      assert.equal(formatRouteProvenanceDisplay({} as EvalRecord), '');
    });

    it('should format active route provenance compactly', () => {
      const record = {
        routeProvenance: {
          decisionSource: 'expanded',
          activeRoute: {
            coder: 'gpt-5.4',
            codeDepth: 'deep',
            reviewer: 'claude-sonnet-5',
            reviewMode: 'static',
          },
          routeChanged: true,
        },
      } as EvalRecord;

      assert.equal(
        formatRouteProvenanceDisplay(record),
        ', route: expanded gpt-5.4/deep/claude-sonnet-5/static changed=true',
      );
    });
  });

  describe('printEvalSummary', () => {
    let originalConsoleLog: typeof console.log;
    let consoleLogCalls: unknown[][];

    beforeEach(() => {
      originalConsoleLog = console.log;
      consoleLogCalls = [];
      console.log = (...args: unknown[]) => {
        consoleLogCalls.push(args);
      };
    });

    afterEach(() => {
      console.log = originalConsoleLog;
    });

    it('should print summary with cost', () => {
      const record: EvalRecord = {
        id: 'test-id',
        timestamp: '2026-03-02T12:00:00Z',
        score: 0.95,
        scoreBand: 'excellent',
        reasoning: 'Test reasoning',
        taskPrompt: 'Test task',
        prReviewOutput: 'Test PR',
        schemaVersion: '1.0.0',
        workflowCost: 0.1234,
      } as EvalRecord;

      printEvalSummary(record);

      assert.deepEqual(consoleLogCalls, [
        ['Post-completion eval: excellent (0.95), workflow cost: $0.1234 — saved to eval store'],
      ]);
    });

    it('should print summary with route provenance', () => {
      const record: EvalRecord = {
        id: 'test-id',
        timestamp: '2026-03-02T12:00:00Z',
        score: 0.95,
        scoreBand: 'excellent',
        reasoning: 'Test reasoning',
        taskPrompt: 'Test task',
        prReviewOutput: 'Test PR',
        schemaVersion: '1.18.0',
        routeProvenance: {
          decisionSource: 'expanded',
          activeRoute: {
            coder: 'gpt-5.4',
            codeDepth: 'deep',
            reviewer: 'claude-sonnet-5',
            reviewMode: 'static',
          },
          routeChanged: true,
        },
      } as EvalRecord;

      printEvalSummary(record);

      assert.deepEqual(consoleLogCalls, [
        ['Post-completion eval: excellent (0.95), route: expanded gpt-5.4/deep/claude-sonnet-5/static changed=true — saved to eval store'],
      ]);
    });

    it('should print summary without cost', () => {
      const record: EvalRecord = {
        id: 'test-id',
        timestamp: '2026-03-02T12:00:00Z',
        score: 0.85,
        scoreBand: 'good',
        reasoning: 'Test reasoning',
        taskPrompt: 'Test task',
        prReviewOutput: 'Test PR',
        schemaVersion: '1.0.0',
      } as EvalRecord;

      printEvalSummary(record);

      assert.deepEqual(consoleLogCalls, [
        ['Post-completion eval: good (0.85) — saved to eval store'],
      ]);
    });

    it('should use custom prefix', () => {
      const record: EvalRecord = {
        id: 'test-id',
        timestamp: '2026-03-02T12:00:00Z',
        score: 0.75,
        scoreBand: 'fair',
        reasoning: 'Test reasoning',
        taskPrompt: 'Test task',
        prReviewOutput: 'Test PR',
        schemaVersion: '1.0.0',
      } as EvalRecord;

      printEvalSummary(record, 'Custom prefix');

      assert.deepEqual(consoleLogCalls, [
        ['Custom prefix: fair (0.75) — saved to eval store'],
      ]);
    });
  });
});
