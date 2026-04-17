/**
 * Unit tests for task descriptor builder.
 *
 * Tests heuristic signal derivation, learned signal derivation,
 * constraints derivation, per-stage derivation, and outcome derivation.
 *
 * @module task-descriptor-builder.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskDescriptor } from './task-descriptor-builder.ts';
import type { TaskDescriptorInput } from './task-descriptor-builder.ts';
import type { RoutingCompleteData } from './eval-context-gatherer.ts';

describe('task-descriptor-builder', () => {
  describe('buildTaskDescriptor', () => {
    it('should build minimal descriptor with only originalPrompt', () => {
      const input: TaskDescriptorInput = {
        originalPrompt: 'Add a new user authentication feature',
      };

      const descriptor = buildTaskDescriptor(input);

      assert.equal(descriptor.schema_version, '1.0');
      assert.ok(descriptor.signals.heuristic);
      assert.ok(descriptor.signals.learned);
      assert.ok(descriptor.constraints);
      assert.ok(descriptor.stages);
      assert.equal(descriptor.outcome, undefined); // No score, so outcome is undefined
    });

    it('should derive heuristic signals from task context and repo context', () => {
      const input: TaskDescriptorInput = {
        originalPrompt: 'Add React component for user profile page',
        taskContext: {
          taskType: 'feature',
          changeKind: 'create_new',
          complexity: 'm',
        },
        repoContext: {
          repoId: 'test-repo',
          repoVisibility: 'private',
          primaryLanguage: 'TypeScript',
          languages: { TypeScript: 80, JavaScript: 20 },
          frameworks: ['React', 'Next.js'],
          repoSize: { fileCount: 100, loc: 50000, dependencyCount: 50 },
        },
        difficultySignals: {
          locTouched: 150,
          filesTouched: 5,
        },
      };

      const descriptor = buildTaskDescriptor(input);
      const heuristic = descriptor.signals.heuristic;

      assert.equal(heuristic.task_type, 'feature');
      assert.deepEqual(heuristic.languages, ['typescript', 'javascript']);
      assert.deepEqual(heuristic.framework_tags, ['react', 'next.js']);
      assert.equal(heuristic.files_touched, 5);
      assert.equal(heuristic.repo_size_loc, 50000);
      assert.equal(heuristic.is_greenfield, true);
      assert.equal(heuristic.has_ui, true);
      assert.equal(heuristic.has_migration, false);
    });

    it('should detect migration keywords', () => {
      const input: TaskDescriptorInput = {
        originalPrompt: 'Add prisma migrate for user table schema change',
        taskContext: {
          taskType: 'feature',
          changeKind: 'modify_existing',
          complexity: 's',
        },
      };

      const descriptor = buildTaskDescriptor(input);

      assert.equal(descriptor.signals.heuristic.has_migration, true);
    });

    it('should detect UI keywords and file extensions', () => {
      const input: TaskDescriptorInput = {
        originalPrompt: 'Build a new React component',
        repoContext: {
          repoId: 'test-repo',
          repoVisibility: 'private',
          primaryLanguage: 'TypeScript',
          languages: { TypeScript: 100 },
        },
      };

      const descriptor = buildTaskDescriptor(input);

      assert.equal(descriptor.signals.heuristic.has_ui, true);
    });

    it('should detect test keywords in prompt', () => {
      const input: TaskDescriptorInput = {
        originalPrompt: 'Add unit tests for the authentication module',
        taskContext: {
          taskType: 'test',
          changeKind: 'create_new',
          complexity: 's',
        },
      };

      const descriptor = buildTaskDescriptor(input);

      assert.equal(descriptor.signals.heuristic.has_tests, true);
    });

    it('should detect test files in diff', () => {
      const input: TaskDescriptorInput = {
        originalPrompt: 'Fix authentication bug',
        prDiff: '+++ src/auth.test.ts\n-test("should authenticate", () => {',
      };

      const descriptor = buildTaskDescriptor(input);

      assert.equal(descriptor.signals.heuristic.has_tests, true);
    });

    it('should detect cross-service keywords', () => {
      const input: TaskDescriptorInput = {
        originalPrompt: 'Update cross-service communication between auth and billing',
        taskContext: {
          taskType: 'feature',
          changeKind: 'modify_existing',
          complexity: 'l',
        },
      };

      const descriptor = buildTaskDescriptor(input);

      assert.equal(descriptor.signals.heuristic.cross_service, true);
    });

    it('should map complexity band to numeric 1-5', () => {
      const testCases = [
        { band: 'xs' as const, expected: 1 },
        { band: 's' as const, expected: 2 },
        { band: 'm' as const, expected: 3 },
        { band: 'l' as const, expected: 4 },
        { band: 'xl' as const, expected: 5 },
      ];

      for (const { band, expected } of testCases) {
        const input: TaskDescriptorInput = {
          originalPrompt: 'Test task',
          taskContext: {
            taskType: 'feature',
            changeKind: 'create_new',
            complexity: band,
          },
        };

        const descriptor = buildTaskDescriptor(input);
        assert.equal(descriptor.signals.learned.complexity, expected);
      }
    });

    it('should map numeric complexity to 1-5 scale', () => {
      const input: TaskDescriptorInput = {
        originalPrompt: 'Test task',
        taskContext: {
          taskType: 'feature',
          changeKind: 'create_new',
          complexity: 0.7, // Should map to ~4
        },
      };

      const descriptor = buildTaskDescriptor(input);
      assert.ok(descriptor.signals.learned.complexity >= 1);
      assert.ok(descriptor.signals.learned.complexity <= 5);
    });

    it('should classify domain as frontend for React tasks', () => {
      const input: TaskDescriptorInput = {
        originalPrompt: 'Build React component for user dashboard',
        repoContext: {
          repoId: 'test-repo',
          repoVisibility: 'private',
          primaryLanguage: 'TypeScript',
          frameworks: ['React', 'Next.js'],
        },
      };

      const descriptor = buildTaskDescriptor(input);
      assert.equal(descriptor.signals.learned.domain, 'frontend');
    });

    it('should classify domain as backend for API tasks', () => {
      const input: TaskDescriptorInput = {
        originalPrompt: 'Add FastAPI endpoint for user authentication',
        repoContext: {
          repoId: 'test-repo',
          repoVisibility: 'private',
          primaryLanguage: 'Python',
          frameworks: ['FastAPI'],
        },
      };

      const descriptor = buildTaskDescriptor(input);
      assert.equal(descriptor.signals.learned.domain, 'backend');
    });

    it('should classify domain as full-stack when both frontend and backend', () => {
      const input: TaskDescriptorInput = {
        originalPrompt: 'Add React component and API endpoint for user profile',
        repoContext: {
          repoId: 'test-repo',
          repoVisibility: 'private',
          primaryLanguage: 'TypeScript',
          frameworks: ['React', 'Express'],
        },
      };

      const descriptor = buildTaskDescriptor(input);
      assert.equal(descriptor.signals.learned.domain, 'full-stack');
    });

    it('should extract risk flags', () => {
      const input: TaskDescriptorInput = {
        originalPrompt: 'Modify production runtime configuration and add schema migration',
        difficultySignals: {
          locTouched: 200,
          filesTouched: 15,
        },
      };

      const descriptor = buildTaskDescriptor(input);
      const riskFlags = descriptor.signals.learned.risk_flags;

      assert.ok(riskFlags.includes('modifies-existing-runtime'));
      assert.ok(riskFlags.includes('schema-migration'));
      assert.ok(riskFlags.includes('large-scope-refactor'));
    });

    it('should derive constraints with defaults', () => {
      const input: TaskDescriptorInput = {
        originalPrompt: 'Test task',
        modelsAvailable: ['claude-opus-4-6', 'claude-sonnet-4-5-20250929'],
        objective: 'max_success',
        maxCostUsd: 10.0,
        maxTimeMinutes: 30,
      };

      const descriptor = buildTaskDescriptor(input);
      const constraints = descriptor.constraints;

      assert.deepEqual(constraints.models_available, [
        'claude-opus-4-6',
        'claude-sonnet-4-5-20250929',
      ]);
      assert.equal(constraints.objective, 'max_success');
      assert.equal(constraints.max_cost_usd, 10.0);
      assert.equal(constraints.max_time_minutes, 30);
    });

    it('should derive per-stage descriptors from routing complete', () => {
      const routingComplete: RoutingCompleteData = {
        planner: 'claude-opus-4-6',
        coder: 'claude-sonnet-4-5-20250929',
        reviewer: 'claude-haiku-4-5-20251001',
      };

      const input: TaskDescriptorInput = {
        originalPrompt: 'Test task',
        routingComplete,
        stageOutcomes: {
          plan: { score: 0.95, rationale: 'Excellent plan' },
          implementation: { score: 0.88, rationale: 'Good implementation' },
          review: { score: 0.92, rationale: 'Thorough review' },
        },
        workflowTokenUsage: {
          'claude-opus-4-6': {
            inputTokens: 1000,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 500,
            costUsd: 2.1,
          },
          'claude-sonnet-4-5-20250929': {
            inputTokens: 2000,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 1000,
            costUsd: 8.4,
          },
          'claude-haiku-4-5-20251001': {
            inputTokens: 500,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 200,
            costUsd: 0.6,
          },
        },
      };

      const descriptor = buildTaskDescriptor(input);
      const stages = descriptor.stages;

      assert.equal(stages.planner.model, 'claude-opus-4-6');
      assert.equal(stages.planner.score, 0.95);
      assert.equal(stages.planner.cost_usd, 2.1);

      assert.equal(stages.coder.model, 'claude-sonnet-4-5-20250929');
      assert.equal(stages.coder.score, 0.88);
      assert.equal(stages.coder.cost_usd, 8.4);

      assert.equal(stages.reviewer.model, 'claude-haiku-4-5-20251001');
      assert.equal(stages.reviewer.score, 0.92);
      assert.equal(stages.reviewer.cost_usd, 0.6);
    });

    it('should derive stages from archive-rehydrated routing data', () => {
      const archivedRoutingComplete: RoutingCompleteData = {
        planner: 'claude-opus-4-6',
        coder: 'claude-sonnet-4-5-20250929',
        reviewer: 'claude-haiku-4-5-20251001',
        maxCostUsd: 7.5,
      };

      const descriptor = buildTaskDescriptor({
        originalPrompt: 'Re-run eval after worktree cleanup',
        routingComplete: archivedRoutingComplete,
      });

      assert.equal(descriptor.stages.planner.model, 'claude-opus-4-6');
      assert.equal(descriptor.stages.coder.model, 'claude-sonnet-4-5-20250929');
      assert.equal(descriptor.stages.reviewer.model, 'claude-haiku-4-5-20251001');
      assert.equal(descriptor.constraints.max_cost_usd, undefined);
    });

    it('should populate outcome when score is available (post-eval)', () => {
      const input: TaskDescriptorInput = {
        originalPrompt: 'Test task',
        score: 0.9,
        workflowCost: 11.1,
        timeSeconds: 1440, // 24 minutes
        interventionCount: 1,
        interventions: [
          {
            timestamp: '2025-01-01T00:00:00Z',
            type: 'bugfix',
            severity: 'low',
            note: 'Fixed import path',
          },
        ],
      };

      const descriptor = buildTaskDescriptor(input);
      const outcome = descriptor.outcome;

      assert.ok(outcome);
      assert.equal(outcome.overall_score, 0.9);
      assert.equal(outcome.total_cost_usd, 11.1);
      assert.equal(outcome.total_time_minutes, 24);
      assert.equal(outcome.interventions, 1);
      assert.deepEqual(outcome.intervention_types, ['bugfix']);
    });

    it('should not populate outcome when score is unavailable (pre-eval)', () => {
      const input: TaskDescriptorInput = {
        originalPrompt: 'Test task',
        // No score provided
      };

      const descriptor = buildTaskDescriptor(input);

      assert.equal(descriptor.outcome, undefined);
    });

    it('should handle full descriptor with all fields populated', () => {
      const routingComplete: RoutingCompleteData = {
        planner: 'claude-opus-4-6',
        coder: 'claude-sonnet-4-5-20250929',
        reviewer: 'claude-haiku-4-5-20251001',
      };

      const input: TaskDescriptorInput = {
        originalPrompt: 'Add React component with FastAPI backend and tests',
        prDiff: '+++ src/components/UserProfile.tsx\n+++ src/api/users.py\n+++ tests/test_users.py',
        taskContext: {
          taskType: 'feature',
          changeKind: 'create_new',
          complexity: 'l',
        },
        repoContext: {
          repoId: 'test-repo',
          repoVisibility: 'private',
          primaryLanguage: 'TypeScript',
          languages: { TypeScript: 60, Python: 40 },
          frameworks: ['React', 'FastAPI'],
          repoSize: { fileCount: 200, loc: 75000, dependencyCount: 100 },
        },
        difficultySignals: {
          locTouched: 350,
          filesTouched: 12,
        },
        routingComplete,
        stageOutcomes: {
          plan: { score: 0.95, rationale: 'Excellent plan' },
          implementation: { score: 0.88, rationale: 'Good implementation' },
          review: { score: 0.92, rationale: 'Thorough review' },
        },
        workflowCost: 11.1,
        workflowTokenUsage: {
          'claude-opus-4-6': {
            inputTokens: 1000,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 500,
            costUsd: 2.1,
          },
          'claude-sonnet-4-5-20250929': {
            inputTokens: 2000,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 1000,
            costUsd: 8.4,
          },
          'claude-haiku-4-5-20251001': {
            inputTokens: 500,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 200,
            costUsd: 0.6,
          },
        },
        score: 0.9,
        timeSeconds: 1440,
        interventionCount: 1,
        interventions: [
          {
            timestamp: '2025-01-01T00:00:00Z',
            type: 'bugfix',
            severity: 'low',
            note: 'Fixed import path',
          },
        ],
        modelsAvailable: ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5-20251001'],
        objective: 'balanced',
        maxCostUsd: 15.0,
        maxTimeMinutes: 45,
      };

      const descriptor = buildTaskDescriptor(input);

      // Validate structure
      assert.equal(descriptor.schema_version, '1.0');

      // Heuristic signals
      assert.equal(descriptor.signals.heuristic.task_type, 'feature');
      assert.equal(descriptor.signals.heuristic.files_touched, 12);
      assert.equal(descriptor.signals.heuristic.repo_size_loc, 75000);
      assert.equal(descriptor.signals.heuristic.is_greenfield, true);
      assert.equal(descriptor.signals.heuristic.has_ui, true);
      assert.equal(descriptor.signals.heuristic.has_tests, true);

      // Learned signals
      assert.equal(descriptor.signals.learned.complexity, 4); // l → 4
      assert.equal(descriptor.signals.learned.domain, 'full-stack');

      // Constraints
      assert.equal(descriptor.constraints.objective, 'balanced');
      assert.equal(descriptor.constraints.max_cost_usd, 15.0);

      // Stages
      assert.equal(descriptor.stages.planner.model, 'claude-opus-4-6');
      assert.equal(descriptor.stages.coder.model, 'claude-sonnet-4-5-20250929');
      assert.equal(descriptor.stages.reviewer.model, 'claude-haiku-4-5-20251001');

      // Outcome
      assert.ok(descriptor.outcome);
      assert.equal(descriptor.outcome.overall_score, 0.9);
      assert.equal(descriptor.outcome.total_cost_usd, 11.1);
      assert.equal(descriptor.outcome.interventions, 1);
    });
  });
});
