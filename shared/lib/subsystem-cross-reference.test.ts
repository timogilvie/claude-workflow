/**
 * Unit tests for subsystem cross-reference detection.
 */

import { describe, test as it } from 'node:test';
import { expect } from './test-assertions.ts';
import { detectSubsystemRelationships } from './subsystem-cross-reference.ts';
import type { Subsystem } from './subsystem-detector.ts';

describe('subsystem-cross-reference', () => {
  describe('detectSubsystemRelationships', () => {
    it('should detect shared files between two subsystems', () => {
      const subsystems: Subsystem[] = [
        {
          id: 'router',
          name: 'Router',
          description: 'Request routing',
          keyFiles: ['shared/lib/config.ts', 'shared/lib/router.ts'],
          testPatterns: [],
          dependencies: [],
          confidence: 0.9,
          detectionMethod: 'directory',
        },
        {
          id: 'eval-system',
          name: 'Eval System',
          description: 'Evaluation orchestration',
          keyFiles: ['shared/lib/config.ts', 'shared/lib/eval.ts'],
          testPatterns: [],
          dependencies: [],
          confidence: 0.9,
          detectionMethod: 'directory',
        },
      ];

      const relationships = detectSubsystemRelationships(subsystems);

      expect(relationships.get('router')).toHaveLength(1);
      expect(relationships.get('eval-system')).toHaveLength(1);
      expect(relationships.get('router')?.[0].id).toBe('eval-system');
      expect(relationships.get('eval-system')?.[0].id).toBe('router');
    });

    it('should generate appropriate reasons for single shared file', () => {
      const subsystems: Subsystem[] = [
        {
          id: 'a',
          name: 'A',
          description: 'A',
          keyFiles: ['config.ts'],
          testPatterns: [],
          dependencies: [],
          confidence: 0.9,
          detectionMethod: 'directory',
        },
        {
          id: 'b',
          name: 'B',
          description: 'B',
          keyFiles: ['config.ts'],
          testPatterns: [],
          dependencies: [],
          confidence: 0.9,
          detectionMethod: 'directory',
        },
      ];

      const relationships = detectSubsystemRelationships(subsystems);

      expect(relationships.get('a')?.[0].reason).toBe('shares `config.ts`');
    });

    it('should generate appropriate reasons for 2-3 shared files in same directory', () => {
      const subsystems: Subsystem[] = [
        {
          id: 'a',
          name: 'A',
          description: 'A',
          keyFiles: ['shared/lib/config.ts', 'shared/lib/util.ts'],
          testPatterns: [],
          dependencies: [],
          confidence: 0.9,
          detectionMethod: 'directory',
        },
        {
          id: 'b',
          name: 'B',
          description: 'B',
          keyFiles: ['shared/lib/config.ts', 'shared/lib/util.ts'],
          testPatterns: [],
          dependencies: [],
          confidence: 0.9,
          detectionMethod: 'directory',
        },
      ];

      const relationships = detectSubsystemRelationships(subsystems);

      expect(relationships.get('a')?.[0].reason).toBe('shares files in `lib`');
    });

    it('should generate appropriate reasons for 4+ shared files', () => {
      const subsystems: Subsystem[] = [
        {
          id: 'a',
          name: 'A',
          description: 'A',
          keyFiles: [
            'shared/lib/a.ts',
            'shared/lib/b.ts',
            'shared/lib/c.ts',
            'shared/lib/d.ts',
          ],
          testPatterns: [],
          dependencies: [],
          confidence: 0.9,
          detectionMethod: 'directory',
        },
        {
          id: 'b',
          name: 'B',
          description: 'B',
          keyFiles: [
            'shared/lib/a.ts',
            'shared/lib/b.ts',
            'shared/lib/c.ts',
            'shared/lib/d.ts',
          ],
          testPatterns: [],
          dependencies: [],
          confidence: 0.9,
          detectionMethod: 'directory',
        },
      ];

      const relationships = detectSubsystemRelationships(subsystems);

      expect(relationships.get('a')?.[0].reason).toBe('closely coupled via `lib` modules');
    });

    it('should return bidirectional relationships', () => {
      const subsystems: Subsystem[] = [
        {
          id: 'a',
          name: 'A',
          description: 'A',
          keyFiles: ['shared.ts'],
          testPatterns: [],
          dependencies: [],
          confidence: 0.9,
          detectionMethod: 'directory',
        },
        {
          id: 'b',
          name: 'B',
          description: 'B',
          keyFiles: ['shared.ts'],
          testPatterns: [],
          dependencies: [],
          confidence: 0.9,
          detectionMethod: 'directory',
        },
      ];

      const relationships = detectSubsystemRelationships(subsystems);

      expect(relationships.get('a')?.[0].id).toBe('b');
      expect(relationships.get('b')?.[0].id).toBe('a');
      expect(relationships.get('a')?.[0].reason).toBe(relationships.get('b')?.[0].reason);
    });

    it('should limit to top N relationships per subsystem', () => {
      const subsystems: Subsystem[] = [
        {
          id: 'hub',
          name: 'Hub',
          description: 'Hub',
          keyFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts'],
          testPatterns: [],
          dependencies: [],
          confidence: 0.9,
          detectionMethod: 'directory',
        },
      ];

      // Create 10 subsystems that each share 1 file with hub
      for (let i = 0; i < 10; i++) {
        subsystems.push({
          id: `spoke-${i}`,
          name: `Spoke ${i}`,
          description: `Spoke ${i}`,
          keyFiles: [subsystems[0].keyFiles[i % 8]],
          testPatterns: [],
          dependencies: [],
          confidence: 0.9,
          detectionMethod: 'directory',
        });
      }

      const relationships = detectSubsystemRelationships(subsystems, 7);

      expect(relationships.get('hub')?.length).toBeLessThanOrEqual(7);
    });

    it('should handle subsystems with no shared files', () => {
      const subsystems: Subsystem[] = [
        {
          id: 'a',
          name: 'A',
          description: 'A',
          keyFiles: ['a.ts'],
          testPatterns: [],
          dependencies: [],
          confidence: 0.9,
          detectionMethod: 'directory',
        },
        {
          id: 'b',
          name: 'B',
          description: 'B',
          keyFiles: ['b.ts'],
          testPatterns: [],
          dependencies: [],
          confidence: 0.9,
          detectionMethod: 'directory',
        },
      ];

      const relationships = detectSubsystemRelationships(subsystems);

      expect(relationships.get('a')).toHaveLength(0);
      expect(relationships.get('b')).toHaveLength(0);
    });

    it('should normalize file paths correctly', () => {
      const subsystems: Subsystem[] = [
        {
          id: 'a',
          name: 'A',
          description: 'A',
          keyFiles: ['./shared/config.ts'],
          testPatterns: [],
          dependencies: [],
          confidence: 0.9,
          detectionMethod: 'directory',
        },
        {
          id: 'b',
          name: 'B',
          description: 'B',
          keyFiles: ['shared/config.ts'],
          testPatterns: [],
          dependencies: [],
          confidence: 0.9,
          detectionMethod: 'directory',
        },
      ];

      const relationships = detectSubsystemRelationships(subsystems);

      expect(relationships.get('a')).toHaveLength(1);
      expect(relationships.get('b')).toHaveLength(1);
    });

    it('should sort relationships by shared file count', () => {
      const subsystems: Subsystem[] = [
        {
          id: 'a',
          name: 'A',
          description: 'A',
          keyFiles: ['x.ts', 'y.ts', 'z.ts'],
          testPatterns: [],
          dependencies: [],
          confidence: 0.9,
          detectionMethod: 'directory',
        },
        {
          id: 'b',
          name: 'B',
          description: 'B',
          keyFiles: ['x.ts'],
          testPatterns: [],
          dependencies: [],
          confidence: 0.9,
          detectionMethod: 'directory',
        },
        {
          id: 'c',
          name: 'C',
          description: 'C',
          keyFiles: ['x.ts', 'y.ts'],
          testPatterns: [],
          dependencies: [],
          confidence: 0.9,
          detectionMethod: 'directory',
        },
      ];

      const relationships = detectSubsystemRelationships(subsystems);
      const aRelated = relationships.get('a')!;

      expect(aRelated).toHaveLength(2);
      expect(aRelated[0].id).toBe('c'); // 2 shared files
      expect(aRelated[1].id).toBe('b'); // 1 shared file
    });
  });
});
