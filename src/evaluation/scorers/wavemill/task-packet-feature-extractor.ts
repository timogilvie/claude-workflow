/**
 * Feature extraction from task packets for the packet quality scorer.
 *
 * Extracts structural, content, and difficulty features from expanded task packets
 * to produce a feature vector for logistic regression scoring.
 *
 * @module task-packet-feature-extractor
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ComplexityBand, TaskType } from '../../../../shared/lib/eval-schema.ts';
import { classifyTaskDifficulty } from '../../../../shared/lib/task-difficulty-classifier.ts';
import { analyzeTaskContext } from '../../../../shared/lib/task-context-analyzer.ts';
import { extractReleaseReadiness, isTaskPacketContent } from '../../../../shared/lib/task-packet-utils.ts';
import { validateFileExistence } from '../../../../shared/lib/task-packet-validator.ts';

export type RoutingDifficulty = 'trivial' | 'moderate' | 'hard' | 'critical';

export interface TaskPacketFeatures {
  // Structural features
  totalChars: number;
  totalLines: number;
  hasQuickReferenceHeader: boolean;
  sectionPresent1: boolean;
  sectionPresent2: boolean;
  sectionPresent3: boolean;
  sectionPresent4: boolean;
  sectionPresent5: boolean;
  sectionPresent6: boolean;
  sectionPresent7: boolean;
  sectionPresent8: boolean;
  sectionPresent9: boolean;
  sectionPresent10: boolean;
  sectionPresent11: boolean;
  sectionCount: number;
  sectionLength1: number;
  sectionLength2: number;
  sectionLength3: number;
  sectionLength4: number;
  sectionLength5: number;
  sectionLength6: number;
  sectionLength7: number;
  sectionLength8: number;
  sectionLength9: number;
  sectionLength10: number;
  sectionLength11: number;

  // Content features
  keyFileCount: number;
  keyFilesMarkedNew: number;
  reqTagCount: number;
  validationScenarioCount: number;
  validationCommandCount: number;
  checkboxCount: number;
  implementationStepCount: number;
  scopeOutItems: number;
  vaguenessMarkerCount: number;
  hedgeWordRatio: number;
  hasReleaseReadiness: boolean;
  proposedRisk: 'low' | 'medium' | 'high' | 'unknown';

  // Difficulty controls (REQUIRED)
  difficultyHeuristic: number; // 0=trivial, 1=moderate, 2=hard, 3=critical
  complexityBand: number; // 0=xs, 1=s, 2=m, 3=l, 4=xl
  taskType: string;
  descriptionWordCount: number;
}

export class TaskPacketNotFoundError extends Error {
  code = 'ENOENT';
  constructor(path: string) {
    super(`Task packet not found at path: ${path}`);
    this.name = 'TaskPacketNotFoundError';
  }
}

const SECTION_HEADINGS = {
  1: ['objective', 'what', '1\\. objective'],
  2: ['technical context', 'architecture', '2\\. technical context'],
  3: ['implementation approach', 'approach', '3\\. implementation approach'],
  4: ['success criteria', 'acceptance criteria', '4\\. success criteria'],
  5: ['constraints', 'implementation constraints', '5\\. implementation constraints'],
  6: ['validation steps', 'validation', '6\\. validation steps'],
  7: ['definition of done', 'done', '7\\. definition of done'],
  8: ['rollback plan', 'rollback', '8\\. rollback plan'],
  9: ['release readiness', 'release', '9\\. release readiness'],
  10: ['release readiness', 'release', '10\\. release readiness'],
  11: ['proposed labels', 'labels', '11\\. proposed labels'],
} as const;

function stripFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

function splitSections(text: string): Map<number, string> {
  const stripped = stripFencedCode(text);
  const sections = new Map<number, string>();

  for (const [sectionNum, headings] of Object.entries(SECTION_HEADINGS)) {
    const num = parseInt(sectionNum, 10);
    let foundBody = '';

    for (const heading of headings) {
      const regex = new RegExp(`^#{1,6}\\s+(?:\\d+\\.\\s+)?${heading}.*$`, 'im');
      const match = stripped.match(regex);
      if (match) {
        const startIdx = match.index! + match[0]!.length;
        const nextSectionRegex = /^#{1,6}\s+(?:\d+\.\s+)?/m;
        const nextMatch = stripped.substring(startIdx).match(nextSectionRegex);
        foundBody = nextMatch ? stripped.substring(startIdx, startIdx + nextMatch.index) : stripped.substring(startIdx);
        break;
      }
    }

    if (foundBody) {
      sections.set(num, foundBody);
    }
  }

  return sections;
}

function extractKeyFiles(text: string): { count: number; newCount: number } {
  const keyFilesMatch = text.match(/## Key Files[\s\S]*?(?=##|$)/i);
  if (!keyFilesMatch) return { count: 0, newCount: 0 };

  const content = keyFilesMatch[0];
  const filePattern = /`([^`]+)`/g;
  const matches = Array.from(content.matchAll(filePattern));
  const newMatches = content.match(/\(new\)/gi) || [];

  return { count: matches.length, newCount: newMatches.length };
}

function countMatches(text: string, pattern: RegExp | string): number {
  let regex: RegExp;
  if (typeof pattern === 'string') {
    regex = new RegExp(pattern, 'g');
  } else {
    // Already a RegExp, ensure it has 'g' flag
    const flags = pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g';
    regex = new RegExp(pattern.source, flags);
  }
  const matches = text.match(regex) || [];
  return matches.length;
}

function extractProposedRisk(text: string): 'low' | 'medium' | 'high' | 'unknown' {
  const section = text.match(/## (?:\d+\. )?Proposed Labels[\s\S]*?(?=##|$)/i)?.[0] || '';
  if (!section) return 'unknown';

  if (/Risk:\s*(?:low|Low)/i.test(section)) return 'low';
  if (/Risk:\s*(?:medium|med|Medium|Med)/i.test(section)) return 'medium';
  if (/Risk:\s*(?:high|High)/i.test(section)) return 'high';
  return 'unknown';
}

function countHedgeWords(text: string): number {
  const hedgeWords = [
    'should',
    'might',
    'may',
    'possibly',
    'maybe',
    'perhaps',
    'arguably',
    'likely',
    'could',
    'might',
  ];
  const regex = new RegExp(`\\b(${hedgeWords.join('|')})\\b`, 'gi');
  return (text.match(regex) || []).length;
}

function countVaguenessMarkers(text: string): number {
  const markers = [
    'TBD',
    'TODO',
    'FIXME',
    'unclear',
    'to be determined',
    'as needed',
    'etc\\.',
    'and so on',
  ];
  const regex = new RegExp(`\\b(${markers.join('|')})\\b`, 'gi');
  return (text.match(regex) || []).length;
}

function mapDifficultyBandToOrdinal(difficulty: string): number {
  const map: Record<string, number> = {
    trivial: 0,
    moderate: 1,
    hard: 2,
    critical: 3,
  };
  return map[difficulty] ?? 1;
}

function mapComplexityBandToOrdinal(band: ComplexityBand): number {
  const map: Record<ComplexityBand, number> = {
    xs: 0,
    s: 1,
    m: 2,
    l: 3,
    xl: 4,
  };
  return map[band] ?? 2;
}

/**
 * Extract features from task packet text.
 *
 * @param packetText The full task packet markdown text
 * @param opts Optional title and repoDir for difficulty controls
 * @returns Feature vector (always returns a vector, never throws)
 */
