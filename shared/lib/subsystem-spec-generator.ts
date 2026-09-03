/**
 * Subsystem specification generator.
 *
 * Generates structured documentation for each detected subsystem.
 * Fills the subsystem-spec-template.md with detected information.
 *
 * @module subsystem-spec-generator
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execArgvCommand } from './shell-utils.ts';
import type { Subsystem } from './subsystem-detector.ts';
import type { RelatedSubsystem } from './subsystem-cross-reference.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const subsystemSpecGeneratorDeps = {
  execArgvCommand,
};

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface SubsystemSpecOptions {
  /** Template file path */
  templatePath?: string;
  /** Include git history analysis */
  includeGitHistory?: boolean;
  /** Repository directory */
  repoDir: string;
  /** Related subsystems (cross-references) */
  relatedSubsystems?: RelatedSubsystem[];
}

const GENERATED_NAV_START = '<!-- wavemill:generated-navigation:start -->';
const GENERATED_NAV_END = '<!-- wavemill:generated-navigation:end -->';

// ────────────────────────────────────────────────────────────────
// Spec Generation
// ────────────────────────────────────────────────────────────────

/**
 * Generate a subsystem specification from detected subsystem data.
 */
export function generateSubsystemSpec(
  subsystem: Subsystem,
  options: SubsystemSpecOptions
): string {
  const { repoDir, templatePath, includeGitHistory = true, relatedSubsystems } = options;

  // Load template
  const templateDir = templatePath || join(dirname(dirname(__dirname)), 'tools', 'prompts', 'subsystem-spec-template.md');
  let template = readFileSync(templateDir, 'utf-8');

  // Fill in basic info
  const timestamp = new Date().toISOString();
  template = template.replace(/{TIMESTAMP}/g, timestamp);
  template = template.replace(/{NAME}/g, subsystem.name);
  template = template.replace(/{ID}/g, subsystem.id);
  template = template.replace(/{DESCRIPTION}/g, subsystem.description);

  // Git activity (file touch count)
  const fileCount = includeGitHistory ? getFileTouchCount(subsystem.keyFiles, repoDir) : 0;
  template = template.replace(/{FILE_COUNT}/g, fileCount.toString());

  // Key files table
  const keyFilesTable = generateKeyFilesTable(subsystem.keyFiles, repoDir);
  template = template.replace(/{KEY_FILES_TABLE}/g, keyFilesTable);

  // Architectural constraints (placeholders for manual editing)
  template = template.replace(/{DO_RULES}/g, generateDoRules(subsystem));
  template = template.replace(/{DONT_RULES}/g, generateDontRules(subsystem));

  // Failure modes (placeholder)
  template = template.replace(/{FAILURE_MODES}/g, generateFailureModes());

  // Testing patterns
  const testPatterns = subsystem.testPatterns.length > 0
    ? subsystem.testPatterns.map(p => `- \`${p}\``).join('\n')
    : '- *(No test patterns detected)*';
  template = template.replace(/{TEST_PATTERNS}/g, testPatterns);
  template = template.replace(/{TEST_SCENARIOS}/g, '- *(TODO: Document key test scenarios)*');

  // Dependencies
  const dependencies = subsystem.dependencies.length > 0
    ? subsystem.dependencies.map(d => `- \`${d}\``).join('\n')
    : '- *(No dependencies detected)*';
  template = template.replace(/{DEPENDENCIES}/g, dependencies);
  template = template.replace(/{DEPENDENTS}/g, '- *(TODO: Analyze which subsystems use this one)*');

  // Related subsystems (cross-references)
  const relatedSubsystemsList = relatedSubsystems?.length
    ? relatedSubsystems.map(r => `- [${r.name}](${r.id}.md) — ${r.reason}`).join('\n')
    : '- *(No related subsystems detected)*';
  template = template.replace(/{RELATED_SUBSYSTEMS}/g, relatedSubsystemsList);

  // Related concepts (placeholder for now - concept detection can be added later)
  const relatedConceptsList = '- *(No related concepts - add manually if needed)*';
  template = template.replace(/{RELATED_CONCEPTS}/g, relatedConceptsList);

  // Recent changes
  const recentChanges = includeGitHistory
    ? getRecentChanges(subsystem.keyFiles, repoDir)
    : '*(No recent changes)*';
  template = template.replace(/{RECENT_CHANGES}/g, recentChanges);

  return template;
}

/**
 * Build the machine-maintained portion of a subsystem page. Keeping this in a
 * marked block lets refresh update file navigation without replacing curated
 * architecture, constraints, failure modes, or history.
 */
