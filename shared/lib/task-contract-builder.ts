/**
 * Task Contract Projection Builder
 *
 * Produces a deterministic, machine-readable `task-contract.json` from existing
 * task packet and plan markdown artifacts in a feature directory. This is a
 * projection only — it does not author a new contract surface, replace existing
 * artifacts, or control any phase transitions.
 *
 * @module task-contract-builder
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { extractReleaseReadiness } from './task-packet-utils.ts';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

export const TASK_CONTRACT_SCHEMA_VERSION = '1.0.0';

const RECOGNIZED_ARTIFACTS = [
  'task-packet-header',
  'task-packet-details',
  'task-packet',
  'plan',
] as const;

type ArtifactName = typeof RECOGNIZED_ARTIFACTS[number];

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface TaskContractSource {
  artifact: ArtifactName;
  path: string;
  sha256: string;
}

export interface TaskContractCriterion {
  id: string;
  text: string;
  synthesized: boolean;
}

export interface TaskContractReleaseReadiness {
  database_change_risk: 'none' | 'possible' | 'required' | null;
  env_changes: string[];
  config_changes: string[];
  manual_steps: string[];
}

export interface TaskContractRoutingHints {
  taskType: string | null;
  riskLevel: 'low' | 'medium' | 'high' | null;
  requiresTests: boolean | null;
  hasMigration: boolean | null;
  hasUi: boolean | null;
  crossService: boolean | null;
  expectedFileTypes: string[];
}

export interface TaskContract {
  schemaVersion: '1.0.0';
  issueId: string | null;
  slug: string;
  sources: TaskContractSource[];
  objectiveSummary: string | null;
  taskType: string | null;
  subsystems: string[];
  componentLabels: string[];
  risk: {
    level: 'Low' | 'Medium' | 'High' | null;
    reasons: string[];
  };
  paths: {
    allowed: string[];
    expected: string[];
  };
  outOfScope: string[];
  successCriteria: TaskContractCriterion[];
  verification: {
    commands: string[];
    scenarios: string[];
  };
  releaseReadiness: TaskContractReleaseReadiness;
  routingHints: TaskContractRoutingHints;
  missingFields: string[];
  extractionWarnings: string[];
}

// ────────────────────────────────────────────────────────────────
// Internal: artifact discovery
// ────────────────────────────────────────────────────────────────

interface ArtifactEntry {
  name: ArtifactName;
  path: string;
  content: string;
  sha256: string;
}

async function readArtifact(
  featureDir: string,
  name: ArtifactName,
): Promise<ArtifactEntry | null> {
  const filePath = join(featureDir, `${name}.md`);
  if (!existsSync(filePath)) {
    return null;
  }
  const content = await fs.readFile(filePath, 'utf-8');
  const sha256 = createHash('sha256').update(content, 'utf-8').digest('hex');
  return { name, path: filePath, content, sha256 };
}

async function discoverArtifacts(featureDir: string): Promise<ArtifactEntry[]> {
  const results: ArtifactEntry[] = [];
  for (const name of RECOGNIZED_ARTIFACTS) {
    const entry = await readArtifact(featureDir, name);
    if (entry) {
      results.push(entry);
    }
  }
  return results;
}

function buildSources(
  artifacts: ArtifactEntry[],
  repoDir: string,
): TaskContractSource[] {
  return artifacts.map((a) => {
    const rel = relative(repoDir, a.path);
    const path = rel.startsWith('..') ? a.path : rel;
    return { artifact: a.name, path, sha256: a.sha256 };
  });
}

// ────────────────────────────────────────────────────────────────
// Internal: markdown section extraction
// ────────────────────────────────────────────────────────────────

/**
 * Extract the text content of a named section from markdown.
 * Matches `## <optional-number>. <title>` case-insensitively.
 * Returns the section body (excluding the heading line) or null.
 */
