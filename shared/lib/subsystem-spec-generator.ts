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
import { execShellCommand } from './shell-utils.ts';
import type { Subsystem } from './subsystem-detector.ts';

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
}

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
  const { repoDir, templatePath, includeGitHistory = true } = options;

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

  // Recent changes
  const recentChanges = includeGitHistory
    ? getRecentChanges(subsystem.keyFiles, repoDir)
    : '*(No recent changes)*';
  template = template.replace(/{RECENT_CHANGES}/g, recentChanges);

  return template;
}

/**
 * Write all subsystem specs to disk.
 */
export function writeSubsystemSpecs(
  subsystems: Subsystem[],
  contextDir: string,
  options: Omit<SubsystemSpecOptions, 'repoDir'> & { repoDir: string }
): void {
  // Create context directory if it doesn't exist
  if (!existsSync(contextDir)) {
    mkdirSync(contextDir, { recursive: true });
  }

  // Generate and write each spec
  for (const subsystem of subsystems) {
    const spec = generateSubsystemSpec(subsystem, options);
    const filename = `${subsystem.id}.md`;
    const filepath = join(contextDir, filename);

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

  if (name.includes('index')) return 'Entry point';
  if (name.includes('test') || name.includes('spec')) return 'Test';
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
  const ext = file.split('.').pop();
  if (ext === 'ts' || ext === 'tsx') return 'TypeScript';
  if (ext === 'js' || ext === 'jsx') return 'JavaScript';
  if (ext === 'test.ts' || ext === 'spec.ts') return 'Unit tests';
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
function getFileTouchCount(keyFiles: string[], repoDir: string): number {
  if (keyFiles.length === 0) return 0;

  try {
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const sinceStr = since.toISOString().split('T')[0];

    // Count commits touching any of the key files
    const fileArgs = keyFiles.slice(0, 20).join(' '); // Limit to avoid command line overflow
    const cmd = `git log --since="${sinceStr}" --oneline -- ${fileArgs} 2>/dev/null | wc -l`;
    const output = execShellCommand(cmd, { encoding: 'utf-8', cwd: repoDir });

    return parseInt(output.trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Get recent changes affecting this subsystem.
 */
function getRecentChanges(keyFiles: string[], repoDir: string, limit = 5): string {
  if (keyFiles.length === 0) return '*(No files to analyze)*';

  try {
    const fileArgs = keyFiles.slice(0, 20).join(' ');
    const cmd = `git log --oneline -${limit} -- ${fileArgs} 2>/dev/null`;
    const output = execShellCommand(cmd, { encoding: 'utf-8', cwd: repoDir });

    if (!output.trim()) return '*(No recent changes)*';

    const lines = output.trim().split('\n');
    return lines.map(line => `- ${line}`).join('\n');
  } catch {
    return '*(Git history unavailable)*';
  }
}
