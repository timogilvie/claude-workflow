/**
 * Drift detection for subsystem specifications.
 *
 * Detects when subsystem docs are stale (not updated after recent PRs).
 * Prevents agents from using outdated architectural knowledge.
 *
 * Inspired by "Codified Context: Infrastructure for AI Agents" (arXiv:2602.20478):
 * "Agents trust documentation completely; stale specifications create silent failures"
 *
 * @module drift-detector
 */

import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execShellCommand } from './shell-utils.ts';
import type { Subsystem } from './subsystem-detector.ts';
import { detectSubsystemsInIssue } from './subsystem-mapper.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface DriftStatus {
  /** Is the subsystem spec stale? */
  isStale: boolean;
  /** Days since last update */
  daysSinceUpdate: number;
  /** Recent PRs touching subsystem files */
  recentPRs: string[];
  /** Last modified timestamp of spec file */
  specLastModified: Date;
  /** Most recent file change in subsystem */
  filesLastModified: Date | null;
}

export interface DriftCheckResult {
  /** Subsystems with drift detected */
  staleSubsystems: Array<{
    subsystem: Subsystem;
    status: DriftStatus;
  }>;
  /** Total subsystems checked */
  totalChecked: number;
  /** Has any drift? */
  hasDrift: boolean;
}

// ────────────────────────────────────────────────────────────────
// Configuration
// ────────────────────────────────────────────────────────────────

const DEFAULT_DRIFT_THRESHOLD_DAYS = 7;

// ────────────────────────────────────────────────────────────────
// Drift Detection Functions
// ────────────────────────────────────────────────────────────────

/**
 * Check if a subsystem spec is stale.
 *
 * A spec is stale if:
 * - Spec file exists
 * - Files in the subsystem have been modified more recently than the spec
 * - Spec hasn't been updated in > threshold days
 */
export function checkSubsystemDrift(
  subsystem: Subsystem,
  repoDir: string,
  thresholdDays = DEFAULT_DRIFT_THRESHOLD_DAYS
): DriftStatus {
  const contextDir = join(repoDir, '.wavemill', 'context');
  const specPath = join(contextDir, `${subsystem.id}.md`);

  // If spec doesn't exist, it's not stale (it's missing)
  if (!existsSync(specPath)) {
    return {
      isStale: false,
      daysSinceUpdate: 0,
      recentPRs: [],
      specLastModified: new Date(0),
      filesLastModified: null,
    };
  }

  // Get spec last modified time
  const specStats = statSync(specPath);
  const specLastModified = specStats.mtime;

  // Get most recent file modification time in subsystem
  const filesLastModified = getMostRecentFileModification(subsystem.keyFiles, repoDir);

  // Calculate drift
  const now = new Date();
  const daysSinceUpdate = Math.floor((now.getTime() - specLastModified.getTime()) / (1000 * 60 * 60 * 24));

  // Get recent PRs affecting this subsystem
  const recentPRs = getRecentPRsForSubsystem(subsystem, repoDir, specLastModified);

  // Determine if stale
  const isStale = filesLastModified !== null
    ? filesLastModified > specLastModified && daysSinceUpdate >= thresholdDays
    : daysSinceUpdate >= thresholdDays;

  return {
    isStale,
    daysSinceUpdate,
    recentPRs,
    specLastModified,
    filesLastModified,
  };
}

/**
 * Detect drift for subsystems referenced in an issue.
 *
 * Parses issue description to find referenced files/subsystems,
 * then checks if their specs are stale.
 */
export function detectDriftForIssue(
  issueDescription: string,
  subsystems: Subsystem[],
  repoDir: string,
  thresholdDays = DEFAULT_DRIFT_THRESHOLD_DAYS
): DriftCheckResult {
  // Find subsystems referenced in issue
  const referencedSubsystems = detectSubsystemsInIssue(issueDescription, subsystems);

  // If no subsystems referenced, check all subsystems
  const subsystemsToCheck = referencedSubsystems.length > 0
    ? referencedSubsystems
    : subsystems;

  const staleSubsystems: Array<{ subsystem: Subsystem; status: DriftStatus }> = [];

  for (const subsystem of subsystemsToCheck) {
    const status = checkSubsystemDrift(subsystem, repoDir, thresholdDays);
    if (status.isStale) {
      staleSubsystems.push({ subsystem, status });
    }
  }

  return {
    staleSubsystems,
    totalChecked: subsystemsToCheck.length,
    hasDrift: staleSubsystems.length > 0,
  };
}

/**
 * Format drift check results for display.
 */
export function formatDriftWarning(result: DriftCheckResult): string {
  if (!result.hasDrift) {
    return '';
  }

  const lines: string[] = [];
  lines.push('⚠️  DRIFT DETECTED: Some subsystem specs are stale');
  lines.push('');
  lines.push('The following subsystems have been modified since their specs were last updated:');
  lines.push('');

  for (const { subsystem, status } of result.staleSubsystems) {
    lines.push(`  • ${subsystem.name} (${subsystem.id})`);
    lines.push(`    Last updated: ${status.specLastModified.toISOString().split('T')[0]} (${status.daysSinceUpdate} days ago)`);

    if (status.filesLastModified) {
      lines.push(`    Files modified: ${status.filesLastModified.toISOString().split('T')[0]}`);
    }

    if (status.recentPRs.length > 0) {
      lines.push(`    Recent PRs: ${status.recentPRs.slice(0, 3).join(', ')}${status.recentPRs.length > 3 ? '...' : ''}`);
    }

    lines.push('');
  }

  lines.push('Consider refreshing these specs before relying on them for implementation.');
  lines.push('Run: npx tsx tools/init-project-context.ts --force');
  lines.push('');

  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────
// Helper Functions
// ────────────────────────────────────────────────────────────────

/**
 * Get the most recent modification time of files in a list.
 */
function getMostRecentFileModification(files: string[], repoDir: string): Date | null {
  let mostRecent: Date | null = null;

  for (const file of files) {
    const filePath = join(repoDir, file);
    if (!existsSync(filePath)) continue;

    try {
      const stats = statSync(filePath);
      if (!mostRecent || stats.mtime > mostRecent) {
        mostRecent = stats.mtime;
      }
    } catch {
      // Skip files we can't stat
    }
  }

  return mostRecent;
}

/**
 * Get recent PRs that affected files in this subsystem.
 *
 * Looks at git log since the spec was last updated.
 */
function getRecentPRsForSubsystem(
  subsystem: Subsystem,
  repoDir: string,
  since: Date
): string[] {
  const prs = new Set<string>();

  try {
    const sinceStr = since.toISOString().split('T')[0];
    const fileArgs = subsystem.keyFiles.slice(0, 20).join(' '); // Limit to avoid overflow

    // Get commits since spec update
    const cmd = `git log --since="${sinceStr}" --oneline --grep="Merge pull request" -- ${fileArgs} 2>/dev/null`;
    const output = execShellCommand(cmd, { encoding: 'utf-8', cwd: repoDir });

    // Extract PR numbers from commit messages
    const lines = output.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const match = line.match(/#(\d+)/);
      if (match) {
        prs.add(`#${match[1]}`);
      }
    }
  } catch {
    // Git log failed, return empty
  }

  return Array.from(prs);
}