function extractSection(markdown: string, ...titleVariants: string[]): string | null {
  for (const title of titleVariants) {
    // Match ## optionally followed by digits/dot then the title
    const pattern = new RegExp(
      `^##[^\\S\\n]*(?:\\d+\\.\\s*)?${escapeRegex(title)}[^\\S\\n]*$`,
      'im',
    );
    const match = pattern.exec(markdown);
    if (match === null || match.index === undefined) {
      continue;
    }
    const after = markdown.slice(match.index + match[0].length);
    // Grab up to the next ## heading
    const nextHeading = /^##[^#]/m.exec(after);
    const body = nextHeading !== null && nextHeading.index !== undefined
      ? after.slice(0, nextHeading.index)
      : after;
    return body.trim();
  }
  return null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Choose the best content for extraction given the discovered artifacts.
 * Prefer details file over full packet; concatenate header+details when both exist.
 */
function chooseExtractionContent(artifacts: ArtifactEntry[]): string {
  const byName = new Map<ArtifactName, ArtifactEntry>();
  for (const a of artifacts) {
    byName.set(a.name, a);
  }

  const header = byName.get('task-packet-header');
  const details = byName.get('task-packet-details');
  const full = byName.get('task-packet');
  const plan = byName.get('plan');

  const parts: string[] = [];

  if (header && details) {
    // Progressive disclosure: concatenate both
    parts.push(header.content, details.content);
  } else if (details) {
    parts.push(details.content);
  } else if (header) {
    parts.push(header.content);
  } else if (full) {
    parts.push(full.content);
  }

  if (plan) {
    parts.push(plan.content);
  }

  return parts.join('\n\n');
}

// ────────────────────────────────────────────────────────────────
// Internal: field extractors
// ────────────────────────────────────────────────────────────────

function extractIssueId(content: string): string | null {
  // Match: **Issue ID**: HOK-1234 or Issue ID: HOK-1234
  const match = /\*{0,2}Issue\s+ID\*{0,2}:\s*([A-Z]+-\d+)/i.exec(content);
  if (match) {
    return match[1];
  }
  return null;
}

function extractObjectiveSummary(content: string): string | null {
  const section = extractSection(content, 'Objective');
  if (!section) {
    return null;
  }
  // Take the first meaningful paragraph (skip sub-headings, bullet leaders)
  const lines = section.split('\n');
  const paragraphLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (paragraphLines.length > 0) break; // end of first paragraph
      continue;
    }
    if (/^#+\s/.test(trimmed)) break; // sub-heading
    paragraphLines.push(trimmed);
  }
  const text = paragraphLines.join(' ').trim();
  return text || null;
}

const TASK_TYPE_PATTERNS: Array<[string, RegExp]> = [
  ['bugfix', /\b(fix|bug|broken|regression|error|crash)\b/i],
  ['refactor', /\b(refactor|cleanup|reorganize|simplify)\b/i],
  ['chore', /\b(chore|upgrade|dependency|deps|maintenance)\b/i],
  ['docs', /\b(docs|documentation|readme|docstring)\b/i],
  ['test', /\b(test(?:ing)?|coverage|spec|e2e)\b/i],
  ['infra', /\b(infra|ci|cd|deploy|build|pipeline|docker|k8s)\b/i],
  ['feature', /\b(add|feature|implement|create|produce|build|support)\b/i],
];

function inferTaskTypeFromText(text: string): string {
  for (const [type, pattern] of TASK_TYPE_PATTERNS) {
    if (pattern.test(text)) {
      return type;
    }
  }
  return 'feature';
}

function extractTaskType(content: string): string | null {
  // Check proposed labels for a Type: label
  const labelsSection = extractSection(content, 'Proposed Labels');
  if (labelsSection) {
    const typeMatch = /\bType:\s*(\S+)/i.exec(labelsSection);
    if (typeMatch) {
      return typeMatch[1].replace(/[,;]$/, '').toLowerCase();
    }
  }
  // Fall back to heuristic from objective
  const objective = extractSection(content, 'Objective');
  if (objective) {
    return inferTaskTypeFromText(objective);
  }
  // Use first 200 chars of content
  return inferTaskTypeFromText(content.slice(0, 200));
}

