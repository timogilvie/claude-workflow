/**
 * Subsystem cross-reference detection.
 *
 * Detects relationships between subsystems based on shared files and
 * generates bidirectional links for subsystem specification documentation.
 *
 * @module subsystem-cross-reference
 */

import type { Subsystem } from './subsystem-detector.ts';
import { basename, dirname } from 'node:path';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface RelatedSubsystem {
  /** Subsystem ID (kebab-case) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of relationship (e.g., "shares config.ts") */
  reason: string;
  /** Number of shared key files (for ranking) */
  sharedFileCount: number;
}

// ────────────────────────────────────────────────────────────────
// Cross-Reference Detection
// ────────────────────────────────────────────────────────────────

/**
 * Normalize file path for comparison.
 * Removes leading './' and ensures consistent format.
 */
function normalizePath(filePath: string): string {
  return filePath.replace(/^\.\//, '');
}

/**
 * Find shared key files between two subsystems.
 */
function findSharedFiles(subsystemA: Subsystem, subsystemB: Subsystem): string[] {
  const filesA = new Set(subsystemA.keyFiles.map(normalizePath));
  const filesB = new Set(subsystemB.keyFiles.map(normalizePath));

  const shared: string[] = [];
  for (const file of filesA) {
    if (filesB.has(file)) {
      shared.push(file);
    }
  }

  return shared;
}

/**
 * Generate a relationship reason based on shared files.
 */
function generateReason(sharedFiles: string[]): string {
  const count = sharedFiles.length;

  if (count === 0) {
    return '';
  }

  if (count === 1) {
    const filename = basename(sharedFiles[0]);
    return `shares \`${filename}\``;
  }

  // Find common directory for 2-3 files
  if (count <= 3) {
    const dirs = sharedFiles.map(f => dirname(f));
    const uniqueDirs = new Set(dirs);

    if (uniqueDirs.size === 1) {
      const dir = Array.from(uniqueDirs)[0];
      const dirName = dir === '.' ? 'root' : basename(dir);
      return `shares files in \`${dirName}\``;
    }

    // Multiple directories - just list count
    return `shares ${count} key files`;
  }

  // 4+ files - identify common directory or indicate close coupling
  const dirs = sharedFiles.map(f => dirname(f));
  const dirCounts = new Map<string, number>();

  for (const dir of dirs) {
    dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);
  }

  // Find most common directory
  let maxCount = 0;
  let commonDir = '';
  for (const [dir, count] of dirCounts) {
    if (count > maxCount) {
      maxCount = count;
      commonDir = dir;
    }
  }

  const dirName = commonDir === '.' ? 'root' : basename(commonDir);
  return `closely coupled via \`${dirName}\` modules`;
}

/**
 * Detect relationships between all subsystems.
 *
 * Returns a map of subsystem ID → list of related subsystems,
 * sorted by number of shared files (descending).
 *
 * Limits to top 5-7 relationships per subsystem to avoid noise.
 */
export function detectSubsystemRelationships(
  subsystems: Subsystem[],
  maxRelationships = 7
): Map<string, RelatedSubsystem[]> {
  const relationships = new Map<string, RelatedSubsystem[]>();

  // Initialize empty arrays for all subsystems
  for (const subsystem of subsystems) {
    relationships.set(subsystem.id, []);
  }

  // Detect relationships between all pairs
  for (let i = 0; i < subsystems.length; i++) {
    for (let j = i + 1; j < subsystems.length; j++) {
      const subsystemA = subsystems[i];
      const subsystemB = subsystems[j];

      const sharedFiles = findSharedFiles(subsystemA, subsystemB);

      if (sharedFiles.length > 0) {
        const reason = generateReason(sharedFiles);

        // Add bidirectional relationship
        relationships.get(subsystemA.id)!.push({
          id: subsystemB.id,
          name: subsystemB.name,
          reason,
          sharedFileCount: sharedFiles.length,
        });

        relationships.get(subsystemB.id)!.push({
          id: subsystemA.id,
          name: subsystemA.name,
          reason,
          sharedFileCount: sharedFiles.length,
        });
      }
    }
  }

  // Sort and limit each subsystem's relationships
  for (const [subsystemId, related] of relationships) {
    // Sort by shared file count (descending)
    related.sort((a, b) => b.sharedFileCount - a.sharedFileCount);

    // Limit to top N
    if (related.length > maxRelationships) {
      relationships.set(subsystemId, related.slice(0, maxRelationships));
    }
  }

  return relationships;
}
