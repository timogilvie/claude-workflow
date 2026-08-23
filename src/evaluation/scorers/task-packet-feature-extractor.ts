/** Deterministic, pre-dispatch features for task-packet readiness scoring. */
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  countCheckboxes,
  extractSection,
  isBoilerplateValidation,
  parseKeyFileEntries,
  runLayer1Validation,
} from '../../../shared/lib/task-packet-validator.ts';
import { classifyTaskDifficulty } from '../../../shared/lib/task-difficulty-classifier.ts';
import { analyzeTaskContext } from '../../../shared/lib/task-context-analyzer.ts';

export type TaskPacketFormat = 'full' | 'split' | 'legacy';
export type TaskPacketSectionName =
  | 'objective' | 'technical_context' | 'implementation_approach' | 'success_criteria'
  | 'implementation_constraints' | 'validation_steps' | 'definition_of_done'
  | 'rollback_plan' | 'release_readiness' | 'proposed_labels';

export type SectionLengths = Record<TaskPacketSectionName, number>;

export interface TaskPacketFeatures {
  packet_format: TaskPacketFormat;
  total_chars: number;
  total_lines: number;
  heading_count: number;
  section_lengths: SectionLengths;
  sections_present: number;
  file_count: number;
  new_file_count: number;
  file_count_total_packet: number;
  req_tag_count: number;
  nf_req_tag_count: number;
  checkbox_count: number;
  validation_scenario_count: number;
  edge_case_count: number;
  validation_has_code_block: number;
  validation_is_boilerplate: number;
  standard_command_count: number;
  scope_out_present: number;
  rollback_present: number;
  labels_present: number;
  risk_label: number;
  vague_word_density: number;
  layer1_error_count: number;
  layer1_warning_count: number;
  layer1_ran: number;
  difficulty: number;
  difficulty_label: string;
  complexity: number;
  task_type: string;
}

export class TaskPacketNotFoundError extends Error {
  readonly code = 'ENOENT_TASK_PACKET';
  constructor(input: string) {
    super(`Task packet not found at path ${input}`);
    this.name = 'TaskPacketNotFoundError';
  }
}

const SECTIONS: Array<[TaskPacketSectionName, string]> = [
  ['objective', 'Objective'], ['technical_context', 'Technical Context'],
  ['implementation_approach', 'Implementation Approach'], ['success_criteria', 'Success Criteria'],
  ['implementation_constraints', 'Implementation Constraints'], ['validation_steps', 'Validation Steps'],
  ['definition_of_done', 'Definition of Done'], ['rollback_plan', 'Rollback Plan'],
  ['release_readiness', 'Release Readiness'], ['proposed_labels', 'Proposed Labels'],
];
const DIFFICULTY: Record<string, number> = { trivial: 0, moderate: 1, hard: 2, critical: 3 };
const COMPLEXITY: Record<string, number> = { xs: 0, s: 1, m: 2, l: 3, xl: 4 };

function matches(text: string, expression: RegExp): number {
  return text.match(expression)?.length ?? 0;
}

function detectFormat(markdown: string): TaskPacketFormat {
  return SECTIONS.filter(([, heading]) => extractSection(markdown, heading) !== null).length >= 4
    ? 'full'
    : 'legacy';
}

/** Resolve a full packet or its header/details split representation. */
export function resolveTaskPacketPath(input: string): { packetPath: string; format: TaskPacketFormat } {
  const candidate = resolve(input);
  if (!existsSync(candidate)) throw new TaskPacketNotFoundError(input);
  if (!statSync(candidate).isDirectory()) return { packetPath: candidate, format: 'full' };
  const full = join(candidate, 'task-packet.md');
  if (existsSync(full)) return { packetPath: full, format: 'full' };
  const header = join(candidate, 'task-packet-header.md');
  const details = join(candidate, 'task-packet-details.md');
  if (existsSync(header) || existsSync(details)) return { packetPath: candidate, format: 'split' };
  throw new TaskPacketNotFoundError(input);
}

