/**
 * Context analyzer for project-context.md initialization.
 *
 * Extends repo-context-analyzer to detect code patterns, conventions,
 * and architectural decisions from the codebase.
 *
 * @module context-analyzer
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface CodePatterns {
  stateManagement?: string;
  apiClient?: string;
  testPatterns?: string[];
  styling?: string;
  errorHandling?: string;
}

export interface DirectoryStructure {
  topLevelDirs: string[];
  sourceDir?: string;
  testDir?: string;
  configFiles: string[];
}

export interface ConventionAnalysis {
  patterns: CodePatterns;
  structure: DirectoryStructure;
  gotchas: string[];
}

// ────────────────────────────────────────────────────────────────
// Pattern Detection
// ────────────────────────────────────────────────────────────────

/**
 * Detect state management patterns by scanning for common libraries and patterns.
 */
export function detectStateManagement(repoDir: string): string | undefined {
  const packageJsonPath = join(repoDir, 'package.json');
  if (!existsSync(packageJsonPath)) return undefined;

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (deps.redux || deps['@reduxjs/toolkit']) return 'Redux Toolkit';
    if (deps.zustand) return 'Zustand';
    if (deps.jotai) return 'Jotai';
    if (deps.recoil) return 'Recoil';
    if (deps.mobx) return 'MobX';
    if (deps.xstate) return 'XState';

    // Check for React Context usage
    if (deps.react) {
      try {
        const contextFiles = execSync(
          'git ls-files | grep -E "\\.(tsx?|jsx?)$" | xargs grep -l "createContext\\|useContext" 2>/dev/null | head -3',
          { encoding: 'utf-8', cwd: repoDir, shell: '/bin/bash' }
        ).trim();

        if (contextFiles) return 'React Context';
      } catch {
        // No context usage found
      }
    }
  } catch {
    // package.json parsing failed
  }

  return undefined;
}

/**
 * Detect API client patterns.
 */
export function detectApiClient(repoDir: string): string | undefined {
  const packageJsonPath = join(repoDir, 'package.json');
  if (!existsSync(packageJsonPath)) return undefined;

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (deps.axios) return 'Axios';
    if (deps['@tanstack/react-query'] || deps['react-query']) return 'React Query + fetch';
    if (deps.swr) return 'SWR';
    if (deps['apollo-client'] || deps['@apollo/client']) return 'Apollo Client (GraphQL)';
    if (deps.urql) return 'urql (GraphQL)';

    // Check for native fetch usage
    try {
      const fetchFiles = execSync(
        'git ls-files | grep -E "\\.(tsx?|jsx?)$" | xargs grep -l "\\bfetch(" 2>/dev/null | head -1',
        { encoding: 'utf-8', cwd: repoDir, shell: '/bin/bash' }
      ).trim();

      if (fetchFiles) return 'Native fetch';
    } catch {
      // No fetch usage
    }
  } catch {
    // package.json parsing failed
  }

  return undefined;
}

/**
 * Detect styling approach.
 */
export function detectStyling(repoDir: string): string | undefined {
  const packageJsonPath = join(repoDir, 'package.json');
  if (!existsSync(packageJsonPath)) return undefined;

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (deps.tailwindcss) return 'Tailwind CSS';
    if (deps['styled-components']) return 'styled-components';
    if (deps['@emotion/react'] || deps['@emotion/styled']) return 'Emotion';
    if (deps['@mui/material']) return 'Material-UI';
    if (deps['@chakra-ui/react']) return 'Chakra UI';

    // Check for CSS Modules
    try {
      const cssModules = execSync(
        'git ls-files | grep -E "\\.module\\.(css|scss|sass)$" | head -1',
        { encoding: 'utf-8', cwd: repoDir, shell: '/bin/bash' }
      ).trim();

      if (cssModules) return 'CSS Modules';
    } catch {
      // No CSS modules
    }

    // Check for plain CSS/SCSS
    try {
      const cssFiles = execSync(
        'git ls-files | grep -E "\\.(css|scss|sass)$" | head -1',
        { encoding: 'utf-8', cwd: repoDir, shell: '/bin/bash' }
      ).trim();

      if (cssFiles) return 'CSS/SCSS';
    } catch {
      // No CSS files
    }
  } catch {
    // package.json parsing failed
  }

  return undefined;
}

/**
 * Detect test patterns by analyzing test files.
 */
export function detectTestPatterns(repoDir: string): string[] {
  const patterns: string[] = [];

  try {
    // Check for test co-location vs separate test directory
    const testFileCount = execSync(
      'git ls-files | grep -E "\\.(test|spec)\\.(tsx?|jsx?)$" | wc -l',
      { encoding: 'utf-8', cwd: repoDir, shell: '/bin/bash' }
    ).trim();

    const testDirCount = execSync(
      'git ls-files | grep -E "^(test|tests|__tests__)/" | wc -l',
      { encoding: 'utf-8', cwd: repoDir, shell: '/bin/bash' }
    ).trim();

    if (parseInt(testFileCount, 10) > parseInt(testDirCount, 10)) {
      patterns.push('Tests co-located with source files');
    } else if (parseInt(testDirCount, 10) > 0) {
      patterns.push('Tests in dedicated test directory');
    }

    // Check for snapshot testing
    const snapshotFiles = execSync(
      'git ls-files | grep -E "\\.snap$" | head -1',
      { encoding: 'utf-8', cwd: repoDir, shell: '/bin/bash' }
    ).trim();

    if (snapshotFiles) {
      patterns.push('Snapshot testing enabled');
    }

    // Check for E2E tests
    const e2ePatterns = ['e2e', 'integration', 'playwright', 'cypress'];
    for (const pattern of e2ePatterns) {
      try {
        const e2eFiles = execSync(
          `git ls-files | grep -i "${pattern}" | head -1`,
          { encoding: 'utf-8', cwd: repoDir, shell: '/bin/bash' }
        ).trim();

        if (e2eFiles) {
          patterns.push(`E2E tests (${pattern})`);
          break;
        }
      } catch {
        // Pattern not found
      }
    }
  } catch {
    // Test pattern detection failed
  }

  return patterns;
}

