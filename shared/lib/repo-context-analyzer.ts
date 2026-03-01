/**
 * Repository context analysis for eval routing and stratification (HOK-774).
 *
 * Extracts repository metadata to enable:
 * - Model routing based on tech stack
 * - Stratified evaluation (compare tasks within similar repo contexts)
 * - Better understanding of which repos/stacks work well
 *
 * @module repo-context-analyzer
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { RepoContext, RepoVisibility, RepoSize } from './eval-schema.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import { parsePackageJson } from './package-json-parser.ts';

// ────────────────────────────────────────────────────────────────
// Language Detection
// ────────────────────────────────────────────────────────────────

const LANGUAGE_EXTENSIONS: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.java': 'Java',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.cpp': 'C++',
  '.c': 'C',
  '.swift': 'Swift',
  '.kt': 'Kotlin',
  '.sh': 'Shell',
};

/**
 * Detect languages used in the repository.
 *
 * Uses git ls-files for accuracy and speed. Falls back to filesystem scan
 * if not a git repo.
 *
 * Returns a map of language to percentage (approximate).
 */
export function detectLanguages(repoDir: string): {
  primaryLanguage: string;
  languages?: Record<string, number>;
} {
  let files: string[] = [];

  // Try git ls-files first (faster and respects .gitignore)
  try {
    const output = execShellCommand('git ls-files', {
      encoding: 'utf-8',
      cwd: repoDir,
      maxBuffer: 10 * 1024 * 1024,
    });
    files = output.toString().split('\n').filter((f) => f.length > 0);
  } catch {
    // Fallback: manual scan (limited to avoid performance issues)
    try {
      files = scanDirectory(repoDir, 0, 1000);
    } catch {
      // If all else fails, return unknown
      return { primaryLanguage: 'unknown' };
    }
  }

  // Count files by language
  const counts: Record<string, number> = {};
  for (const file of files) {
    const ext = file.substring(file.lastIndexOf('.'));
    const lang = LANGUAGE_EXTENSIONS[ext];
    if (lang) {
      counts[lang] = (counts[lang] || 0) + 1;
    }
  }

  if (Object.keys(counts).length === 0) {
    return { primaryLanguage: 'unknown' };
  }

  // Convert counts to percentages
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const percentages: Record<string, number> = {};
  for (const [lang, count] of Object.entries(counts)) {
    percentages[lang] = Math.round((count / total) * 100);
  }

  // Find primary language (highest percentage)
  const sorted = Object.entries(percentages).sort((a, b) => b[1] - a[1]);
  const primaryLanguage = sorted[0][0];

  return { primaryLanguage, languages: percentages };
}

/**
 * Recursively scan directory for files (limited depth and count).
 */
function scanDirectory(dir: string, depth: number, maxFiles: number): string[] {
  if (depth > 3 || maxFiles <= 0) return [];

  const files: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.startsWith('.') || entry === 'node_modules') continue;

      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) {
          files.push(fullPath);
        } else if (stat.isDirectory()) {
          files.push(...scanDirectory(fullPath, depth + 1, maxFiles - files.length));
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Skip directories we can't read
  }
  return files;
}

// ────────────────────────────────────────────────────────────────
// Framework Detection
// ────────────────────────────────────────────────────────────────

const FRAMEWORK_MARKERS: Record<string, string[]> = {
  'Next.js': ['next.config.js', 'next.config.mjs', 'next.config.ts'],
  React: [], // Detected from package.json dependencies
  Vue: ['vue.config.js'],
  Angular: ['angular.json'],
  Svelte: ['svelte.config.js'],
  Django: ['manage.py', 'settings.py'],
  Flask: ['app.py', 'wsgi.py'],
  Rails: ['Gemfile', 'config/application.rb'],
  Express: [], // Detected from package.json dependencies
  FastAPI: [], // Detected from requirements.txt
  Spring: ['pom.xml', 'build.gradle'],
};

/**
 * Detect frameworks used in the repository.
 */
export function detectFrameworks(repoDir: string, packageJson?: any): string[] {
  const frameworks: Set<string> = new Set();

  // Check for file markers
  for (const [framework, files] of Object.entries(FRAMEWORK_MARKERS)) {
    for (const file of files) {
      if (existsSync(join(repoDir, file))) {
        frameworks.add(framework);
        break;
      }
    }
  }

  // Parse package.json if not provided
  const pkg = packageJson ?? parsePackageJson(repoDir);

  // Check package.json for JS/TS frameworks
  if (pkg.dependencies || pkg.devDependencies) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (deps.next) frameworks.add('Next.js');
    if (deps.react) frameworks.add('React');
    if (deps.vue) frameworks.add('Vue');
    if (deps['@angular/core']) frameworks.add('Angular');
    if (deps.svelte) frameworks.add('Svelte');
    if (deps.express) frameworks.add('Express');
  }

  // Check requirements.txt for Python frameworks
  const requirementsPath = join(repoDir, 'requirements.txt');
  if (existsSync(requirementsPath)) {
    try {
      const content = readFileSync(requirementsPath, 'utf-8').toLowerCase();
      if (content.includes('django')) frameworks.add('Django');
      if (content.includes('flask')) frameworks.add('Flask');
      if (content.includes('fastapi')) frameworks.add('FastAPI');
    } catch {
      // Skip
    }
  }

  return Array.from(frameworks);
}

