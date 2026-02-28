/**
 * Unit tests for drift-detector.ts
 *
 * Verifies drift detection logic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatDriftWarning } from '../shared/lib/drift-detector.ts';
import type { DriftCheckResult } from '../shared/lib/drift-detector.ts';
import type { Subsystem } from '../shared/lib/subsystem-detector.ts';

describe('drift-detector', () => {
  const mockSubsystem: Subsystem = {
    id: 'linear-api',
    name: 'Linear API',
    description: 'Linear GraphQL client',
    keyFiles: ['shared/lib/linear.ts'],
    testPatterns: [],
    dependencies: [],
    confidence: 0.9,
    detectionMethod: 'package',
  };

  describe('formatDriftWarning', () => {
    it('returns empty string when no drift', () => {
      const result: DriftCheckResult = {
        staleSubsystems: [],
        totalChecked: 3,
        hasDrift: false,
      };

      const warning = formatDriftWarning(result);
      assert.strictEqual(warning, '', 'Should return empty string');
    });

    it('formats warning when drift detected', () => {
      const result: DriftCheckResult = {
        staleSubsystems: [
          {
            subsystem: mockSubsystem,
            status: {
              isStale: true,
              daysSinceUpdate: 10,
              recentPRs: ['#123', '#124'],
              specLastModified: new Date('2026-02-18'),
              filesLastModified: new Date('2026-02-28'),
            },
          },
        ],
        totalChecked: 3,
        hasDrift: true,
      };

      const warning = formatDriftWarning(result);

      assert.match(warning, /DRIFT DETECTED/, 'Should include drift warning');
      assert.match(warning, /Linear API/, 'Should include subsystem name');
      assert.match(warning, /10 days ago/, 'Should include days since update');
      assert.match(warning, /#123/, 'Should include recent PRs');
    });

    it('handles multiple stale subsystems', () => {
      const mockSubsystem2: Subsystem = {
        id: 'eval-system',
        name: 'Eval System',
        description: 'Evaluation',
        keyFiles: ['shared/lib/eval.ts'],
        testPatterns: [],
        dependencies: [],
        confidence: 0.8,
        detectionMethod: 'directory',
      };

      const result: DriftCheckResult = {
        staleSubsystems: [
          {
            subsystem: mockSubsystem,
            status: {
              isStale: true,
              daysSinceUpdate: 10,
              recentPRs: [],
              specLastModified: new Date('2026-02-18'),
              filesLastModified: new Date('2026-02-28'),
            },
          },
          {
            subsystem: mockSubsystem2,
            status: {
              isStale: true,
              daysSinceUpdate: 15,
              recentPRs: [],
              specLastModified: new Date('2026-02-13'),
              filesLastModified: new Date('2026-02-28'),
            },
          },
        ],
        totalChecked: 5,
        hasDrift: true,
      };

      const warning = formatDriftWarning(result);

      assert.match(warning, /Linear API/, 'Should include first subsystem');
      assert.match(warning, /Eval System/, 'Should include second subsystem');
    });
  });
});