function extractSubsystems(content: string): string[] {
  const subsystems = new Set<string>();
  const techSection = extractSection(content, 'Technical Context', 'Technical context');
  const searchIn = techSection ?? content;

  // Match lines like "- shared/lib/..." or "Subsystem: X"
  const subsysMatch = searchIn.matchAll(/subsystem[:\s]+([a-zA-Z0-9_-]+)/gi);
  for (const m of subsysMatch) {
    subsystems.add(m[1].toLowerCase());
  }

  // Infer from key file paths like shared/lib/task-contract-builder.ts
  const pathMatches = searchIn.matchAll(/`([a-zA-Z0-9_/-]+\/[a-zA-Z0-9_/-]+\.ts)`/g);
  for (const m of pathMatches) {
    const parts = m[1].split('/');
    if (parts.length >= 2) {
      subsystems.add(parts.slice(0, 2).join('/'));
    }
  }

  return Array.from(subsystems).sort();
}

/**
 * Extract the clean label summary block from a Proposed Labels section.
 * Many generated packets include a fenced "Label Summary" block with bullet lines.
 */
function extractLabelSummaryBlock(labelsSection: string): string | null {
  // Look for a fenced block containing label-style bullets
  const fencedMatch = /```[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = fencedMatch.exec(labelsSection)) !== null) {
    const block = m[1];
    if (/^\s*[-*]?\s*(Risk|Layer|Area|Component|Type|Files|Tests):/im.test(block)) {
      return block;
    }
  }
  return null;
}

function extractLabelValue(labelsSection: string, key: string): string | null {
  // First try the Label Summary fenced block
  const summaryBlock = extractLabelSummaryBlock(labelsSection);
  const searchIn = summaryBlock ?? labelsSection;

  // Match: `Key: Value` (backtick-quoted label syntax)
  const backtickMatch = new RegExp(
    `\`${escapeRegex(key)}:\\s*([^\`]+)\``,
    'i',
  ).exec(searchIn);
  if (backtickMatch) {
    return backtickMatch[1].trim();
  }

  // Match: - Key: Value (bullet list)
  const bulletMatch = new RegExp(
    `^[-*]?\\s*${escapeRegex(key)}:\\s*(.+)$`,
    'im',
  ).exec(searchIn);
  if (bulletMatch) {
    return bulletMatch[1].trim();
  }

  return null;
}

