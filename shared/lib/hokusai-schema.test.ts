/**
 * Unit tests for Hokusai schema adapters.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TaskDescriptor } from './eval-schema.ts';
import {
  complexityToHokusaiScore,
  descriptionLengthToBucket,
  filesTouchedToBucket,
  mapDomain,
  mapLanguage,
  mapTaskType,
  repoSizeToBucket,
  riskFlagsToBooleans,
  riskFlagsToLevel,
  toHokusaiInput,
} from './hokusai-schema.ts';

function makeDescriptor(overrides: Partial<TaskDescriptor> = {}): TaskDescriptor {
  return {
    schema_version: '1.0',
    signals: {
      heuristic: {
        task_type: 'feature',
        languages: ['typescript'],
        framework_tags: ['react'],
        files_touched: 4,
        repo_size_loc: 42_000,
        description_tokens: 120,
        is_greenfield: true,
        has_migration: false,
        has_ui: true,
        has_tests: true,
        cross_service: false,
      },
      learned: {
        complexity: 4,
        domain: 'frontend',
        risk_flags: [],
      },
    },
    constraints: {
      max_cost_usd: 12.5,
      models_available: ['gpt-5.4', 'gpt-5.3-codex'],
      objective: 'balanced',
    },
    stages: {},
    ...overrides,
  };
}

describe('hokusai-schema', () => {
  describe('complexityToHokusaiScore', () => {
    it('maps wavemill complexity bands to odd-numbered Hokusai scores', () => {
      assert.equal(complexityToHokusaiScore(1), 1);
      assert.equal(complexityToHokusaiScore(2), 3);
      assert.equal(complexityToHokusaiScore(3), 5);
      assert.equal(complexityToHokusaiScore(4), 7);
      assert.equal(complexityToHokusaiScore(5), 9);
    });

    it('defaults invalid complexity values to medium', () => {
      assert.equal(complexityToHokusaiScore(undefined), 5);
      assert.equal(complexityToHokusaiScore(0), 5);
      assert.equal(complexityToHokusaiScore(999), 5);
    });
  });

  describe('repoSizeToBucket', () => {
    it('buckets repository LOC at the expected boundaries', () => {
      assert.equal(repoSizeToBucket(4_999), 'small');
      assert.equal(repoSizeToBucket(5_000), 'medium');
      assert.equal(repoSizeToBucket(49_999), 'medium');
      assert.equal(repoSizeToBucket(50_000), 'large');
      assert.equal(repoSizeToBucket(499_999), 'large');
      assert.equal(repoSizeToBucket(500_000), 'xlarge');
    });

    it('defaults missing repo size to medium', () => {
      assert.equal(repoSizeToBucket(undefined), 'medium');
    });
  });

  describe('filesTouchedToBucket', () => {
    it('buckets file counts correctly', () => {
      assert.equal(filesTouchedToBucket(1), '1');
      assert.equal(filesTouchedToBucket(2), '2_5');
      assert.equal(filesTouchedToBucket(5), '2_5');
      assert.equal(filesTouchedToBucket(6), '6_15');
      assert.equal(filesTouchedToBucket(15), '6_15');
      assert.equal(filesTouchedToBucket(16), '16_plus');
    });

    it('defaults missing file counts to 2_5', () => {
      assert.equal(filesTouchedToBucket(undefined), '2_5');
      assert.equal(filesTouchedToBucket(0), '2_5');
    });
  });

  describe('descriptionLengthToBucket', () => {
    it('accepts token counts and raw text', () => {
      assert.equal(descriptionLengthToBucket(49), 'short');
      assert.equal(descriptionLengthToBucket(50), 'medium');
      assert.equal(descriptionLengthToBucket(199), 'medium');
      assert.equal(descriptionLengthToBucket(200), 'long');
      assert.equal(descriptionLengthToBucket('x'.repeat(40)), 'short');
      assert.equal(descriptionLengthToBucket('x'.repeat(400)), 'medium');
      assert.equal(descriptionLengthToBucket('x'.repeat(900)), 'long');
    });

    it('defaults missing length to medium', () => {
      assert.equal(descriptionLengthToBucket(undefined), 'medium');
    });
  });

  describe('risk mappings', () => {
    it('maps risk flags to risk levels', () => {
      assert.equal(riskFlagsToLevel(undefined), 'low');
      assert.equal(riskFlagsToLevel(['rsc-serialization']), 'low');
      assert.equal(riskFlagsToLevel(['schema-migration']), 'medium');
      assert.equal(
        riskFlagsToLevel(['schema-migration', 'cross-service']),
        'high',
      );
    });

    it('maps risk flags to fallback booleans', () => {
      assert.deepEqual(
        riskFlagsToBooleans([
          'schema-migration',
          'cross-service',
          'test-infrastructure',
          'rsc-serialization',
        ]),
        {
          is_greenfield: false,
          is_migration: true,
          requires_tests: true,
          cross_service: true,
          ui_heavy: true,
        },
      );
    });
  });

  describe('enum mappings', () => {
    it('maps task types, domains, and languages into Hokusai enums', () => {
      assert.equal(mapTaskType('test'), 'tests');
      assert.equal(mapTaskType('chore'), 'unknown');
      assert.equal(mapTaskType('feature', { hasMigration: true }), 'migration');

      assert.equal(mapDomain('full-stack'), 'fullstack');
      assert.equal(mapDomain('infrastructure'), 'devops');
      assert.equal(mapDomain('data-pipeline'), 'data');
      assert.equal(mapDomain('something-else'), 'unknown');

      assert.equal(mapLanguage(['TypeScript']), 'typescript');
      assert.equal(mapLanguage(['TypeScript', 'Python']), 'multi');
      assert.equal(mapLanguage(undefined, 'Bash'), 'bash');
      assert.equal(mapLanguage(['SQL']), 'unknown');
    });
  });

  describe('toHokusaiInput', () => {
    it('maps a populated descriptor into a complete Hokusai input', () => {
      const descriptor = makeDescriptor({
        signals: {
          heuristic: {
            task_type: 'feature',
            languages: ['typescript', 'javascript'],
            framework_tags: ['react'],
            files_touched: 8,
            repo_size_loc: 600_000,
            description_tokens: 250,
            is_greenfield: false,
            has_migration: true,
            has_ui: true,
            has_tests: true,
            cross_service: true,
          },
          learned: {
            complexity: 5,
            domain: 'full-stack',
            risk_flags: ['schema-migration', 'cross-service'],
          },
        },
      });

      const result = toHokusaiInput(
        descriptor,
        {
          repoId: 'repo',
          repoVisibility: 'private',
          primaryLanguage: 'TypeScript',
          repoSize: { fileCount: 120, loc: 600_000, dependencyCount: 25 },
        },
        {
          plannerModels: ['planner-a'],
          coderModels: ['coder-a'],
          reviewerModels: ['reviewer-a'],
        },
        'HOK-1235',
      );

      assert.deepEqual(result, {
        schema_version: '1.0',
        task_id: 'HOK-1235',
        task_descriptor: {
          task_type: 'migration',
          language: 'multi',
          domain: 'fullstack',
          complexity: 9,
          repo_size_bucket: 'xlarge',
          files_touched_bucket: '6_15',
          description_length_bucket: 'long',
          is_greenfield: false,
          is_migration: true,
          requires_tests: true,
          cross_service: true,
          ui_heavy: true,
          risk_level: 'high',
        },
        constraints: {
          max_cost_usd: 12.5,
        },
        available_models: {
          planner_models: ['planner-a'],
          coder_models: ['coder-a'],
          reviewer_models: ['reviewer-a'],
        },
      });
    });

    it('fills sensible defaults for minimal or partial descriptors', () => {
      const result = toHokusaiInput(
        {
          schema_version: '1.0',
          signals: {
            heuristic: {
              task_type: 'chore',
              languages: [],
              framework_tags: [],
              files_touched: 0,
              repo_size_loc: 0,
              description_tokens: 0,
              is_greenfield: false,
              has_migration: false,
              has_ui: false,
              has_tests: false,
              cross_service: false,
            },
            learned: {
              complexity: 99,
              domain: 'mystery',
              risk_flags: [],
            },
          },
          constraints: {
            models_available: [],
            objective: 'balanced',
          },
          stages: {},
        },
        undefined,
        undefined,
        'task-1',
      );

      assert.deepEqual(result, {
        schema_version: '1.0',
        task_id: 'task-1',
        task_descriptor: {
          task_type: 'unknown',
          language: 'unknown',
          domain: 'unknown',
          complexity: 5,
          repo_size_bucket: 'small',
          files_touched_bucket: '2_5',
          description_length_bucket: 'short',
          is_greenfield: false,
          is_migration: false,
          requires_tests: false,
          cross_service: false,
          ui_heavy: false,
          risk_level: 'low',
        },
        constraints: {
          max_cost_usd: 0,
        },
        available_models: {
          planner_models: [],
          coder_models: [],
          reviewer_models: [],
        },
      });
    });

    it('handles an effectively empty descriptor without throwing', () => {
      const result = toHokusaiInput(
        {} as Partial<TaskDescriptor>,
        {
          repoId: 'repo',
          repoVisibility: 'private',
          primaryLanguage: 'Python',
          repoSize: { fileCount: 5, loc: 2_000, dependencyCount: 1 },
        },
        {
          maxCostUsd: 3,
          availableModels: ['gpt-5.4'],
        },
      );

      assert.equal(result.task_descriptor.language, 'python');
      assert.equal(result.task_descriptor.repo_size_bucket, 'small');
      assert.equal(result.constraints.max_cost_usd, 3);
      assert.deepEqual(result.available_models, {
        planner_models: ['gpt-5.4'],
        coder_models: ['gpt-5.4'],
        reviewer_models: ['gpt-5.4'],
      });
    });
  });
});
