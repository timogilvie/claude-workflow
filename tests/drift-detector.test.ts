/**
 * Unit tests for drift-detector.ts
 *
 * Verifies drift detection logic.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSubsystemDrift, formatDriftWarning } from '../shared/lib/drift-detector.ts';
import type { DriftCheckResult } from '../shared/lib/drift-detector.ts';
import type { Subsystem } from '../shared/lib/subsystem-detector.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeRepo(): string {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'drift-detector-'));
  tempDirs.push(repoDir);
  mkdirSync(path.join(repoDir, '.wavemill', 'context'), { recursive: true });
  mkdirSync(path.join(repoDir, 'shared', 'lib'), { recursive: true });
  return repoDir;
}

function writeSpec(repoDir: string, subsystemId: string, body = '# Subsystem: Test\n'): string {
  const specPath = path.join(repoDir, '.wavemill', 'context', `${subsystemId}.md`);
  writeFileSync(specPath, body);
  return specPath;
}

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

  describe('checkSubsystemDrift', () => {
    it('does not mark a spec stale when it has no tracked key files', () => {
      const repoDir = makeRepo();
      const specPath = writeSpec(repoDir, 'quota-tracking');
      const oldTime = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000);
      utimesSync(specPath, oldTime, oldTime);

      const subsystem: Subsystem = {
        ...mockSubsystem,
        id: 'quota-tracking',
        name: 'Quota Tracking',
        keyFiles: [],
      };

      const status = checkSubsystemDrift(subsystem, repoDir);

      assert.strictEqual(status.isStale, false);
      assert.strictEqual(status.filesLastModified, null);
      assert.ok(status.daysSinceUpdate >= 15);
    });

    it('marks a spec stale when tracked source files are newer and the spec is overdue', () => {
      const repoDir = makeRepo();
      const specPath = writeSpec(repoDir, 'linear-api');
      const keyFile = path.join(repoDir, 'shared', 'lib', 'linear.ts');
      writeFileSync(keyFile, 'export const value = 1;\n');

      const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      const newTime = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
      utimesSync(specPath, oldTime, oldTime);
      utimesSync(keyFile, newTime, newTime);

      const status = checkSubsystemDrift(mockSubsystem, repoDir);

      assert.strictEqual(status.isStale, true);
      assert.ok(status.filesLastModified instanceof Date);
      assert.ok(status.filesLastModified! > status.specLastModified);
    });

    it('keeps a spec fresh after refresh when the spec is newer than tracked source files', () => {
      const repoDir = makeRepo();
      const specPath = writeSpec(repoDir, 'linear-api');
      const keyFile = path.join(repoDir, 'shared', 'lib', 'linear.ts');
      writeFileSync(keyFile, 'export const value = 1;\n');

      const recentTime = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
      const olderTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      utimesSync(specPath, recentTime, recentTime);
      utimesSync(keyFile, olderTime, olderTime);

      const status = checkSubsystemDrift(mockSubsystem, repoDir);

      assert.strictEqual(status.isStale, false);
      assert.ok(status.filesLastModified instanceof Date);
      assert.ok(status.filesLastModified! < status.specLastModified);
    });

    it('treats a missing spec as not stale', () => {
      const repoDir = makeRepo();

      const status = checkSubsystemDrift(mockSubsystem, repoDir);

      assert.strictEqual(status.isStale, false);
      assert.strictEqual(status.daysSinceUpdate, 0);
      assert.strictEqual(status.filesLastModified, null);
      assert.deepStrictEqual(status.recentPRs, []);
      assert.strictEqual(status.specLastModified.getTime(), 0);
    });
  });
});