function extractComponentLabels(content: string): string[] {
  const labels = new Set<string>();
  const labelsSection = extractSection(content, 'Proposed Labels');
  if (!labelsSection) return [];

  const keys = ['Area', 'Layer', 'Component', 'Type'];
  for (const key of keys) {
    const val = extractLabelValue(labelsSection, key);
    if (val) {
      // Strip trailing annotation like "(task-contract projection...)"
      const clean = val.replace(/\s*\(.*$/, '').trim();
      if (clean) labels.add(clean);
    }
  }
  return Array.from(labels).sort();
}

function normalizeRiskLevel(raw: string): 'Low' | 'Medium' | 'High' | null {
  const lower = raw.trim().toLowerCase();
  if (lower === 'low') return 'Low';
  if (lower === 'medium') return 'Medium';
  if (lower === 'high') return 'High';
  return null;
}

function extractRisk(content: string): { level: 'Low' | 'Medium' | 'High' | null; reasons: string[] } {
  const labelsSection = extractSection(content, 'Proposed Labels');
  let level: 'Low' | 'Medium' | 'High' | null = null;
  const reasons: string[] = [];

  if (labelsSection) {
    // Try using the label value extractor (handles both summary block and backtick format)
    const riskVal = extractLabelValue(labelsSection, 'Risk');
    if (riskVal) {
      level = normalizeRiskLevel(riskVal);
    }

    // Fall back to direct pattern in labels section
    if (!level) {
      const riskMatch = /\bRisk:\s*(Low|Medium|High)\b/i.exec(labelsSection);
      if (riskMatch) {
        level = normalizeRiskLevel(riskMatch[1]);
      }
    }

    // Extract justification text as reasons
    const justMatch = /\*{1,2}Justification\*{1,2}:\s*(.+)/i.exec(labelsSection);
    if (justMatch) {
      const justText = justMatch[1].trim();
      if (justText) reasons.push(justText);
    }
  }

  // Also look in general content for risk indicators
  if (!level) {
    const riskMatch = /\bRisk(?:\s+Level)?:\s*(Low|Medium|High)\b/i.exec(content);
    if (riskMatch) {
      level = normalizeRiskLevel(riskMatch[1]);
    }
  }

  return { level, reasons };
}

function extractFilePaths(text: string): string[] {
  const paths = new Set<string>();
  // Backtick-quoted paths
  const backtickMatches = text.matchAll(/`([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)`/g);
  for (const m of backtickMatches) {
    if (m[1].includes('/') || m[1].endsWith('.ts') || m[1].endsWith('.js') || m[1].endsWith('.json')) {
      paths.add(m[1]);
    }
  }
  // Bullet list file paths
  const bulletMatches = text.matchAll(/^[-*]\s+`?([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)`?/gm);
  for (const m of bulletMatches) {
    if (m[1].includes('/') || /\.(ts|js|json|md|sh)$/.test(m[1])) {
      paths.add(m[1]);
    }
  }
  return Array.from(paths).sort();
}

function extractPaths(content: string): { allowed: string[]; expected: string[] } {
  const keyFilesSection = extractSection(content, 'Key Files');
  const techSection = extractSection(content, 'Technical Context', 'Technical context');
  const implSection = extractSection(content, 'Implementation Approach', 'Implementation');

  const expected = new Set<string>();

  for (const section of [keyFilesSection, techSection, implSection]) {
    if (!section) continue;
    const found = extractFilePaths(section);
    for (const p of found) {
      expected.add(p);
    }
  }

  return { allowed: [], expected: Array.from(expected).sort() };
}

function extractOutOfScope(content: string): string[] {
  const items: string[] = [];

  const scopeOutSection = extractSection(content, 'Scope Out', 'Non-goals', 'Out of scope');
  if (!scopeOutSection) return [];

  const bullets = scopeOutSection.matchAll(/^[-*]\s+(.+)$/gm);
  for (const m of bullets) {
    // Normalize markdown emphasis on leading "No" bullets: "**No** replacement..." → "No replacement..."
    const cleaned = m[1].replace(/^\*{1,2}No\*{1,2}\s+/i, 'No ').trim();
    if (cleaned) {
      items.push(cleaned);
    }
  }

  return items;
}

const REQ_ID_RE = /\[REQ-([A-Z0-9-]+)\]/i;

function extractSuccessCriteria(content: string): TaskContractCriterion[] {
  const section = extractSection(content, 'Success Criteria');
  if (!section) return [];

  // First pass: collect authored REQ-* IDs so synthesized IDs can avoid collisions.
  const authoredIds = new Set<string>();
  const lines = section.split('\n');
  for (const line of lines) {
    const m = /^[-*]\s+(?:\[[ x?]\]\s+)?(.+)$/.exec(line.trim());
    if (!m) continue;
    const idMatch = REQ_ID_RE.exec(m[1]);
    if (idMatch) authoredIds.add(`REQ-${idMatch[1].toUpperCase()}`);
  }

  const criteria: TaskContractCriterion[] = [];
  let nextSynthetic = 1;

  for (const line of lines) {
    const trimmed = line.trim();
    // Accept checkbox bullets `- [ ] ...` or plain bullets `- ...`
    const bulletMatch = /^[-*]\s+(?:\[[ x?]\]\s+)?(.+)$/.exec(trimmed);
    if (!bulletMatch) continue;

    let text = bulletMatch[1].trim();
    // Skip sub-heading-level items or pure markdown labels
    if (/^#{1,3}\s/.test(text)) continue;
    // Skip very short items that are likely metadata
    if (text.length < 10) continue;

    const idMatch = REQ_ID_RE.exec(text);
    if (idMatch) {
      // Remove the [REQ-...] tag and any surrounding bold markers from displayed text
      text = text
        .replace(/\*{1,2}\[REQ-[A-Z0-9-]+\]\*{1,2}/i, '')  // **[REQ-F1]**
        .replace(REQ_ID_RE, '')                                // bare [REQ-F1]
        .replace(/^\s*\*{1,2}\s*/, '')                        // leading **
        .replace(/^\s*[-–]\s*/, '')
        .trim();
      if (!text) continue;
      criteria.push({ id: `REQ-${idMatch[1]}`, text, synthesized: false });
    } else {
      // Find the next REQ-F<n> that does not collide with an authored ID.
      let synthId = `REQ-F${nextSynthetic}`;
      while (authoredIds.has(synthId.toUpperCase())) {
        nextSynthetic += 1;
        synthId = `REQ-F${nextSynthetic}`;
      }
      nextSynthetic += 1;
      criteria.push({ id: synthId, text, synthesized: true });
    }
  }

  return criteria;
}

function extractVerificationCommands(content: string): string[] {
  const section = extractSection(
    content,
    'Validation Steps',
    'Standard Validation Commands',
    'Validation',
  );
  if (!section) return [];

  const commands = new Set<string>();

  // Fenced code blocks
  const fencedMatches = section.matchAll(/```[a-z]*\n([\s\S]*?)```/g);
  for (const m of fencedMatches) {
    const lines = m[1].split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        commands.add(trimmed);
      }
    }
  }

  // Inline backtick commands at start of bullet
  const inlineMatches = section.matchAll(/^[-*]\s+`([^`]+)`/gm);
  for (const m of inlineMatches) {
    commands.add(m[1].trim());
  }

  // Lines that look like shell commands (start with npx/npm/node/bash/pnpm/yarn)
  const cmdMatches = section.matchAll(/^\s*[-*]?\s*((?:npx|npm|node|bash|pnpm|yarn|tsx)\s+[^\n]+)/gm);
  for (const m of cmdMatches) {
    commands.add(m[1].trim());
  }

  return Array.from(commands).sort();
}

function extractVerificationScenarios(content: string): string[] {
  const section = extractSection(
    content,
    'Validation Steps',
    'Validation',
  );
  if (!section) return [];

  const scenarios: string[] = [];

  // Bold scenario headings or lines starting with **[REQ-
  const headingMatches = section.matchAll(/\*{1,2}(\[REQ-[^\]]+\][^*\n]*|\w[^*\n]{10,})\*{1,2}/g);
  for (const m of headingMatches) {
    const text = m[1].trim();
    if (text && !text.startsWith('`')) {
      scenarios.push(text);
    }
  }

  return [...new Set(scenarios)].sort();
}