// ────────────────────────────────────────────────────────────────
// Build System Detection
// ────────────────────────────────────────────────────────────────

const BUILD_SYSTEM_MARKERS: Record<string, string> = {
  webpack: 'webpack.config.js',
  vite: 'vite.config.js',
  rollup: 'rollup.config.js',
  parcel: '.parcelrc',
  gradle: 'build.gradle',
  maven: 'pom.xml',
  make: 'Makefile',
  cmake: 'CMakeLists.txt',
  bazel: 'BUILD',
};

export function detectBuildSystem(repoDir: string, packageJson?: any): string | undefined {
  for (const [system, file] of Object.entries(BUILD_SYSTEM_MARKERS)) {
    if (existsSync(join(repoDir, file))) {
      return system;
    }
  }

  // Parse package.json if not provided
  const pkg = packageJson ?? parsePackageJson(repoDir);

  // Check package.json scripts for build tools
  if (pkg.dependencies || pkg.devDependencies) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (deps.webpack) return 'webpack';
    if (deps.vite) return 'vite';
    if (deps.rollup) return 'rollup';
    if (deps.parcel) return 'parcel';
  }

  return undefined;
}

// ────────────────────────────────────────────────────────────────
// Package Manager Detection
// ────────────────────────────────────────────────────────────────

const PACKAGE_MANAGER_MARKERS: Record<string, string> = {
  npm: 'package-lock.json',
  yarn: 'yarn.lock',
  pnpm: 'pnpm-lock.yaml',
  bun: 'bun.lockb',
  pip: 'requirements.txt',
  poetry: 'poetry.lock',
  cargo: 'Cargo.lock',
  go: 'go.sum',
  bundler: 'Gemfile.lock',
};

export function detectPackageManager(repoDir: string): string | undefined {
  for (const [manager, file] of Object.entries(PACKAGE_MANAGER_MARKERS)) {
    if (existsSync(join(repoDir, file))) {
      return manager;
    }
  }
  return undefined;
}

// ────────────────────────────────────────────────────────────────
// Test Framework Detection
// ────────────────────────────────────────────────────────────────

const TEST_FRAMEWORK_MARKERS: Record<string, string[]> = {
  jest: ['jest.config.js', 'jest.config.ts'],
  vitest: ['vitest.config.js', 'vitest.config.ts'],
  mocha: ['.mocharc.json', 'mocha.opts'],
  pytest: ['pytest.ini', 'tox.ini'],
  rspec: ['.rspec'],
  junit: ['pom.xml'],
};

export function detectTestFrameworks(repoDir: string, packageJson?: any): string[] {
  const frameworks: Set<string> = new Set();

  // Check for config file markers
  for (const [framework, files] of Object.entries(TEST_FRAMEWORK_MARKERS)) {
    for (const file of files) {
      if (existsSync(join(repoDir, file))) {
        frameworks.add(framework);
        break;
      }
    }
  }

  // Parse package.json if not provided
  const pkg = packageJson ?? parsePackageJson(repoDir);

  // Check package.json for JS test frameworks
  if (pkg.dependencies || pkg.devDependencies) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (deps.jest) frameworks.add('jest');
    if (deps.vitest) frameworks.add('vitest');
    if (deps.mocha) frameworks.add('mocha');
    if (deps['@playwright/test']) frameworks.add('playwright');
    if (deps.cypress) frameworks.add('cypress');
  }

  return Array.from(frameworks);
}

// ────────────────────────────────────────────────────────────────
// CI Provider Detection
// ────────────────────────────────────────────────────────────────

const CI_MARKERS: Record<string, string> = {
  'github-actions': '.github/workflows',
  'gitlab-ci': '.gitlab-ci.yml',
  'circle-ci': '.circleci/config.yml',
  jenkins: 'Jenkinsfile',
  travis: '.travis.yml',
};

export function detectCiProvider(repoDir: string): string | undefined {
  for (const [provider, path] of Object.entries(CI_MARKERS)) {
    if (existsSync(join(repoDir, path))) {
      return provider;
    }
  }
  return undefined;
}

// ────────────────────────────────────────────────────────────────
// Repo Size Computation
// ────────────────────────────────────────────────────────────────

/**
 * Compute repository size metrics.
 *
 * Uses git for accuracy when possible, falls back to filesystem scan.
 */
