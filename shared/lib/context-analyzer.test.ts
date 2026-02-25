/**
 * Tests for context-analyzer.ts
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  detectStateManagement,
  detectApiClient,
  detectStyling,
  detectTestPatterns,
  analyzeDirectoryStructure,
  extractGotchas,
  analyzeCodeConventions,
} from './context-analyzer.ts';

describe('context-analyzer', () => {
  let testRepoDir: string;

  beforeEach(() => {
    // Create a temporary test repository
    testRepoDir = join(tmpdir(), `test-repo-${Date.now()}`);
    mkdirSync(testRepoDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up test repository
    if (existsSync(testRepoDir)) {
      rmSync(testRepoDir, { recursive: true, force: true });
    }
  });

  describe('detectStateManagement', () => {
    it('detects Redux Toolkit', () => {
      const packageJson = {
        dependencies: {
          '@reduxjs/toolkit': '^1.9.0',
        },
      };
      writeFileSync(join(testRepoDir, 'package.json'), JSON.stringify(packageJson));

      const result = detectStateManagement(testRepoDir);
      expect(result).toBe('Redux Toolkit');
    });

    it('detects Zustand', () => {
      const packageJson = {
        dependencies: {
          zustand: '^4.0.0',
        },
      };
      writeFileSync(join(testRepoDir, 'package.json'), JSON.stringify(packageJson));

      const result = detectStateManagement(testRepoDir);
      expect(result).toBe('Zustand');
    });

    it('returns undefined when no state management is detected', () => {
      const packageJson = {
        dependencies: {},
      };
      writeFileSync(join(testRepoDir, 'package.json'), JSON.stringify(packageJson));

      const result = detectStateManagement(testRepoDir);
      expect(result).toBeUndefined();
    });
  });

  describe('detectApiClient', () => {
    it('detects Axios', () => {
      const packageJson = {
        dependencies: {
          axios: '^1.0.0',
        },
      };
      writeFileSync(join(testRepoDir, 'package.json'), JSON.stringify(packageJson));

      const result = detectApiClient(testRepoDir);
      expect(result).toBe('Axios');
    });

    it('detects React Query', () => {
      const packageJson = {
        dependencies: {
          '@tanstack/react-query': '^4.0.0',
        },
      };
      writeFileSync(join(testRepoDir, 'package.json'), JSON.stringify(packageJson));

      const result = detectApiClient(testRepoDir);
      expect(result).toBe('React Query + fetch');
    });
  });

  describe('detectStyling', () => {
    it('detects Tailwind CSS', () => {
      const packageJson = {
        devDependencies: {
          tailwindcss: '^3.0.0',
        },
      };
      writeFileSync(join(testRepoDir, 'package.json'), JSON.stringify(packageJson));

      const result = detectStyling(testRepoDir);
      expect(result).toBe('Tailwind CSS');
    });

    it('detects styled-components', () => {
      const packageJson = {
        dependencies: {
          'styled-components': '^5.0.0',
        },
      };
      writeFileSync(join(testRepoDir, 'package.json'), JSON.stringify(packageJson));

      const result = detectStyling(testRepoDir);
      expect(result).toBe('styled-components');
    });
  });

  describe('analyzeDirectoryStructure', () => {
    it('identifies top-level directories', () => {
      mkdirSync(join(testRepoDir, 'src'));
      mkdirSync(join(testRepoDir, 'tests'));
      mkdirSync(join(testRepoDir, 'docs'));

      const result = analyzeDirectoryStructure(testRepoDir);

      expect(result.topLevelDirs).toContain('src');
      expect(result.topLevelDirs).toContain('tests');
      expect(result.topLevelDirs).toContain('docs');
    });

    it('identifies source directory', () => {
      mkdirSync(join(testRepoDir, 'src'));

      const result = analyzeDirectoryStructure(testRepoDir);

      expect(result.sourceDir).toBe('src');
    });

    it('identifies test directory', () => {
      mkdirSync(join(testRepoDir, 'tests'));

      const result = analyzeDirectoryStructure(testRepoDir);

      expect(result.testDir).toBe('tests');
    });

    it('tracks config files', () => {
      writeFileSync(join(testRepoDir, 'package.json'), '{}');
      writeFileSync(join(testRepoDir, 'tsconfig.json'), '{}');
      writeFileSync(join(testRepoDir, 'jest.config.js'), '');

      const result = analyzeDirectoryStructure(testRepoDir);

      expect(result.configFiles).toContain('package.json');
      expect(result.configFiles).toContain('tsconfig.json');
      expect(result.configFiles).toContain('jest.config.js');
    });
  });

  describe('extractGotchas', () => {
    it('extracts gotchas from CLAUDE.md', () => {
      const claudeMd = `
# Project

## Known Issues

- Database migrations must be run manually
- API rate limiting is strict (100 req/min)
`;
      writeFileSync(join(testRepoDir, 'CLAUDE.md'), claudeMd);

      const result = extractGotchas(testRepoDir);

      expect(result.length).toBeGreaterThan(0);
      // Note: extraction logic might vary, so we just check that something was extracted
    });

    it('returns empty array when no gotchas found', () => {
      const claudeMd = `
# Project

Some basic documentation without gotchas.
`;
      writeFileSync(join(testRepoDir, 'CLAUDE.md'), claudeMd);

      const result = extractGotchas(testRepoDir);

      expect(result).toEqual([]);
    });
  });

  describe('analyzeCodeConventions', () => {
    it('performs full convention analysis', () => {
      // Set up a realistic test repo
      mkdirSync(join(testRepoDir, 'src'));
      mkdirSync(join(testRepoDir, 'tests'));

      const packageJson = {
        dependencies: {
          react: '^18.0.0',
          zustand: '^4.0.0',
          axios: '^1.0.0',
        },
        devDependencies: {
          tailwindcss: '^3.0.0',
          jest: '^29.0.0',
        },
      };
      writeFileSync(join(testRepoDir, 'package.json'), JSON.stringify(packageJson));

      const result = analyzeCodeConventions(testRepoDir);

      expect(result.patterns.stateManagement).toBe('Zustand');
      expect(result.patterns.apiClient).toBe('Axios');
      expect(result.patterns.styling).toBe('Tailwind CSS');
      expect(result.structure.sourceDir).toBe('src');
      expect(result.structure.testDir).toBe('tests');
    });
  });
});