function extractReleaseReadinessLocal(content: string): TaskContractReleaseReadiness {
  // First try the existing helper (matches unnumbered `## Release Readiness`)
  const existing = extractReleaseReadiness(content);
  if (existing) {
    const dbRisk = existing.databaseChangeRisk as 'none' | 'possible' | 'required';
    return {
      database_change_risk: dbRisk,
      env_changes: existing.envChanges,
      config_changes: existing.configChanges,
      manual_steps: existing.manualSteps,
    };
  }

  // Also try numbered headings: ## 10. Release Readiness
  const section = extractSection(content, 'Release Readiness');
  if (!section) {
    return {
      database_change_risk: null,
      env_changes: [],
      config_changes: [],
      manual_steps: [],
    };
  }

  // Parse bold-label key-value pairs: - **field**: value
  const fieldPattern = /[-*]\s+\*{1,2}(\w+)\*{1,2}:\s*(.+)/g;
  const fields = new Map<string, string>();
  let match;
  while ((match = fieldPattern.exec(section)) !== null) {
    fields.set(match[1].toLowerCase(), match[2].trim());
  }

  const VALID_DB_RISK = ['none', 'possible', 'required'] as const;
  const rawDbRisk = fields.get('database_change_risk')?.split(/\s/)[0];
  const dbRisk = rawDbRisk && VALID_DB_RISK.includes(rawDbRisk as typeof VALID_DB_RISK[number])
    ? (rawDbRisk as 'none' | 'possible' | 'required')
    : null;

  function parseListField(value: string | undefined): string[] {
    if (!value || value.trim().toLowerCase() === 'none' || !value.trim()) return [];
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }

  return {
    database_change_risk: dbRisk,
    env_changes: parseListField(fields.get('env_changes')),
    config_changes: parseListField(fields.get('config_changes')),
    manual_steps: parseListField(fields.get('manual_steps')),
  };
}

