/**
 * Subsystem file mapping for drift detection and smart updates.
 *
 * Maps individual files to their parent subsystems to enable:
 * - Detecting which subsystems are affected by a PR
 * - Checking if subsystem docs are stale before issue expansion
 * - Auto-updating subsystem specs after PR merge
 *
 * @module subsystem-mapper
 */

import { relative, join, dirname } from 'node:path';
import type { Subsystem } from './subsystem-detector.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface FileToSubsystemMap {
  /** Map from file path (relative to repo) to subsystem ID */
  fileMap: Map<string, string>;
  /** Reverse map: subsystem ID to files */
  subsystemFiles: Map<string, string[]>;
  /** All subsystems */
  subsystems: Subsystem[];
}

// ────────────────────────────────────────────────────────────────
// Mapping Functions
// ────────────────────────────────────────────────────────────────

/**
 * Create a bidirectional mapping between files and subsystems.
 */
export function createFileToSubsystemMap(subsystems: Subsystem[]): FileToSubsystemMap {
  const fileMap = new Map<string, string>();
  const subsystemFiles = new Map<string, string[]>();

  for (const subsystem of subsystems) {
    subsystemFiles.set(subsystem.id, [...subsystem.keyFiles]);

    for (const file of subsystem.keyFiles) {
      // If file already mapped, prefer higher confidence subsystem
      if (fileMap.has(file)) {
        const existingId = fileMap.get(file)!;
        const existing = subsystems.find(s => s.id === existingId);
        if (existing && existing.confidence >= subsystem.confidence) {
          continue; // Keep existing mapping
        }
      }

      fileMap.set(file, subsystem.id);
    }
  }

  return { fileMap, subsystemFiles, subsystems };
}

/**
 * Map a list of files to their subsystems.
 *
 * Returns a map of subsystem ID to matching files.
 */
export function mapFilesToSubsystems(
  files: string[],
  subsystems: Subsystem[],
  repoDir?: string
): Map<string, string[]> {
  const mapping = createFileToSubsystemMap(subsystems);
  const result = new Map<string, string[]>();

  for (const file of files) {
    // Normalize file path (relative to repo)
    const normalized = repoDir ? relative(repoDir, file) : file;

    // Direct match
    if (mapping.fileMap.has(normalized)) {
      const subsystemId = mapping.fileMap.get(normalized)!;
      if (!result.has(subsystemId)) result.set(subsystemId, []);
      result.get(subsystemId)!.push(normalized);
      continue;
    }

    // Fuzzy match: check if file is in a subsystem's directory
    const subsystem = findSubsystemByDirectory(normalized, subsystems);
    if (subsystem) {
      if (!result.has(subsystem.id)) result.set(subsystem.id, []);
      result.get(subsystem.id)!.push(normalized);
    }
  }

  return result;
}

/**
 * Get the subsystem for a single file.
 *
 * Returns null if no subsystem matches.
 */
export function getSubsystemForFile(
  file: string,
  subsystems: Subsystem[],
  repoDir?: string
): Subsystem | null {
  const mapping = createFileToSubsystemMap(subsystems);
  const normalized = repoDir ? relative(repoDir, file) : file;

  // Direct match
  if (mapping.fileMap.has(normalized)) {
    const subsystemId = mapping.fileMap.get(normalized)!;
    return subsystems.find(s => s.id === subsystemId) || null;
  }

  // Fuzzy match
  return findSubsystemByDirectory(normalized, subsystems);
}

/**
 * Find subsystem by checking if file is in a subsystem's directory.
 *
 * Uses longest common prefix matching.
 */
function findSubsystemByDirectory(file: string, subsystems: Subsystem[]): Subsystem | null {
  let bestMatch: Subsystem | null = null;
  let bestMatchLength = 0;

  for (const subsystem of subsystems) {
    for (const keyFile of subsystem.keyFiles) {
      const keyDir = dirname(keyFile);
      if (file.startsWith(keyDir + '/') || file.startsWith(keyDir)) {
        const matchLength = keyDir.length;
        if (matchLength > bestMatchLength) {
          bestMatch = subsystem;
          bestMatchLength = matchLength;
        }
      }
    }
  }

  return bestMatch;
}

/**
 * Detect subsystems affected by a PR diff.
 *
 * Parses the diff to extract modified files, then maps to subsystems.
 */
export function detectAffectedSubsystems(
  prDiff: string,
  subsystems: Subsystem[],
  repoDir?: string
): Subsystem[] {
  const files = extractFilesFromDiff(prDiff);
  const subsystemMap = mapFilesToSubsystems(files, subsystems, repoDir);

  const affected: Subsystem[] = [];
  for (const subsystemId of subsystemMap.keys()) {
    const subsystem = subsystems.find(s => s.id === subsystemId);
    if (subsystem) affected.push(subsystem);
  }

  return affected;
}

/**
 * Extract file paths from a git diff.
 */
function extractFilesFromDiff(diff: string): string[] {
  const files = new Set<string>();

  // Match "diff --git a/path/to/file b/path/to/file"
  const diffPattern = /^diff --git a\/(.+?) b\/(.+?)$/gm;
  let match;

  while ((match = diffPattern.exec(diff)) !== null) {
    // Use the 'b' path (after change)
    files.add(match[2]);
  }

  // Also match "+++ b/path/to/file"
  const plusPattern = /^\+\+\+ b\/(.+?)$/gm;
  while ((match = plusPattern.exec(diff)) !== null) {
    if (match[1] !== '/dev/null') {
      files.add(match[1]);
    }
  }

  return Array.from(files);
}

/**
 * Detect files mentioned in an issue description.
 *
 * Looks for:
 * - Markdown code blocks with file paths
 * - Backtick-wrapped paths (e.g., `path/to/file.ts`)
 * - Common file patterns
 */
export function detectFilesInIssue(issueDescription: string): string[] {
  const files = new Set<string>();

  // Match backtick-wrapped paths
  const backtickPattern = /`([a-zA-Z0-9_\-./]+\.(ts|js|tsx|jsx|py|go|rs|java|rb|php|cs|cpp|c|swift|kt|sh|md|json|yaml|yml))`/g;
  let match;

  while ((match = backtickPattern.exec(issueDescription)) !== null) {
    files.add(match[1]);
  }

  // Match code blocks with file paths
  const codeBlockPattern = /```[a-z]*\n([^`]+)```/g;
  while ((match = codeBlockPattern.exec(issueDescription)) !== null) {
    const content = match[1];
    const lines = content.split('\n');

    for (const line of lines) {
      // Look for "// path/to/file.ts" or "# path/to/file.py"
      const commentMatch = line.match(/^[/#]+\s*([a-zA-Z0-9_\-./]+\.(ts|js|tsx|jsx|py|go|rs|java|rb|php|cs|cpp|c|swift|kt|sh|md))/);
      if (commentMatch) {
        files.add(commentMatch[1]);
      }
    }
  }

  return Array.from(files);
}

/**
 * Detect subsystems referenced in an issue description.
 *
 * Combines file detection with subsystem mapping.
 */
export function detectSubsystemsInIssue(
  issueDescription: string,
  subsystems: Subsystem[]
): Subsystem[] {
  const files = detectFilesInIssue(issueDescription);
  if (files.length === 0) return [];

  const subsystemMap = mapFilesToSubsystems(files, subsystems);
  const referenced: Subsystem[] = [];

  for (const subsystemId of subsystemMap.keys()) {
    const subsystem = subsystems.find(s => s.id === subsystemId);
    if (subsystem) referenced.push(subsystem);
  }

  return referenced;
}
