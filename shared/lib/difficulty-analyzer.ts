/**
 * Difficulty analysis for PR-based task evaluation (HOK-777).
 *
 * Computes difficulty metrics from PR diffs to enable:
 * - Weighted reward systems (harder tasks earn more)
 * - Stratified evaluation (compare tasks within similar contexts)
 * - Prevention of "easy wins" gaming the system
 *
 * @module difficulty-analyzer
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DifficultyBand, DifficultySignals, Stratum } from './eval-schema.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface DifficultyAnalysis {
  difficultyBand: DifficultyBand;
  difficultySignals: DifficultySignals;
  stratum: Stratum;
}

// ────────────────────────────────────────────────────────────────
// Git Diff Analysis
// ────────────────────────────────────────────────────────────────

/**
 * Parse git diff output to compute lines touched and files modified.
 *
 * Expects `git diff --numstat` format:
 * ```
 * 10    5    src/file1.ts
 * 2     3    src/file2.ts
 * ```
 *
 * @param prDiff - Git diff output (can be from `gh pr diff` or `git diff`)
 * @returns Object with locTouched and filesTouched, or null if diff is empty
 */
export function analyzeDiffStats(prDiff: string): {
  locTouched: number;
  filesTouched: number;
} | null {
  if (!prDiff || prDiff.trim().length === 0) {
    return null;
  }

  // Try to extract numstat format if present
  // Format: additions<tab>deletions<tab>filename
  const numstatPattern = /^(\d+|-)\s+(\d+|-)\s+(.+)$/gm;
  const matches = [...prDiff.matchAll(numstatPattern)];

  if (matches.length > 0) {
    // We have numstat format
    let totalLoc = 0;
    const filesSet = new Set<string>();

    for (const match of matches) {
      const additions = match[1] === '-' ? 0 : parseInt(match[1], 10);
      const deletions = match[2] === '-' ? 0 : parseInt(match[2], 10);
      const filename = match[3];

      totalLoc += additions + deletions;
      filesSet.add(filename);
    }

    return {
      locTouched: totalLoc,
      filesTouched: filesSet.size,
    };
  }

  // Fallback: count unified diff format
  // This is less accurate but works for regular `git diff` output
  const lines = prDiff.split('\n');
  const filesSet = new Set<string>();
  let additions = 0;
  let deletions = 0;

  for (const line of lines) {
    // File header: diff --git a/path b/path
    if (line.startsWith('diff --git ')) {
      const parts = line.split(' ');
      if (parts.length >= 4) {
        const filename = parts[3].replace(/^b\//, '');
        filesSet.add(filename);
      }
    }
    // Addition: line starts with '+'
    else if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
    }
    // Deletion: line starts with '-'
    else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
    }
  }

  const locTouched = additions + deletions;
  const filesTouched = filesSet.size;

  // If we found no files, the diff is probably malformed or empty
  if (filesTouched === 0) {
    return null;
  }

  return { locTouched, filesTouched };
}

// ────────────────────────────────────────────────────────────────
// GitHub API Fallback
// ────────────────────────────────────────────────────────────────

/**
 * Fetch PR stats from the GitHub API as a cross-check / fallback.
 *
 * Uses `gh pr view --json additions,deletions,changedFiles` which returns
 * GitHub's own counts independent of diff parsing.
 *
 * @returns Stats from the API, or null if unavailable
 */