export function generateSubsystemNavigationBlock(
  subsystem: Subsystem,
  options: SubsystemSpecOptions,
): string {
  const { repoDir, includeGitHistory = true, relatedSubsystems } = options;
  const timestamp = new Date().toISOString();
  const recentCommitCount = includeGitHistory
    ? getRecentCommitCount(subsystem.keyFiles, repoDir)
    : 0;
  const testPatterns = subsystem.testPatterns.length > 0
    ? subsystem.testPatterns.map((pattern) => `- \`${pattern}\``).join('\n')
    : '- No test paths were inferred from the detected files.';
  const related = relatedSubsystems?.length
    ? relatedSubsystems.map((item) => `- [${item.name}](${item.id}.md) — ${item.reason}`).join('\n')
    : '- No file-overlap relationships were detected.';
  const recentChanges = includeGitHistory
    ? getRecentChanges(subsystem.keyFiles, repoDir)
    : '*(Git history analysis disabled)*';

  return [
    GENERATED_NAV_START,
    '## Generated Navigation Index',
    '',
    `**Last refreshed:** ${timestamp}`,
    `**Detection:** \`${subsystem.detectionMethod}\` (${Math.round(subsystem.confidence * 100)}% heuristic confidence)`,
    `**Recent commits:** ${recentCommitCount} in the last 30 days`,
    '',
    'This block is discovery metadata only. Curated architectural guidance elsewhere in this page is authoritative.',
    '',
    '### Detected Key Files',
    '',
    '| File | Role | Notes |',
    '|------|------|-------|',
    generateKeyFilesTable(subsystem.keyFiles, repoDir),
    '',
    '### Detected Test Locations',
    '',
    testPatterns,
    '',
    '### Detected Relationships',
    '',
    related,
    '',
    '### Meaningful Recent Changes',
    '',
    recentChanges,
    GENERATED_NAV_END,
  ].join('\n');
}

/** Replace only Wavemill's marked navigation block, preserving all prose. */
export function mergeSubsystemNavigation(existing: string, generatedBlock: string): string {
  const start = existing.indexOf(GENERATED_NAV_START);
  const end = existing.indexOf(GENERATED_NAV_END);
  if (start >= 0 && end >= start) {
    const after = end + GENERATED_NAV_END.length;
    return `${existing.slice(0, start)}${generatedBlock}${existing.slice(after)}`;
  }

  const footer = '*This subsystem documentation is auto-generated and updated after each PR merge.';
  const footerIndex = existing.indexOf(footer);
  if (footerIndex >= 0) {
    return `${existing.slice(0, footerIndex).trimEnd()}\n\n${generatedBlock}\n\n${existing.slice(footerIndex)}`;
  }
  return `${existing.trimEnd()}\n\n${generatedBlock}\n`;
}

/** Create an honest discovery page when refresh finds a previously undocumented area. */
export function generateSubsystemDiscoverySpec(
  subsystem: Subsystem,
  options: SubsystemSpecOptions,
): string {
  return [
    `# Subsystem: ${subsystem.name}`,
    '',
    `**Subsystem ID:** \`${subsystem.id}\``,
    '**Documentation status:** Autogenerated discovery index; architectural guidance has not been curated.',
    '',
    '## Purpose',
    '',
    subsystem.description,
    '',
    generateSubsystemNavigationBlock(subsystem, options),
    '',
  ].join('\n');
}

/**
 * Write all subsystem specs to disk.
 */
export function writeSubsystemSpecs(
  subsystems: Subsystem[],
  contextDir: string,
  options: Omit<SubsystemSpecOptions, 'repoDir' | 'relatedSubsystems'> & {
    repoDir: string;
    crossReferences?: Map<string, RelatedSubsystem[]>;
    /** Preserve curated prose and update only the generated navigation block. */
    refresh?: boolean;
  }
): void {
  // Create context directory if it doesn't exist
  if (!existsSync(contextDir)) {
    mkdirSync(contextDir, { recursive: true });
  }

  // Generate and write each spec
  for (const subsystem of subsystems) {
    const relatedSubsystems = options.crossReferences?.get(subsystem.id);
    const specOptions = {
      ...options,
      relatedSubsystems,
    };
    const filename = `${subsystem.id}.md`;
    const filepath = join(contextDir, filename);
    let spec: string;

    if (options.refresh && existsSync(filepath)) {
      const existing = readFileSync(filepath, 'utf-8');
      spec = mergeSubsystemNavigation(
        existing,
        generateSubsystemNavigationBlock(subsystem, specOptions),
      );
    } else if (options.refresh) {
      spec = generateSubsystemDiscoverySpec(subsystem, specOptions);
      if (/\bTODO\b/.test(spec)) {
        throw new Error(`refusing to create TODO-heavy discovery spec: ${subsystem.id}`);
      }
    } else {
      spec = generateSubsystemSpec(subsystem, specOptions);
    }

    writeFileSync(filepath, spec, 'utf-8');
  }
}

