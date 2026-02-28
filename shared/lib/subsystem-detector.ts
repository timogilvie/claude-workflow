/**
 * Subsystem detection for cold memory (context subsystem docs).
 *
 * Uses heuristic-based analysis to identify logical subsystems in a codebase:
 * - Directory structure (top-level modules)
 * - File naming patterns (e.g., *-router.ts, *-analyzer.ts)
 * - Package dependencies (group related functionality)
 * - Git activity clustering (frequently co-modified files)
 *
 * Inspired by "Codified Context: Infrastructure for AI Agents" (arXiv:2602.20478)
 *
 * @module subsystem-detector
 */

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, dirname, basename } from 'node:path';
import { execShellCommand } from './shell-utils.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface Subsystem {
  /** Unique identifier (kebab-case) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Brief description of purpose */
  description: string;
  /** Key files that define this subsystem */
  keyFiles: string[];
  /** Test file patterns */
  testPatterns: string[];
  /** Dependencies on other subsystems */
  dependencies: string[];
  /** Detection confidence (0-1) */
  confidence: number;
  /** Detection method used */
  detectionMethod: 'directory' | 'pattern' | 'package' | 'git-cluster';
}

export interface SubsystemDetectionConfig {
  /** Minimum files to constitute a subsystem */
  minFiles?: number;
  /** Include git history analysis (slower but more accurate) */
  useGitAnalysis?: boolean;
  /** Maximum subsystems to detect */
  maxSubsystems?: number;
  /** Source directories to analyze */
  sourceDirs?: string[];
}

const DEFAULT_CONFIG: Required<SubsystemDetectionConfig> = {
  minFiles: 3,
  useGitAnalysis: true,
  maxSubsystems: 20,
  sourceDirs: ['src', 'lib', 'shared', 'tools', 'commands'],
};

// ────────────────────────────────────────────────────────────────
// Directory-based Detection
// ────────────────────────────────────────────────────────────────

/**
 * Detect subsystems based on directory structure.
 *
 * Analyzes top-level directories in source roots to identify modules.
 */