export function fetchPrStatsFromApi(
  prNumber: string,
  repoDir: string,
): { locTouched: number; filesTouched: number } | null {
  try {
    const raw = execSync(
      `gh pr view ${prNumber} --json additions,deletions,changedFiles`,
      { encoding: 'utf-8', cwd: repoDir, timeout: 10_000 },
    ).trim();
    const data = JSON.parse(raw);
    const additions = typeof data.additions === 'number' ? data.additions : 0;
    const deletions = typeof data.deletions === 'number' ? data.deletions : 0;
    const changedFiles = typeof data.changedFiles === 'number' ? data.changedFiles : 0;
    return {
      locTouched: additions + deletions,
      filesTouched: changedFiles,
    };
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// Tech Stack Detection
// ────────────────────────────────────────────────────────────────

/**
 * Detect primary tech stack from file extensions and config files.
 *
 * Strategy:
 * 1. Count file extensions in diff (most common wins)
 * 2. Check for framework-specific config files
 * 3. Return compact identifier (e.g., "ts_nextjs", "py_django", "go_std")
 *
 * @param prDiff - PR diff output
 * @param repoDir - Repository directory (optional, for checking config files)
 * @returns Tech stack identifier, or "unknown" if unclear
 */
export function detectTechStack(prDiff: string, repoDir?: string): string {
  // Extract filenames from diff
  const filenames: string[] = [];

  // Try numstat format first
  const numstatPattern = /^(?:\d+|-)\s+(?:\d+|-)\s+(.+)$/gm;
  const numstatMatches = [...prDiff.matchAll(numstatPattern)];

  if (numstatMatches.length > 0) {
    filenames.push(...numstatMatches.map((m) => m[1]));
  } else {
    // Fallback to unified diff format
    const diffGitPattern = /^diff --git a\/.+ b\/(.+)$/gm;
    const diffMatches = [...prDiff.matchAll(diffGitPattern)];
    filenames.push(...diffMatches.map((m) => m[1]));
  }

  if (filenames.length === 0) {
    return 'unknown';
  }

  // Count file extensions
  const extCounts = new Map<string, number>();
  for (const filename of filenames) {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext) {
      extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
    }
  }

  // Check for framework-specific files in the diff or repo
  const hasNextConfig = filenames.some((f) =>
    /next\.config\.(js|ts|mjs)$/.test(f)
  );
  const hasPackageJson = filenames.some((f) => f === 'package.json');
  const hasRequirementsTxt = filenames.some((f) =>
    /requirements.*\.txt$/.test(f) || f === 'pyproject.toml'
  );
  const hasGoMod = filenames.some((f) => f === 'go.mod');
  const hasCargoToml = filenames.some((f) => f === 'Cargo.toml');
  const hasGemfile = filenames.some((f) => f === 'Gemfile');

  // Check repo root for framework markers if repoDir is provided
  let hasDjango = false;
  let hasReact = false;
  let hasVue = false;

  if (repoDir && hasRequirementsTxt) {
    // Check if requirements.txt mentions django
    try {
      const reqPath = resolve(repoDir, 'requirements.txt');
      if (existsSync(reqPath)) {
        const reqContent = readFileSync(reqPath, 'utf-8');
        hasDjango = /django/i.test(reqContent);
      }
    } catch {
      // Best effort
    }
  }

  if (repoDir && hasPackageJson) {
    // Check package.json for react/vue
    try {
      const pkgPath = resolve(repoDir, 'package.json');
      if (existsSync(pkgPath)) {
        const pkgContent = readFileSync(pkgPath, 'utf-8');
        hasReact = /"react"/.test(pkgContent);
        hasVue = /"vue"/.test(pkgContent);
      }
    } catch {
      // Best effort
    }
  }

  // Determine stack based on signals
  const tsCount = (extCounts.get('ts') || 0) + (extCounts.get('tsx') || 0);
  const jsCount = (extCounts.get('js') || 0) + (extCounts.get('jsx') || 0);
  const pyCount = extCounts.get('py') || 0;
  const goCount = extCounts.get('go') || 0;
  const rsCount = extCounts.get('rs') || 0;
  const rbCount = extCounts.get('rb') || 0;

  // Next.js (TypeScript + Next config)
  if (hasNextConfig && tsCount > 0) {
    return 'ts_nextjs';
  }

  // React (TypeScript/JavaScript + React in package.json)
  if (hasReact && (tsCount > 0 || jsCount > 0)) {
    return tsCount > jsCount ? 'ts_react' : 'js_react';
  }

  // Vue
  if (hasVue && (tsCount > 0 || jsCount > 0)) {
    return tsCount > jsCount ? 'ts_vue' : 'js_vue';
  }

  // Django
  if (hasDjango && pyCount > 0) {
    return 'py_django';
  }

  // Go
  if (hasGoMod || goCount > 0) {
    return 'go_std';
  }

  // Rust
  if (hasCargoToml || rsCount > 0) {
    return 'rust_std';
  }

  // Ruby/Rails
  if (hasGemfile || rbCount > 0) {
    return 'rb_rails';
  }

  // Fallback to base language
  const maxCount = Math.max(tsCount, jsCount, pyCount, goCount, rsCount, rbCount);
  if (maxCount === 0) {
    return 'unknown';
  }

  if (tsCount === maxCount) return 'ts_std';
  if (jsCount === maxCount) return 'js_std';
  if (pyCount === maxCount) return 'py_std';
  if (goCount === maxCount) return 'go_std';
  if (rsCount === maxCount) return 'rust_std';
  if (rbCount === maxCount) return 'rb_std';

  return 'unknown';
}

// ────────────────────────────────────────────────────────────────
// Difficulty Band Computation
// ────────────────────────────────────────────────────────────────

/**
 * Derive difficulty band from signals using heuristic thresholds.
 *
 * Thresholds (tunable):
 * - trivial: < 20 LOC, <= 1 file
 * - easy: < 100 LOC, <= 3 files
 * - medium: < 300 LOC, <= 8 files
 * - hard: < 1000 LOC, <= 20 files
 * - very_hard: >= 1000 LOC or > 20 files
 *
 * @param signals - Difficulty signals with LOC and file counts
 * @returns Difficulty band classification
 */
export function computeDifficultyBand(signals: DifficultySignals): DifficultyBand {
  const { locTouched, filesTouched } = signals;

  // Very hard: large PRs or many files
  if (locTouched >= 1000 || filesTouched > 20) {
    return 'very_hard';
  }

  // Hard: moderate to large PRs
  if (locTouched >= 300 || filesTouched > 8) {
    return 'hard';
  }

  // Medium: standard features
  if (locTouched >= 100 || filesTouched > 3) {
    return 'medium';
  }

  // Easy: small features
  if (locTouched >= 20 || filesTouched > 1) {
    return 'easy';
  }

  // Trivial: single-line fixes, typos
  return 'trivial';
}

// ────────────────────────────────────────────────────────────────
// Stratum Computation
// ────────────────────────────────────────────────────────────────

/**
 * Build stratum string from tech stack and size band.
 *
 * Format: "{tech_stack}_{size_band}"
 *
 * Size bands:
 * - small: < 100 LOC
 * - med: 100-499 LOC
 * - large: >= 500 LOC
 *
 * @param techStack - Tech stack identifier (e.g., "ts_nextjs")
 * @param signals - Difficulty signals with LOC count
 * @returns Stratum string (e.g., "ts_nextjs_small")
 */
export function computeStratum(
  techStack: string,
  signals: DifficultySignals
): Stratum {
  const { locTouched } = signals;

  let sizeBand: string;
  if (locTouched < 100) {
    sizeBand = 'small';
  } else if (locTouched < 500) {
    sizeBand = 'med';
  } else {
    sizeBand = 'large';
  }

  return `${techStack}_${sizeBand}`;
}

// ────────────────────────────────────────────────────────────────
// Main Entry Point
// ────────────────────────────────────────────────────────────────

/**
 * Analyze PR difficulty from diff output.
 *
 * Returns all difficulty fields ready for inclusion in an EvalRecord.
 * Returns null if the diff is empty or unparseable.
 *
 * @param opts.prDiff - PR diff output (from `gh pr diff` or `git diff`)
 * @param opts.prNumber - PR number (for enhanced git operations, optional)
 * @param opts.repoDir - Repository directory (for config file checks, optional)
 * @returns Difficulty analysis object, or null if diff is invalid
 *
 * @example
 * ```ts
 * const analysis = analyzePrDifficulty({
 *   prDiff: diffOutput,
 *   prNumber: '123',
 *   repoDir: '/path/to/repo',
 * });
 *
 * if (analysis) {
 *   console.log(analysis.difficultyBand); // "medium"
 *   console.log(analysis.stratum);        // "ts_nextjs_med"
 * }
 * ```
 */
export function analyzePrDifficulty(opts: {
  prDiff: string;
  prNumber?: string;
  repoDir?: string;
}): DifficultyAnalysis | null {
  const { prDiff, prNumber, repoDir } = opts;

  // 1. Analyze diff stats from the raw diff
  let stats = analyzeDiffStats(prDiff);

  // 2. Cross-validate with GitHub API when diff parsing looks suspicious
  //    (0 LOC with files present usually means the diff was truncated or malformed)
  let diffUncertain = false;
  const diffLooksSuspicious = stats && stats.locTouched === 0 && stats.filesTouched > 0;
  const diffIsEmpty = !stats;

  if ((diffLooksSuspicious || diffIsEmpty) && prNumber && repoDir) {
    const apiStats = fetchPrStatsFromApi(prNumber, repoDir);
    if (apiStats && (apiStats.locTouched > 0 || apiStats.filesTouched > 0)) {
      if (diffLooksSuspicious) {
        console.warn(
          `difficulty-analyzer: diff parsing returned 0 LOC but GitHub API reports ` +
          `${apiStats.locTouched} LOC across ${apiStats.filesTouched} files — using API stats`,
        );
      } else {
        console.warn(
          `difficulty-analyzer: diff parsing failed but GitHub API reports ` +
          `${apiStats.locTouched} LOC across ${apiStats.filesTouched} files — using API stats`,
        );
      }
      stats = apiStats;
    } else if (diffLooksSuspicious) {
      // API also returned nothing useful — flag as uncertain
      diffUncertain = true;
      console.warn(
        'difficulty-analyzer: 0 LOC with files present and API fallback unavailable — marking as uncertain',
      );
    }
  } else if (diffLooksSuspicious) {
    // No prNumber/repoDir to attempt API fallback — flag as uncertain
    diffUncertain = true;
    console.warn(
      'difficulty-analyzer: 0 LOC with files present (no API context available) — marking as uncertain',
    );
  }

  if (!stats) {
    return null;
  }

  // 3. Build difficulty signals
  const signals: DifficultySignals = {
    locTouched: stats.locTouched,
    filesTouched: stats.filesTouched,
    ...(diffUncertain ? { diffUncertain: true } : {}),
  };

  // 4. Detect tech stack
  const techStack = detectTechStack(prDiff, repoDir);

  // 5. Compute difficulty band
  const difficultyBand = computeDifficultyBand(signals);

  // 6. Compute stratum
  const stratum = computeStratum(techStack, signals);

  return {
    difficultyBand,
    difficultySignals: signals,
    stratum,
  };
}