export function extractFeaturesFromText(
  packetText: string,
  opts?: { title?: string; repoDir?: string },
): TaskPacketFeatures {
  const sections = splitSections(packetText);

  // Structural features
  const totalChars = packetText.length;
  const totalLines = packetText.split('\n').length;
  const hasQuickReferenceHeader = /quick reference/i.test(packetText);
  const sectionCount = sections.size;

  // Section presence and lengths
  const sectionPresent: Record<number, boolean> = {};
  const sectionLength: Record<number, number> = {};
  for (let i = 1; i <= 11; i++) {
    sectionPresent[i] = sections.has(i);
    sectionLength[i] = sections.get(i)?.length ?? 0;
  }

  // Content features
  const { count: keyFileCount, newCount: keyFilesMarkedNew } = extractKeyFiles(packetText);
  const reqTagCount = countMatches(packetText, /\[REQ-[NF]#\d+\]/g);
  const validationScenarioCount = countMatches(packetText, /validation scenario/gi);
  const validationCommandCount = countMatches(packetText, /```(?:sh|bash|shell)/gi);
  const checkboxCount = countMatches(packetText, /- \[x?\]/g);
  const implementationStepCount = countMatches(packetText, /^\d+\.\s+/m);
  const scopeOutItems = countMatches(
    packetText.match(/## (?:\d+\. )?Scope Out[\s\S]*?(?=##|$)/i)?.[0] || '',
    /^-/gm,
  );
  const vaguenessMarkerCount = countVaguenessMarkers(packetText);
  const wordCount = packetText.split(/\s+/).length;
  const hedgeWordRatio = wordCount > 0 ? countHedgeWords(packetText) / (wordCount / 100) : 0;
  const releaseReadiness = extractReleaseReadiness(packetText);
  const hasReleaseReadiness = releaseReadiness !== null;
  const proposedRisk = extractProposedRisk(packetText);

  // Difficulty controls via heuristic classifiers
  let difficultyHeuristic = 1; // default: moderate
  let complexityBand: number = 2; // default: m
  let taskType = 'feature';
  let descriptionWordCount = 0;

  try {
    const diffResult = classifyTaskDifficulty({
      title: opts?.title || 'Task Packet',
      description: packetText,
      skipLlm: true,
    });
    difficultyHeuristic = mapDifficultyBandToOrdinal(diffResult.difficulty);
  } catch {
    // Use default if classification fails
  }

  try {
    const contextResult = analyzeTaskContext({
      issue: {
        title: opts?.title || 'Task Packet',
        description: packetText,
      },
    });
    complexityBand = mapComplexityBandToOrdinal(contextResult.complexity);
    taskType = contextResult.taskType;
    descriptionWordCount = packetText.split(/\s+/).length;
  } catch {
    // Use defaults if analysis fails
  }

  return {
    totalChars,
    totalLines,
    hasQuickReferenceHeader,
    sectionPresent1: sectionPresent[1] || false,
    sectionPresent2: sectionPresent[2] || false,
    sectionPresent3: sectionPresent[3] || false,
    sectionPresent4: sectionPresent[4] || false,
    sectionPresent5: sectionPresent[5] || false,
    sectionPresent6: sectionPresent[6] || false,
    sectionPresent7: sectionPresent[7] || false,
    sectionPresent8: sectionPresent[8] || false,
    sectionPresent9: sectionPresent[9] || false,
    sectionPresent10: sectionPresent[10] || false,
    sectionPresent11: sectionPresent[11] || false,
    sectionCount,
    sectionLength1: sectionLength[1] || 0,
    sectionLength2: sectionLength[2] || 0,
    sectionLength3: sectionLength[3] || 0,
    sectionLength4: sectionLength[4] || 0,
    sectionLength5: sectionLength[5] || 0,
    sectionLength6: sectionLength[6] || 0,
    sectionLength7: sectionLength[7] || 0,
    sectionLength8: sectionLength[8] || 0,
    sectionLength9: sectionLength[9] || 0,
    sectionLength10: sectionLength[10] || 0,
    sectionLength11: sectionLength[11] || 0,
    keyFileCount,
    keyFilesMarkedNew,
    reqTagCount,
    validationScenarioCount,
    validationCommandCount,
    checkboxCount,
    implementationStepCount,
    scopeOutItems,
    vaguenessMarkerCount,
    hedgeWordRatio,
    hasReleaseReadiness,
    proposedRisk,
    difficultyHeuristic,
    complexityBand,
    taskType,
    descriptionWordCount,
  };
}

/**
 * Extract features from a task packet file or directory.
 *
 * Accepts a `task-packet.md` file, or a directory containing
 * `task-packet.md`, or both `task-packet-header.md` and `task-packet-details.md`.
 *
 * @param path File or directory path
 * @param opts Optional extraction options
 * @returns Feature vector
 * @throws TaskPacketNotFoundError if path does not exist or contains no packet
 */
export function extractTaskPacketFeatures(
  path: string,
  opts?: { title?: string; repoDir?: string },
): TaskPacketFeatures {
  let packetText = '';

  if (existsSync(path)) {
    const stat = statSync(path);

    if (stat.isFile()) {
      // Single file case
      packetText = readFileSync(path, 'utf-8');
    } else if (stat.isDirectory()) {
      // Directory case: try task-packet.md first
      const packetPath = join(path, 'task-packet.md');
      if (existsSync(packetPath)) {
        packetText = readFileSync(packetPath, 'utf-8');
      } else {
        // Fall back to header + details concatenated
        const headerPath = join(path, 'task-packet-header.md');
        const detailsPath = join(path, 'task-packet-details.md');

        if (existsSync(headerPath) && existsSync(detailsPath)) {
          const header = readFileSync(headerPath, 'utf-8');
          const details = readFileSync(detailsPath, 'utf-8');
          packetText = header + '\n\n' + details;
        }
      }
    }
  }

  if (!packetText || !isTaskPacketContent(packetText)) {
    throw new TaskPacketNotFoundError(path);
  }

  return extractFeaturesFromText(packetText, opts);
}
