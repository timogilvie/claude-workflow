/**
 * Unit tests for subsystem-detector.ts
 *
 * Verifies subsystem detection logic without requiring a full repo setup.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectSubsystems } from '../shared/lib/subsystem-detector.ts';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

describe('subsystem-detector', () => {
  describe('detectSubsystems', () => {
    it('detects subsystems in wavemill repo', () => {
      const subsystems = detectSubsystems(REPO_ROOT, {
        minFiles: 3,
        useGitAnalysis: false, // Skip git for speed
        maxSubsystems: 20,
      });

      // Should detect at least some subsystems
      assert.ok(subsystems.length > 0, 'Should detect at least one subsystem');

      // Each subsystem should have required fields
      for (const subsystem of subsystems) {
        assert.ok(subsystem.id, 'Subsystem should have an ID');
        assert.ok(subsystem.name, 'Subsystem should have a name');
        assert.ok(subsystem.description, 'Subsystem should have a description');
        assert.ok(Array.isArray(subsystem.keyFiles), 'Subsystem should have keyFiles array');
        assert.ok(subsystem.keyFiles.length >= 3, `Subsystem ${subsystem.id} should have at least 3 key files`);
        assert.ok(typeof subsystem.confidence === 'number', 'Confidence should be a number');
        assert.ok(subsystem.confidence >= 0 && subsystem.confidence <= 1, 'Confidence should be 0-1');
      }
    });

    it('respects maxSubsystems limit', () => {
      const subsystems = detectSubsystems(REPO_ROOT, {
        minFiles: 1,
        useGitAnalysis: false,
        maxSubsystems: 3,
      });

      assert.ok(subsystems.length <= 3, 'Should respect maxSubsystems limit');
    });

    it('detects different subsystem types', () => {
      const subsystems = detectSubsystems(REPO_ROOT, {
        minFiles: 3,
        useGitAnalysis: false,
        maxSubsystems: 20,
      });

      // Should detect subsystems using different methods
      const methods = new Set(subsystems.map(s => s.detectionMethod));
      assert.ok(methods.size > 0, 'Should use at least one detection method');
    });
  });
});