function buildRoutingHints(contract: Omit<TaskContract, 'routingHints' | 'missingFields' | 'extractionWarnings'>): TaskContractRoutingHints {
  const riskLevel = contract.risk.level
    ? (contract.risk.level.toLowerCase() as 'low' | 'medium' | 'high')
    : null;

  // Detect tests from verification commands
  const requiresTests = contract.verification.commands.length > 0
    ? contract.verification.commands.some((c) => /\b(test|spec|vitest|jest|mocha)\b/i.test(c))
    : null;

  // Detect migration from release readiness
  const hasMigration = contract.releaseReadiness.database_change_risk !== null
    ? contract.releaseReadiness.database_change_risk !== 'none'
    : null;

  // Detect UI from labels/subsystems
  const uiKeywords = /\b(ui|frontend|react|component|css|tailwind|html|browser)\b/i;
  const hasUiLabel = [...contract.componentLabels, ...contract.subsystems].some((s) => uiKeywords.test(s));
  const hasUi = hasUiLabel || null;

  // Detect cross-service
  const crossService = contract.componentLabels.some((l) => /cross.?service/i.test(l)) || null;

  // Expected file types from paths
  const extensions = new Set<string>();
  for (const p of contract.paths.expected) {
    const dotIdx = p.lastIndexOf('.');
    if (dotIdx !== -1) {
      extensions.add(p.slice(dotIdx + 1));
    }
  }

  return {
    taskType: contract.taskType,
    riskLevel,
    requiresTests,
    hasMigration,
    hasUi,
    crossService,
    expectedFileTypes: Array.from(extensions).sort(),
  };
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

export interface BuildTaskContractOptions {
  /** Repository root directory. Defaults to cwd. Used for relative path resolution. */
  repoDir?: string;
}

function assertWithinRepoFeatures(absFeatureDir: string, repoDir: string): void {
  const featuresRoot = join(repoDir, 'features');
  if (absFeatureDir !== featuresRoot && !absFeatureDir.startsWith(featuresRoot + sep)) {
    throw new Error(
      `Feature directory must be under <repoDir>/features/: ${absFeatureDir} is not under ${featuresRoot}`,
    );
  }
}

/**
 * Build a deterministic task contract projection from existing task packet and
 * plan artifacts in a feature directory.
 *
 * Missing fields are recorded in `missingFields` rather than thrown as errors,
 * making the builder tolerant of legacy/minimal packets.
 *
 * @param featureDir - Absolute or relative path to the feature directory
 * @param options - Optional configuration
 * @returns Structured task contract projection
 */
export async function buildTaskContract(
  featureDir: string,
  options: BuildTaskContractOptions = {},
): Promise<TaskContract> {
  const absFeatureDir = resolve(featureDir);
  const repoDir = resolve(options.repoDir ?? process.cwd());
  assertWithinRepoFeatures(absFeatureDir, repoDir);
  const slug = basename(absFeatureDir);

  const artifacts = await discoverArtifacts(absFeatureDir);
  const sources = buildSources(artifacts, repoDir);
  const missingFields: string[] = [];
  const extractionWarnings: string[] = [];

  if (artifacts.length === 0) {
    extractionWarnings.push('No recognized source artifacts found in feature directory.');
  }

  const content = chooseExtractionContent(artifacts);

  // Issue ID
  const issueId = extractIssueId(content);
  if (!issueId) {
    missingFields.push('issueId');
  }

  // Objective summary
  const objectiveSummary = content ? extractObjectiveSummary(content) : null;
  if (!objectiveSummary) {
    missingFields.push('objectiveSummary');
  }

  // Task type
  const taskType = content ? extractTaskType(content) : null;

  // Subsystems and labels
  const subsystems = content ? extractSubsystems(content) : [];
  const componentLabels = content ? extractComponentLabels(content) : [];

  // Risk
  const risk = content ? extractRisk(content) : { level: null as null, reasons: [] };
  if (!risk.level) {
    missingFields.push('risk.level');
  }

  // Paths
  const paths = content ? extractPaths(content) : { allowed: [], expected: [] };

  // Out of scope
  const outOfScope = content ? extractOutOfScope(content) : [];

  // Success criteria
  const successCriteria = content ? extractSuccessCriteria(content) : [];
  if (successCriteria.length === 0) {
    missingFields.push('successCriteria');
  }

  // Verification
  const verificationCommands = content ? extractVerificationCommands(content) : [];
  const verificationScenarios = content ? extractVerificationScenarios(content) : [];
  if (verificationCommands.length === 0) {
    missingFields.push('verification.commands');
  }

  // Release readiness
  const releaseReadiness = content ? extractReleaseReadinessLocal(content) : {
    database_change_risk: null,
    env_changes: [],
    config_changes: [],
    manual_steps: [],
  };
  if (releaseReadiness.database_change_risk === null) {
    missingFields.push('releaseReadiness');
  }

  const contractBody = {
    schemaVersion: TASK_CONTRACT_SCHEMA_VERSION as '1.0.0',
    issueId,
    slug,
    sources,
    objectiveSummary,
    taskType,
    subsystems,
    componentLabels,
    risk,
    paths,
    outOfScope,
    successCriteria,
    verification: {
      commands: verificationCommands,
      scenarios: verificationScenarios,
    },
    releaseReadiness,
  };

  const routingHints = buildRoutingHints(contractBody);

  const contract: TaskContract = {
    ...contractBody,
    routingHints,
    missingFields: [...new Set(missingFields)].sort(),
    extractionWarnings: [...new Set(extractionWarnings)].sort(),
  };

  return contract;
}

/**
 * Write a task contract projection to `<featureDir>/task-contract.json`.
 *
 * Uses atomic temp-file + rename to prevent partial writes.
 *
 * @param featureDir - Absolute or relative path to the feature directory
 * @param contract - Contract to write. If omitted, builds from artifacts.
 * @returns Absolute path to the written file
 */
export async function writeTaskContract(
  featureDir: string,
  contract?: TaskContract,
  options: BuildTaskContractOptions = {},
): Promise<string> {
  const absFeatureDir = resolve(featureDir);
  const repoDir = resolve(options.repoDir ?? process.cwd());
  assertWithinRepoFeatures(absFeatureDir, repoDir);
  const resolved = contract ?? await buildTaskContract(absFeatureDir, options);
  const outPath = join(absFeatureDir, 'task-contract.json');
  const tmpPath = join(absFeatureDir, `.tmp-task-contract-${process.pid}`);

  const serialized = `${JSON.stringify(resolved, null, 2)}\n`;

  // Validate round-trip before writing
  JSON.parse(serialized);

  try {
    await fs.mkdir(dirname(outPath), { recursive: true });
    await fs.writeFile(tmpPath, serialized, 'utf-8');
    await fs.rename(tmpPath, outPath);
  } catch (error) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }

  return outPath;
}
