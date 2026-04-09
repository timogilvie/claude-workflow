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
import { existsSync, readFileSync } from 'node:fs';
import { listConceptPaths, listContextSpecPaths } from './context-tool.ts';

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

export interface RelatedConcept {
  /** Concept ID (kebab-case) */
  id: string;
  /** Human-readable name */
  name: string;
  /** Always 'concept' for type discrimination */
  type: 'concept';
  /** Description of relationship */
  reason: string;
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
 * Extract concept or subsystem name from spec content.
 * Looks for "# Concept: Name" or "# Subsystem: Name" pattern.
 */
function extractSpecName(content: string): string {
  const match = content.match(/^#\s+(?:Concept|Subsystem):\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

/**
 * Detect concept references in a subsystem spec or another concept.
 * Looks for markdown links to concept pages.
 */
export function detectConceptReferences(
  specContent: string,
  repoDir: string
): RelatedConcept[] {
  const conceptPaths = listConceptPaths(repoDir);
  if (conceptPaths.length === 0) return [];

  const references: RelatedConcept[] = [];
  const seen = new Set<string>();

  // Pattern: [text](concepts/concept-id.md) or [text](concept-id.md)
  const linkPattern = /\[([^\]]+)\]\((?:concepts\/)?([^)]+\.md)\)/g;

  for (const match of specContent.matchAll(linkPattern)) {
    const linkedFile = match[2];
    const conceptId = linkedFile.replace('.md', '');

    if (seen.has(conceptId)) continue;

    // Find matching concept path
    const conceptPath = conceptPaths.find(p => p.endsWith(`/${conceptId}.md`));

    if (conceptPath && existsSync(conceptPath)) {
      const conceptContent = readFileSync(conceptPath, 'utf-8');
      const conceptName = extractSpecName(conceptContent) || conceptId;

      references.push({
        id: conceptId,
        name: conceptName,
        type: 'concept',
        reason: `references [${conceptName}](concepts/${conceptId}.md)`,
      });

      seen.add(conceptId);
    }
  }

  return references;
}

/**
 * Detect subsystem references in a concept page.
 * Looks for markdown links to subsystem specs.
 */
export function detectSubsystemReferencesFromConcept(
  conceptContent: string,
  repoDir: string
): RelatedSubsystem[] {
  const subsystemPaths = listContextSpecPaths(repoDir);
  if (subsystemPaths.length === 0) return [];

  const references: RelatedSubsystem[] = [];
  const seen = new Set<string>();

  // Pattern: [text](subsystem-id.md) or [text](../subsystem-id.md)
  const linkPattern = /\[([^\]]+)\]\((?:\.\.\/)?([^)]+\.md)\)/g;

  for (const match of conceptContent.matchAll(linkPattern)) {
    const linkedFile = match[2];
    const subsystemId = linkedFile.replace('.md', '');

    if (seen.has(subsystemId)) continue;

    // Find matching subsystem path
    const subsystemPath = subsystemPaths.find(p => p.endsWith(`/${subsystemId}.md`));

    if (subsystemPath && existsSync(subsystemPath)) {
      const subsystemContent = readFileSync(subsystemPath, 'utf-8');
      const subsystemName = extractSpecName(subsystemContent) || subsystemId;

      references.push({
        id: subsystemId,
        name: subsystemName,
        reason: `referenced by concept`,
        sharedFileCount: 0, // Not based on shared files
      });

      seen.add(subsystemId);
    }
  }

  return references;
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