export function computeRepoSize(repoDir: string, packageJson?: any): RepoSize {
  let fileCount = 0;
  let loc = 0;
  let dependencyCount = 0;

  // Count files
  try {
    const output = execShellCommand('git ls-files | wc -l', {
      encoding: 'utf-8',
      cwd: repoDir,
    });
    fileCount = parseInt(output.toString().trim(), 10);
  } catch {
    // Fallback: count files manually (limited)
    const files = scanDirectory(repoDir, 0, 5000);
    fileCount = files.length;
  }

  // Count LOC (approximate - only count tracked code files)
  try {
    const output = execShellCommand(
      'git ls-files | grep -E "\\.(ts|tsx|js|jsx|py|go|rs|java|rb|php|cs|cpp|c|swift|kt)$" | xargs wc -l 2>/dev/null | tail -1',
      {
        encoding: 'utf-8',
        cwd: repoDir,
      }
    );
    const match = output.toString().match(/(\d+)/);
    if (match) {
      loc = parseInt(match[1], 10);
    }
  } catch {
    // LOC counting failed - use estimate based on file count
    loc = fileCount * 50; // Rough estimate
  }

  // Parse package.json if not provided
  const pkg = packageJson ?? parsePackageJson(repoDir);

  // Count dependencies
  dependencyCount =
    Object.keys(pkg.dependencies || {}).length +
    Object.keys(pkg.devDependencies || {}).length;

  return { fileCount, loc, dependencyCount };
}

// ────────────────────────────────────────────────────────────────
// Monorepo Detection
// ────────────────────────────────────────────────────────────────

export function isMonorepo(repoDir: string, packageJson?: any): boolean {
  // Parse package.json if not provided
  const pkg = packageJson ?? parsePackageJson(repoDir);

  // Check for workspace markers in package.json
  if (pkg.workspaces) return true;

  // Check for lerna
  if (existsSync(join(repoDir, 'lerna.json'))) return true;

  // Check for pnpm workspace
  if (existsSync(join(repoDir, 'pnpm-workspace.yaml'))) return true;

  // Check for nx
  if (existsSync(join(repoDir, 'nx.json'))) return true;

  return false;
}

// ────────────────────────────────────────────────────────────────
// Repo ID Generation
// ────────────────────────────────────────────────────────────────

/**
 * Generate a stable repo ID from git remote or directory path.
 */
export function computeRepoId(repoDir: string): string {
  // Try to get repo name from git remote
  try {
    const remote = execShellCommand('git remote get-url origin', {
      encoding: 'utf-8',
      cwd: repoDir,
    }).trim();

    // Extract repo slug from URL
    // Examples:
    //   https://github.com/user/repo.git -> user/repo
    //   git@github.com:user/repo.git -> user/repo
    const match = remote.match(/[:/]([^/]+\/[^/]+?)(\.git)?$/);
    if (match) {
      return match[1];
    }

    // Hash the full URL as fallback
    return createHash('sha256').update(remote).digest('hex').substring(0, 16);
  } catch {
    // Not a git repo or no remote - hash the directory path
    const absPath = resolve(repoDir);
    return createHash('sha256').update(absPath).digest('hex').substring(0, 16);
  }
}

// ────────────────────────────────────────────────────────────────
// Repo Visibility Detection
// ────────────────────────────────────────────────────────────────

/**
 * Detect if repository is open source or private.
 */
export function detectRepoVisibility(repoDir: string): RepoVisibility {
  try {
    const remote = execShellCommand('git remote get-url origin', {
      encoding: 'utf-8',
      cwd: repoDir,
    }).trim();

    // Check for public hosting platforms
    if (
      remote.includes('github.com') ||
      remote.includes('gitlab.com') ||
      remote.includes('bitbucket.org')
    ) {
      // For now, assume public unless we can check via API
      // A more sophisticated version could use gh/gl CLI to check visibility
      return 'oss';
    }

    // Private host or unknown
    return 'private';
  } catch {
    // No git remote - assume private
    return 'private';
  }
}

// ────────────────────────────────────────────────────────────────
// Main Analysis Function
// ────────────────────────────────────────────────────────────────

/**
 * Analyze repository context from the filesystem and git metadata.
 *
 * This is the main entry point for repo context analysis.
 */
export function analyzeRepoContext(repoDir: string): RepoContext {
  // Parse package.json once for all detectors
  const packageJson = parsePackageJson(repoDir);

  const { primaryLanguage, languages } = detectLanguages(repoDir);
  const frameworks = detectFrameworks(repoDir, packageJson);
  const buildSystem = detectBuildSystem(repoDir, packageJson);
  const packageManager = detectPackageManager(repoDir);
  const testFrameworks = detectTestFrameworks(repoDir, packageJson);
  const ciProvider = detectCiProvider(repoDir);
  const repoSize = computeRepoSize(repoDir, packageJson);
  const monorepo = isMonorepo(repoDir, packageJson);
  const repoId = computeRepoId(repoDir);
  const repoVisibility = detectRepoVisibility(repoDir);

  return {
    repoId,
    repoVisibility,
    primaryLanguage,
    ...(languages && { languages }),
    ...(frameworks.length > 0 && { frameworks }),
    ...(buildSystem && { buildSystem }),
    ...(packageManager && { packageManager }),
    ...(testFrameworks.length > 0 && { testFrameworks }),
    ...(ciProvider && { ciProvider }),
    ...(repoSize && { repoSize }),
    ...(monorepo && { monorepo }),
  };
}