// ────────────────────────────────────────────────────────────────
// Helper Functions
// ────────────────────────────────────────────────────────────────

/**
 * Generate key files table rows.
 */
function generateKeyFilesTable(keyFiles: string[], repoDir: string): string {
  if (keyFiles.length === 0) {
    return '| *(No key files)* | - | - |';
  }

  return keyFiles
    .slice(0, 10) // Limit to top 10
    .map(file => {
      const role = inferFileRole(file);
      const notes = inferFileNotes(file);
      return `| \`${file}\` | ${role} | ${notes} |`;
    })
    .join('\n');
}

/**
 * Infer file role from path and name.
 */
function inferFileRole(file: string): string {
  const name = file.split('/').pop() || '';

  if (/^index\.[^.]+$/.test(name)) return 'Entry point';
  if (/\.(?:test|spec)\.[^.]+$/.test(name)) return 'Test';
  if (name.includes('type') || name.includes('interface')) return 'Type definitions';
  if (name.includes('util') || name.includes('helper')) return 'Utilities';
  if (name.includes('config')) return 'Configuration';
  if (name.includes('constant')) return 'Constants';

  return 'Implementation';
}

/**
 * Infer file notes from path and name.
 */
function inferFileNotes(file: string): string {
  if (/\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/.test(file)) return 'Unit tests';
  const ext = file.split('.').pop();
  if (ext === 'ts' || ext === 'tsx') return 'TypeScript';
  if (ext === 'js' || ext === 'jsx') return 'JavaScript';
  return '-';
}

/**
 * Generate DO rules based on subsystem characteristics.
 */
function generateDoRules(subsystem: Subsystem): string {
  const rules: string[] = [];

  // Infer rules from subsystem type
  if (subsystem.id.includes('api') || subsystem.id.includes('client')) {
    rules.push('- Use proper error handling for all API calls');
    rules.push('- Validate input data before sending to external services');
  }

  if (subsystem.id.includes('test')) {
    rules.push('- Keep tests isolated and independent');
    rules.push('- Use descriptive test names');
  }

  if (subsystem.id.includes('util') || subsystem.id.includes('helper')) {
    rules.push('- Keep functions pure and side-effect free where possible');
    rules.push('- Document parameters and return types clearly');
  }

  if (rules.length === 0) {
    rules.push('- *(TODO: Document architectural rules)*');
  }

  return rules.join('\n');
}

/**
 * Generate DON'T rules based on subsystem characteristics.
 */
function generateDontRules(subsystem: Subsystem): string {
  const rules: string[] = [];

  if (subsystem.id.includes('api') || subsystem.id.includes('client')) {
    rules.push('- Don\'t expose API keys or secrets in client code');
    rules.push('- Don\'t make synchronous blocking calls in async contexts');
  }

  if (subsystem.id.includes('test')) {
    rules.push('- Don\'t use hard-coded timeouts (use proper async patterns)');
    rules.push('- Don\'t share state between tests');
  }

  if (rules.length === 0) {
    rules.push('- *(TODO: Document anti-patterns)*');
  }

  return rules.join('\n');
}

/**
 * Generate failure modes table (placeholder).
 */
function generateFailureModes(): string {
  return '| *(TODO: Document known failure modes)* | - | - |';
}

/**
 * Get file touch count (number of commits touching files in last 30 days).
 */
function getRecentCommitCount(keyFiles: string[], repoDir: string): number {
  if (keyFiles.length === 0) return 0;

  try {
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const sinceStr = since.toISOString().split('T')[0];

    const result = subsystemSpecGeneratorDeps.execArgvCommand('git', [
      'log',
      `--since=${sinceStr}`,
      '--oneline',
      '--',
      ...keyFiles.slice(0, 20),
    ], { encoding: 'utf-8', cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] });

    return result.stdout.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

const getFileTouchCount = getRecentCommitCount;

/**
 * Get recent changes affecting this subsystem.
 */
function getRecentChanges(keyFiles: string[], repoDir: string, limit = 5): string {
  if (keyFiles.length === 0) return '*(No files to analyze)*';

  try {
    const result = subsystemSpecGeneratorDeps.execArgvCommand('git', [
      'log',
      '--oneline',
      `-${Math.max(limit * 4, 20)}`,
      '--',
      ...keyFiles.slice(0, 20),
    ], { encoding: 'utf-8', cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] });
    const output = result.stdout;

    if (!output.trim()) return '*(No recent changes)*';

    const lines = output.trim().split('\n')
      .filter((line) => !/\bchore: reconcile auto\/integration\b/i.test(line))
      .slice(0, limit);
    if (lines.length === 0) return '*(No meaningful recent changes)*';
    return lines.map(line => `- ${line}`).join('\n');
  } catch {
    return '*(Git history unavailable)*';
  }
}