async function readPacket(resolved: { packetPath: string; format: TaskPacketFormat }): Promise<string> {
  if (resolved.format !== 'split') return readFile(resolved.packetPath, 'utf8');
  const pieces = await Promise.all(['task-packet-header.md', 'task-packet-details.md'].map(async (name) => {
    const path = join(resolved.packetPath, name);
    return existsSync(path) ? readFile(path, 'utf8') : '';
  }));
  return pieces.filter(Boolean).join('\n\n');
}

/** Extract packet-text features. This function has no filesystem reads. */
export function extractTaskPacketFeatures(markdown: string, opts: { repoDir?: string; format?: TaskPacketFormat } = {}): TaskPacketFeatures {
  const sections = Object.fromEntries(SECTIONS.map(([key, heading]) => [key, extractSection(markdown, heading) ?? ''])) as Record<TaskPacketSectionName, string>;
  const section_lengths = Object.fromEntries(SECTIONS.map(([key]) => [key, sections[key].length])) as SectionLengths;
  const validation = sections.validation_steps;
  const packetFiles = parseKeyFileEntries(markdown);
  const keyFiles = parseKeyFileEntries(extractSection(markdown, 'Key Files') ?? '');
  const allPaths = new Set([...packetFiles, ...keyFiles].map(({ path }) => path));
  const validationCommands = matches(validation, /^\s*(?:pnpm|npm|npx|node|bash)\b/gm);
  const vagueWords = matches(markdown, /\b(?:etc\.?|as needed|appropriate|and so on|tbd|similar|various)\b/gi);
  const difficultyResult = classifyTaskDifficulty({ packetContent: markdown, skipLlm: true, skipCache: true });
  const context = analyzeTaskContext({ issue: { description: markdown } });
  const layerIssues = opts.repoDir ? runLayer1Validation(markdown, opts.repoDir) : [];
  const format = opts.format ?? detectFormat(markdown);
  const risk = (extractSection(markdown, 'Proposed Labels') ?? markdown).match(/Risk\s*:\s*(low|medium|high)/i)?.[1]?.toLowerCase();

  return {
    packet_format: format,
    total_chars: markdown.length,
    total_lines: markdown ? markdown.split('\n').length : 0,
    heading_count: matches(markdown, /^#{1,6}\s+\S/gm),
    section_lengths,
    sections_present: Object.values(section_lengths).filter((length) => length > 0).length,
    file_count: allPaths.size,
    new_file_count: packetFiles.filter((entry) => entry.planned).length,
    file_count_total_packet: packetFiles.length,
    req_tag_count: matches(markdown, /\[REQ-F\d+\]/g),
    nf_req_tag_count: matches(markdown, /\[REQ-NF\d+\]/g),
    checkbox_count: countCheckboxes(markdown),
    validation_scenario_count: matches(validation, /validation scenario/gi),
    edge_case_count: matches(validation, /edge cases?/gi),
    validation_has_code_block: /```/.test(validation) ? 1 : 0,
    validation_is_boilerplate: isBoilerplateValidation(validation) ? 1 : 0,
    standard_command_count: validationCommands,
    scope_out_present: /scope\s+out/i.test(markdown) ? 1 : 0,
    rollback_present: sections.rollback_plan.length > 0 ? 1 : 0,
    labels_present: sections.proposed_labels.length > 0 ? 1 : 0,
    risk_label: risk === 'high' ? 2 : risk === 'medium' ? 1 : 0,
    vague_word_density: markdown.length ? Number(((vagueWords / markdown.length) * 1000).toFixed(4)) : 0,
    layer1_error_count: layerIssues.filter((issue) => issue.severity === 'error').length,
    layer1_warning_count: layerIssues.filter((issue) => issue.severity === 'warning').length,
    layer1_ran: opts.repoDir ? 1 : 0,
    difficulty: DIFFICULTY[difficultyResult.difficulty] ?? 1,
    difficulty_label: difficultyResult.difficulty,
    complexity: COMPLEXITY[context.complexity] ?? 2,
    task_type: context.taskType,
  };
}

/** Read a packet from disk then derive the reusable readiness feature vector. */
export async function extractTaskPacketFeaturesFromPath(input: string, opts: { repoDir?: string } = {}): Promise<TaskPacketFeatures> {
  const resolved = resolveTaskPacketPath(input);
  const markdown = await readPacket(resolved);
  return extractTaskPacketFeatures(markdown, { ...opts, format: resolved.format });
}