function detectDirectorySubsystems(repoDir: string, config: Required<SubsystemDetectionConfig>): Subsystem[] {
  const subsystems: Subsystem[] = [];

  for (const sourceDir of config.sourceDirs) {
    const sourcePath = join(repoDir, sourceDir);
    if (!existsSync(sourcePath)) continue;

    try {
      const entries = readdirSync(sourcePath);

      for (const entry of entries) {
        const entryPath = join(sourcePath, entry);
        if (!statSync(entryPath).isDirectory()) continue;
        if (entry.startsWith('.') || entry === 'node_modules') continue;

        // Collect files in this directory
        const files = collectFiles(entryPath);
        if (files.length < config.minFiles) continue;

        // Create subsystem
        const id = `${sourceDir}-${entry}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
        const name = formatSubsystemName(entry);
        const description = generateDescriptionFromPath(sourceDir, entry);

        subsystems.push({
          id,
          name,
          description,
          keyFiles: files.slice(0, 10).map(f => relative(repoDir, f)),
          testPatterns: detectTestPatterns(files, repoDir),
          dependencies: [],
          confidence: 0.7,
          detectionMethod: 'directory',
        });
      }
    } catch {
      // Skip directories we can't read
    }
  }

  return subsystems;
}

/**
 * Collect all files in a directory (recursively, limited depth).
 */
function collectFiles(dir: string, depth = 0, maxDepth = 3): string[] {
  if (depth > maxDepth) return [];

  const files: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;

      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isFile()) {
        files.push(fullPath);
      } else if (stat.isDirectory()) {
        files.push(...collectFiles(fullPath, depth + 1, maxDepth));
      }
    }
  } catch {
    // Skip files we can't read
  }

  return files;
}

/**
 * Detect test file patterns from a list of files.
 */
function detectTestPatterns(files: string[], repoDir: string): string[] {
  const patterns = new Set<string>();

  for (const file of files) {
    const rel = relative(repoDir, file);
    if (rel.includes('test') || rel.includes('spec')) {
      // Extract pattern: e.g., "tests/unit/foo/*.test.ts"
      const parts = rel.split('/');
      if (parts.length >= 2) {
        const pattern = `${parts.slice(0, -1).join('/')}/*.{test,spec}.{ts,js}`;
        patterns.add(pattern);
      }
    }
  }

  return Array.from(patterns);
}

// ────────────────────────────────────────────────────────────────
// Pattern-based Detection
// ────────────────────────────────────────────────────────────────

/**
 * Detect subsystems based on file naming patterns.
 *
 * Groups files with common suffixes (e.g., *-router.ts, *-analyzer.ts).
 */
function detectPatternSubsystems(repoDir: string, config: Required<SubsystemDetectionConfig>): Subsystem[] {
  const subsystems: Subsystem[] = [];

  // Collect all source files
  const allFiles: string[] = [];
  for (const sourceDir of config.sourceDirs) {
    const sourcePath = join(repoDir, sourceDir);
    if (existsSync(sourcePath)) {
      allFiles.push(...collectFiles(sourcePath));
    }
  }

  // Group by pattern suffix
  const patterns = new Map<string, string[]>();
  const suffixes = ['-router', '-analyzer', '-detector', '-generator', '-validator', '-handler', '-manager'];

  for (const file of allFiles) {
    const name = basename(file, '.ts').replace('.test', '').replace('.spec', '');
    for (const suffix of suffixes) {
      if (name.endsWith(suffix)) {
        const key = suffix.substring(1); // Remove leading dash
        if (!patterns.has(key)) patterns.set(key, []);
        patterns.get(key)!.push(file);
      }
    }
  }

  // Create subsystems from patterns
  for (const [pattern, files] of patterns.entries()) {
    if (files.length < config.minFiles) continue;

    const id = pattern.toLowerCase();
    const name = formatSubsystemName(pattern);
    const description = `${name} components and utilities`;

    subsystems.push({
      id,
      name,
      description,
      keyFiles: files.slice(0, 10).map(f => relative(repoDir, f)),
      testPatterns: detectTestPatterns(files, repoDir),
      dependencies: [],
      confidence: 0.6,
      detectionMethod: 'pattern',
    });
  }

  return subsystems;
}

// ────────────────────────────────────────────────────────────────
// Package-based Detection
// ────────────────────────────────────────────────────────────────

/**
 * Detect subsystems based on package.json dependencies.
 *
 * Groups files that interact with the same external packages.
 */
function detectPackageSubsystems(repoDir: string, config: Required<SubsystemDetectionConfig>): Subsystem[] {
  const subsystems: Subsystem[] = [];

  // Read package.json
  const packagePath = join(repoDir, 'package.json');
  if (!existsSync(packagePath)) return subsystems;

  try {
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8'));
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };

    // Key packages that often define subsystems
    const keyPackages = ['linear', 'anthropic', 'openai', 'express', 'fastify', 'next', 'react'];

    for (const pkg of keyPackages) {
      if (!deps[pkg] && !Object.keys(deps).some(d => d.includes(pkg))) continue;

      // Find files that import this package
      const files = findFilesImporting(repoDir, pkg, config.sourceDirs);
      if (files.length < config.minFiles) continue;

      const id = `${pkg}-integration`;
      const name = `${formatSubsystemName(pkg)} Integration`;
      const description = `Integration with ${pkg} package`;

      subsystems.push({
        id,
        name,
        description,
        keyFiles: files.slice(0, 10),
        testPatterns: detectTestPatterns(files.map(f => join(repoDir, f)), repoDir),
        dependencies: [],
        confidence: 0.8,
        detectionMethod: 'package',
      });
    }
  } catch {
    // Skip if package.json is malformed
  }

  return subsystems;
}

/**
 * Find files that import a specific package.
 */
function findFilesImporting(repoDir: string, packageName: string, sourceDirs: string[]): string[] {
  const files: string[] = [];

  for (const sourceDir of sourceDirs) {
    const sourcePath = join(repoDir, sourceDir);
    if (!existsSync(sourcePath)) continue;

    try {
      // Use grep to find imports (fast)
      const cmd = `grep -r --include="*.{ts,js,tsx,jsx}" -l "from ['\"]${packageName}" ${sourcePath} 2>/dev/null || true`;
      const output = execShellCommand(cmd, { encoding: 'utf-8', cwd: repoDir });
      const matches = output.trim().split('\n').filter(Boolean);
      files.push(...matches.map(f => relative(repoDir, f)));
    } catch {
      // Grep failed, skip
    }
  }

  return files;
}

// ────────────────────────────────────────────────────────────────
// Git Clustering
// ────────────────────────────────────────────────────────────────

/**
 * Detect subsystems based on git activity clustering.
 *
 * Files that are frequently modified together likely belong to the same subsystem.
 */
function detectGitClusterSubsystems(repoDir: string, config: Required<SubsystemDetectionConfig>): Subsystem[] {
  if (!config.useGitAnalysis) return [];

  const subsystems: Subsystem[] = [];

  try {
    // Get recent commits with file changes
    const cmd = 'git log --name-only --pretty=format:"COMMIT:%H" -100';
    const output = execShellCommand(cmd, { encoding: 'utf-8', cwd: repoDir });

    // Parse commit groups
    const commits = output.split('COMMIT:').filter(Boolean);
    const coModifications = new Map<string, Map<string, number>>();

    for (const commit of commits) {
      const lines = commit.trim().split('\n').slice(1); // Skip commit hash
      const files = lines.filter(l => l && !l.startsWith('COMMIT:'));

      // Record co-modifications
      for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
          const file1 = files[i];
          const file2 = files[j];

          if (!coModifications.has(file1)) coModifications.set(file1, new Map());
          if (!coModifications.has(file2)) coModifications.set(file2, new Map());

          const count1 = coModifications.get(file1)!.get(file2) || 0;
          const count2 = coModifications.get(file2)!.get(file1) || 0;

          coModifications.get(file1)!.set(file2, count1 + 1);
          coModifications.get(file2)!.set(file1, count2 + 1);
        }
      }
    }

    // Cluster files with high co-modification counts
    const clusters = clusterFiles(coModifications, config.minFiles);

    for (const [index, cluster] of clusters.entries()) {
      const id = `git-cluster-${index + 1}`;
      const name = `Co-modified Group ${index + 1}`;
      const description = inferDescriptionFromFiles(cluster);

      subsystems.push({
        id,
        name,
        description,
        keyFiles: cluster.slice(0, 10),
        testPatterns: detectTestPatterns(cluster.map(f => join(repoDir, f)), repoDir),
        dependencies: [],
        confidence: 0.5,
        detectionMethod: 'git-cluster',
      });
    }
  } catch {
    // Git analysis failed, skip
  }

  return subsystems;
}

/**
 * Cluster files based on co-modification frequency.
 */
function clusterFiles(coMods: Map<string, Map<string, number>>, minFiles: number): string[][] {
  const clusters: string[][] = [];
  const visited = new Set<string>();

  for (const [file, neighbors] of coMods.entries()) {
    if (visited.has(file)) continue;

    // Start a new cluster
    const cluster = [file];
    visited.add(file);

    // Add strongly connected neighbors
    const sorted = Array.from(neighbors.entries()).sort((a, b) => b[1] - a[1]);
    for (const [neighbor, count] of sorted) {
      if (count >= 3 && !visited.has(neighbor)) {
        cluster.push(neighbor);
        visited.add(neighbor);
      }
    }

    if (cluster.length >= minFiles) {
      clusters.push(cluster);
    }
  }

  return clusters;
}

// ────────────────────────────────────────────────────────────────
// Main Detection Function
// ────────────────────────────────────────────────────────────────

/**
 * Detect subsystems in a repository using multiple heuristics.
 *
 * Combines directory structure, naming patterns, package dependencies,
 * and git activity to identify logical subsystems.
 */
export function detectSubsystems(
  repoDir: string,
  config: SubsystemDetectionConfig = {}
): Subsystem[] {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };

  // Run all detection methods
  const dirSubsystems = detectDirectorySubsystems(repoDir, fullConfig);
  const patternSubsystems = detectPatternSubsystems(repoDir, fullConfig);
  const packageSubsystems = detectPackageSubsystems(repoDir, fullConfig);
  const gitSubsystems = detectGitClusterSubsystems(repoDir, fullConfig);

  // Merge and deduplicate
  const allSubsystems = [
    ...dirSubsystems,
    ...patternSubsystems,
    ...packageSubsystems,
    ...gitSubsystems,
  ];

  const merged = mergeSubsystems(allSubsystems);

  // Sort by confidence and limit
  return merged
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, fullConfig.maxSubsystems);
}

