/**
 * Task Packet Utilities
 *
 * Provides utilities for working with task packets - structured documents
 * that describe implementation tasks for AI agents.
 *
 * Supports both legacy (single-file) and progressive disclosure (header/details)
 * formats.
 *
 * @module task-packet-utils
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/**
 * Result of splitting a task packet into header and details sections.
 */
export interface TaskPacketParts {
  /** Brief header (~50 lines) with objective, key files, top constraints */
  header: string;
  /** Full details with all 9 sections */
  details: string;
  /** Complete content (header + details) for backward compatibility */
  fullContent: string;
}

/**
 * Structured release-readiness metadata extracted from a task packet.
 * Used by the ready-stage engine to compare implementation against planning expectations.
 */
export interface ReleaseReadiness {
  /** Whether the task is expected to involve database schema changes */
  databaseChangeRisk: 'none' | 'possible' | 'required';
  /** Environment variables that must be added or changed for deployment */
  envChanges: string[];
  /** Configuration file changes required for deployment */
  configChanges: string[];
  /** Manual steps required before or after merge */
  manualSteps: string[];
}

export interface TaskPacketArtifactPaths {
  full: string;
  header: string;
  details: string;
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Split a task packet into header and details sections.
 *
 * Uses the `<!-- SPLIT: HEADER ABOVE, DETAILS BELOW -->` marker to divide
 * the content. If no marker is found (legacy format), generates a simple
 * header from the objective and key files sections.
 *
 * @param text - Complete task packet content
 * @returns Object with header, details, and fullContent
 *
 * @example
 * ```typescript
 * const taskPacket = await fs.readFile('task-packet.md', 'utf-8');
 * const { header, details, fullContent } = splitTaskPacket(taskPacket);
 *
 * // Save header for quick loading
 * await fs.writeFile('task-packet-header.md', header);
 * await fs.writeFile('task-packet-details.md', details);
 * ```
 */
export function splitTaskPacket(text: string): TaskPacketParts {
  const splitMarker = '<!-- SPLIT: HEADER ABOVE, DETAILS BELOW -->';
  const splitIndex = text.indexOf(splitMarker);

  if (splitIndex === -1) {
    // No split marker found - treat entire content as details (backward compat)
    // Generate a simple header from the details
    const objectiveMatch = text.match(/##\s*1\.\s*Objective[\s\S]*?(?=##\s*2\.)/i);
    const keyFilesMatch = text.match(/###\s*Key Files[\s\S]*?(?=###|##)/i);

    const simpleHeader =
      `# Task Packet\n\n` +
      `## Objective\n\n${objectiveMatch ? objectiveMatch[0] : 'See details below'}\n\n` +
      `## Key Files\n\n${keyFilesMatch ? keyFilesMatch[0] : 'See details below'}\n\n` +
      `## Full Details\n\nComplete task packet with all sections available below.\n`;

    return {
      header: simpleHeader,
      details: text,
      fullContent: text,
    };
  }

  // Split at marker
  const header = text.substring(0, splitIndex).trim();
  const details = text.substring(splitIndex + splitMarker.length).trim();

  // Full content for Linear (header + details without marker)
  const fullContent = `${header}\n\n---\n\n${details}`;

  return { header, details, fullContent };
}

/**
 * Validate that output looks like a structured task packet.
 *
 * Checks for presence of expected section headers. This is a lightweight
 * validation to catch cases where the LLM generated conversational text
 * instead of structured markdown.
 *
 * @param text - Text to validate
 * @returns True if text contains expected task packet sections
 *
 * @example
 * ```typescript
 * const output = await callClaude(prompt);
 * if (!isValidTaskPacket(output)) {
 *   throw new Error('LLM output is not a valid task packet');
 * }
 * ```
 */
export function isValidTaskPacket(text: string): boolean {
  // Must contain at least one of the expected section headers
  return /##\s*(1\.|Objective|What|Technical Context|Success Criteria|Implementation)/i.test(
    text
  );
}

/**
 * Check if a file path points to a task packet (by naming convention).
 *
 * Recognizes both legacy and progressive disclosure formats:
 * - task-packet.md, task-packet-header.md, task-packet-details.md
 * - Any file matching the task-packet*.md pattern
 *
 * @param filePath - File path to check
 * @returns True if file appears to be a task packet
 *
 * @example
 * ```typescript
 * isTaskPacketFile('features/foo/task-packet.md'); // true
 * isTaskPacketFile('features/foo/task-packet-header.md'); // true
 * isTaskPacketFile('features/foo/README.md'); // false
 * ```
 */
export function isTaskPacketFile(filePath: string): boolean {
  return /task-packet.*\.md$/.test(filePath);
}

/**
 * Derive the conventional task-packet artifact paths from the full packet path.
 */
export function getTaskPacketArtifactPaths(outputFile: string): TaskPacketArtifactPaths {
  const parsed = path.parse(outputFile);
  const ext = parsed.ext || '.md';
  const basePath = path.join(parsed.dir, parsed.name);

  return {
    full: outputFile,
    header: `${basePath}-header${ext}`,
    details: `${basePath}-details${ext}`,
  };
}

/**
 * Persist task packet artifacts and ensure the parent directory exists.
 */
export async function writeTaskPacketArtifacts(
  outputFile: string,
  parts: TaskPacketParts
): Promise<TaskPacketArtifactPaths> {
  const paths = getTaskPacketArtifactPaths(outputFile);

  await fs.mkdir(path.dirname(paths.full), { recursive: true });
  await fs.writeFile(paths.header, parts.header, 'utf-8');
  await fs.writeFile(paths.details, parts.details, 'utf-8');
  await fs.writeFile(paths.full, parts.fullContent, 'utf-8');

  return paths;
}

// ────────────────────────────────────────────────────────────────
// Release Readiness Extraction
// ────────────────────────────────────────────────────────────────

const VALID_DB_RISK_VALUES = ['none', 'possible', 'required'] as const;

/**
 * Parse a comma-separated list field value into an array of trimmed strings.
 * Returns an empty array for `none` or empty/missing values.
 */
function parseListField(value: string | undefined): string[] {
  if (!value || value.trim().toLowerCase() === 'none' || value.trim() === '') {
    return [];
  }
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Extract structured release-readiness metadata from a task packet.
 *
 * Looks for a `## Release Readiness` section and parses the bold-label
 * key-value format used by the issue-writer prompt template.
 *
 * Returns `null` if the section is not present (backward compatibility
 * with existing task packets).
 *
 * @param markdown - Task packet markdown content
 * @returns Parsed release readiness metadata, or null if section absent
 *
 * @example
 * ```typescript
 * const readiness = extractReleaseReadiness(taskPacketMarkdown);
 * if (readiness) {
 *   console.log(readiness.databaseChangeRisk); // 'none' | 'possible' | 'required'
 *   console.log(readiness.envChanges);          // ['NEW_API_KEY', 'FEATURE_FLAG_X']
 * }
 * ```
 */
export function extractReleaseReadiness(markdown: string): ReleaseReadiness | null {
  // Find the ## Release Readiness section
  const sectionMatch = markdown.match(/^##\s+Release Readiness\s*$/im);
  if (!sectionMatch || sectionMatch.index === undefined) {
    return null;
  }

  // Extract section content up to the next ## heading
  const sectionStart = sectionMatch.index + sectionMatch[0].length;
  const rest = markdown.substring(sectionStart);
  const nextHeadingMatch = rest.match(/^##\s+/m);
  const sectionContent = nextHeadingMatch && nextHeadingMatch.index !== undefined
    ? rest.substring(0, nextHeadingMatch.index)
    : rest;

  // Parse bold-label key-value pairs: - **field_name**: value
  const fieldPattern = /[-*]\s+\*\*(\w+)\*\*:\s*(.+)/g;
  const fields = new Map<string, string>();
  let match;
  while ((match = fieldPattern.exec(sectionContent)) !== null) {
    fields.set(match[1].toLowerCase(), match[2].trim());
  }

  // Extract database_change_risk — take only the first word to match the enum
  const rawDbRisk = fields.get('database_change_risk')?.split(/\s/)[0];
  const dbRisk = rawDbRisk && VALID_DB_RISK_VALUES.includes(rawDbRisk as any)
    ? (rawDbRisk as ReleaseReadiness['databaseChangeRisk'])
    : 'none';

  return {
    databaseChangeRisk: dbRisk,
    envChanges: parseListField(fields.get('env_changes')),
    configChanges: parseListField(fields.get('config_changes')),
    manualSteps: parseListField(fields.get('manual_steps')),
  };
}