/**
 * Detect error handling patterns.
 */
export function detectErrorHandling(repoDir: string): string | undefined {
  try {
    // Check for error boundary usage (React)
    const errorBoundary = execSync(
      'git ls-files | grep -E "\\.(tsx?|jsx?)$" | xargs grep -l "componentDidCatch\\|ErrorBoundary" 2>/dev/null | head -1',
      { encoding: 'utf-8', cwd: repoDir, shell: '/bin/bash' }
    ).trim();

    if (errorBoundary) return 'React Error Boundaries';

    // Check for Sentry
    const packageJsonPath = join(repoDir, 'package.json');
    if (existsSync(packageJsonPath)) {
      const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (deps['@sentry/react'] || deps['@sentry/node']) return 'Sentry';
    }
  } catch {
    // Error handling detection failed
  }

  return undefined;
}

// ────────────────────────────────────────────────────────────────
// Directory Structure Analysis
// ────────────────────────────────────────────────────────────────

/**
 * Analyze directory structure to understand code organization.
 */
export function analyzeDirectoryStructure(repoDir: string): DirectoryStructure {
  const topLevelDirs: string[] = [];
  let sourceDir: string | undefined;
  let testDir: string | undefined;
  const configFiles: string[] = [];

  try {
    const entries = readdirSync(repoDir);

    for (const entry of entries) {
      const fullPath = join(repoDir, entry);

      // Skip hidden files and common noise
      if (entry.startsWith('.') || entry === 'node_modules') continue;

      try {
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          topLevelDirs.push(entry);

          // Identify source directory
          if (['src', 'lib', 'app', 'source'].includes(entry.toLowerCase())) {
            sourceDir = entry;
          }

          // Identify test directory
          if (['test', 'tests', '__tests__', 'spec'].includes(entry.toLowerCase())) {
            testDir = entry;
          }
        } else if (stat.isFile()) {
          // Track config files
          if (
            entry.endsWith('.config.js') ||
            entry.endsWith('.config.ts') ||
            entry.endsWith('.json') ||
            entry === 'Makefile' ||
            entry === 'Dockerfile'
          ) {
            configFiles.push(entry);
          }
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Directory read failed
  }

  return {
    topLevelDirs: topLevelDirs.sort(),
    sourceDir,
    testDir,
    configFiles: configFiles.sort(),
  };
}

// ────────────────────────────────────────────────────────────────
// Gotcha Detection
// ────────────────────────────────────────────────────────────────

/**
 * Extract gotchas from CLAUDE.md or README.md if they exist.
 */
export function extractGotchas(repoDir: string): string[] {
  const gotchas = new Set<string>();
  const candidates = [join(repoDir, 'CLAUDE.md'), join(repoDir, 'README.md')];

  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;

    try {
      const content = readFileSync(filePath, 'utf-8');

      // Look for sections that might contain gotchas
      const sectionPattern =
        /(?:^|\n)\s*##?\s*(?:Known Issues|Gotchas|Caveats|Limitations|Important Notes?)[^\n]*\n([\s\S]*?)(?=\n\s*##?\s|$)/gi;
      let sectionMatch;
      while ((sectionMatch = sectionPattern.exec(content)) !== null) {
        const sectionContent = sectionMatch[1] || '';
        const lines = sectionContent
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);

        for (const line of lines) {
          const cleaned = line
            .replace(/^[-*]\s+/, '')
            .replace(/^\d+\.\s+/, '')
            .trim();
          if (cleaned.length >= 10 && cleaned.length <= 200) {
            gotchas.add(cleaned);
          }
        }
      }

      const inlineWarningPattern =
        /(?:^|\n)\s*[-*]\s*(?:⚠️|WARNING|IMPORTANT|NOTE):?\s*([^\n]+)/gi;
      let warningMatch;
      while ((warningMatch = inlineWarningPattern.exec(content)) !== null) {
        const extracted = warningMatch[1]?.trim();
        if (extracted && extracted.length >= 10 && extracted.length <= 200) {
          gotchas.add(extracted);
        }
      }
    } catch {
      // File read failed
    }
  }

  return Array.from(gotchas).slice(0, 5); // Limit to 5 gotchas
}

// ────────────────────────────────────────────────────────────────
// Main Analysis Function
// ────────────────────────────────────────────────────────────────

/**
 * Analyze code conventions and patterns for project context initialization.
 */
export function analyzeCodeConventions(repoDir: string): ConventionAnalysis {
  const patterns: CodePatterns = {};
  const structure = analyzeDirectoryStructure(repoDir);
  const gotchas = extractGotchas(repoDir);

  // Detect patterns
  const stateManagement = detectStateManagement(repoDir);
  if (stateManagement) patterns.stateManagement = stateManagement;

  const apiClient = detectApiClient(repoDir);
  if (apiClient) patterns.apiClient = apiClient;

  const styling = detectStyling(repoDir);
  if (styling) patterns.styling = styling;

  const errorHandling = detectErrorHandling(repoDir);
  if (errorHandling) patterns.errorHandling = errorHandling;

  const testPatterns = detectTestPatterns(repoDir);
  if (testPatterns.length > 0) patterns.testPatterns = testPatterns;

  return {
    patterns,
    structure,
    gotchas,
  };
}