/**
 * Merge overlapping subsystems (same key files).
 */
function mergeSubsystems(subsystems: Subsystem[]): Subsystem[] {
  const merged: Subsystem[] = [];

  for (const subsystem of subsystems) {
    // Check if this overlaps with an existing subsystem
    const existing = merged.find(s => {
      const overlap = s.keyFiles.filter(f => subsystem.keyFiles.includes(f)).length;
      return overlap > s.keyFiles.length * 0.5; // >50% overlap
    });

    if (existing) {
      // Merge into existing
      existing.keyFiles = Array.from(new Set([...existing.keyFiles, ...subsystem.keyFiles]));
      existing.testPatterns = Array.from(new Set([...existing.testPatterns, ...subsystem.testPatterns]));
      existing.confidence = Math.max(existing.confidence, subsystem.confidence);
    } else {
      merged.push(subsystem);
    }
  }

  return merged;
}

// ────────────────────────────────────────────────────────────────
// Helper Functions
// ────────────────────────────────────────────────────────────────

/**
 * Format a subsystem name from identifier.
 */
function formatSubsystemName(name: string): string {
  return name
    .replace(/[-_]/g, ' ')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Generate description from source path.
 */
function generateDescriptionFromPath(sourceDir: string, entry: string): string {
  const name = formatSubsystemName(entry);
  const dirName = formatSubsystemName(sourceDir);
  return `${name} components in ${dirName}`;
}

/**
 * Infer description from file paths.
 */
function inferDescriptionFromFiles(files: string[]): string {
  // Find common directory prefix
  if (files.length === 0) return 'Unknown subsystem';

  const parts = files[0].split('/');
  let commonPrefix = parts[0];

  for (const file of files) {
    const fileParts = file.split('/');
    for (let i = 0; i < Math.min(parts.length, fileParts.length); i++) {
      if (parts[i] !== fileParts[i]) {
        commonPrefix = parts.slice(0, i).join('/');
        break;
      }
    }
  }

  return `Components in ${commonPrefix || 'repository root'}`;
}
