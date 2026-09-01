import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { extractSection, getConceptsDir, getContextDir, listContextSpecPaths } from './context-tool.ts';
import { errorMessage } from './error-utils.ts';
import { execShellCommand } from './shell-utils.ts';
import { detectSubsystems } from './subsystem-detector.ts';

export interface LintResult {
  level: 'warn' | 'error';
  rule: 'orphaned-spec' | 'missing-spec' | 'stale-crossref' | 'contradiction' | 'constraint-violation';
  subsystem: string;
  message: string;
  details?: string;
}

export interface LintConfig {
  rules?: LintResult['rule'][];
}

interface SpecInfo {
  id: string;
  path: string;
  content: string;
}

interface ConstraintRule {
  subsystem: string;
  kind: 'do' | 'dont';
  text: string;
  references: string[];
  keywords: string[];
}

const ALL_RULES: LintResult['rule'][] = [
  'orphaned-spec',
  'missing-spec',
  'stale-crossref',
  'contradiction',
  'constraint-violation',
];

export async function lintSubsystemSpecs(repoDir: string, config: LintConfig = {}): Promise<LintResult[]> {
  const selectedRules = config.rules && config.rules.length > 0
    ? ALL_RULES.filter((rule) => config.rules!.includes(rule))
    : ALL_RULES;

  const results: LintResult[] = [];
  const contextDir = getContextDir(repoDir);
  if (!existsSync(contextDir)) {
    return results;
  }

  const specInfos = loadSubsystemSpecs(repoDir);
  const detectedSubsystems = detectSubsystems(repoDir, {
    minFiles: 3,
    useGitAnalysis: false,
    maxSubsystems: 20,
  });
  const detectedIds = new Set(detectedSubsystems.map((subsystem) => subsystem.id));

  const ruleRunners: Record<LintResult['rule'], () => Promise<LintResult[]> | LintResult[]> = {
    'orphaned-spec': () => lintOrphanedSpecs(repoDir, specInfos, detectedIds),
    'missing-spec': () => lintMissingSpecs(repoDir, detectedIds),
    'stale-crossref': () => lintStaleCrossReferences(repoDir, specInfos),
    contradiction: () => lintContradictions(specInfos),
    'constraint-violation': () => lintConstraintViolations(repoDir, specInfos),
  };

  for (const rule of selectedRules) {
    try {
      results.push(...await ruleRunners[rule]());
    } catch (error) {
      results.push({
        level: 'warn',
        rule,
        subsystem: 'context-linter',
        message: `Lint rule failed: ${errorMessage(error)}`,
      });
    }
  }

  return sortResults(results);
}

export function formatLintResults(results: LintResult[]): string {
  if (results.length === 0) {
    return '';
  }

  return sortResults(results)
    .map((result) => {
      const icon = result.level === 'error' ? '❌' : '⚠️';
      const details = result.details ? ` (${result.details})` : '';
      return `${icon} [${result.rule}] ${result.subsystem}: ${result.message}${details}`;
    })
    .join('\n');
}

function loadSubsystemSpecs(repoDir: string): SpecInfo[] {
  return listContextSpecPaths(repoDir)
    .filter((specPath) => !specPath.includes(`${join('.wavemill', 'context', 'concepts')}`))
    .map((specPath) => ({
      id: basename(specPath, '.md'),
      path: specPath,
      content: readFileSync(specPath, 'utf-8'),
    }));
}

function lintOrphanedSpecs(repoDir: string, specs: SpecInfo[], detectedIds: Set<string>): LintResult[] {
  return specs
    .filter((spec) => {
      if (detectedIds.has(spec.id)) return false;
      const keyFiles = extractKeyFileReferences(spec.content);
      // Heuristic discovery is not an authority over curated domain pages. A
      // page is orphaned only when it has an explicit file inventory and none
      // of those files remain in the repository.
      return keyFiles.length > 0 && keyFiles.every((file) => !existsSync(join(repoDir, file)));
    })
    .map((spec) => ({
      level: 'error',
      rule: 'orphaned-spec' as const,
      subsystem: spec.id,
      message: 'Spec exists but subsystem is not currently detected',
    }));
}

function extractKeyFileReferences(content: string): string[] {
  const section = extractSection(content, 'Key Files')
    || extractSection(content, 'Generated Navigation Index');
  const files = new Set<string>();
  for (const match of section.matchAll(/\|\s*`([^`]+)`\s*\|/g)) files.add(match[1]);
  return Array.from(files);
}

function lintMissingSpecs(repoDir: string, detectedIds: Set<string>): LintResult[] {
  const contextDir = getContextDir(repoDir);

  return Array.from(detectedIds)
    .filter((subsystemId) => !existsSync(join(contextDir, `${subsystemId}.md`)))
    .map((subsystemId) => ({
      level: 'warn',
      rule: 'missing-spec' as const,
      subsystem: subsystemId,
      message: 'Subsystem detected but no subsystem spec exists',
    }));
}

function lintStaleCrossReferences(repoDir: string, specs: SpecInfo[]): LintResult[] {
  const contextDir = getContextDir(repoDir);
  const conceptsDir = getConceptsDir(repoDir);
  const results: LintResult[] = [];

  for (const spec of specs) {
    const sections = [
      { name: 'Related Subsystems', baseDir: contextDir },
      { name: 'Related Concepts', baseDir: conceptsDir },
    ];

    for (const section of sections) {
      const content = extractSection(spec.content, section.name);
      for (const target of extractMarkdownTargets(content)) {
        const resolvedTarget = resolve(dirname(spec.path), target);
        const inExpectedDir = resolvedTarget.startsWith(section.baseDir);
        const fallbackTarget = join(section.baseDir, basename(target));

        if (!existsSync(resolvedTarget) && !(inExpectedDir ? false : existsSync(fallbackTarget))) {
          results.push({
            level: 'error',
            rule: 'stale-crossref',
            subsystem: spec.id,
            message: `Cross-reference target is missing: ${target}`,
          });
        }
      }
    }
  }

  return results;
}

function lintContradictions(specs: SpecInfo[]): LintResult[] {
  const rules = extractConstraintRules(specs);
  const doRules = rules.filter((rule) => rule.kind === 'do');
  const dontRules = rules.filter((rule) => rule.kind === 'dont');
  const seen = new Set<string>();
  const results: LintResult[] = [];

  for (const dontRule of dontRules) {
    for (const doRule of doRules) {
      if (dontRule.subsystem === doRule.subsystem) {
        continue;
      }

      const sharedReferences = dontRule.references.filter((reference) => doRule.references.includes(reference));
      if (sharedReferences.length === 0) {
        continue;
      }

      const pairKey = [dontRule.subsystem, doRule.subsystem, sharedReferences[0]].sort().join(':');
      if (seen.has(pairKey)) {
        continue;
      }
      seen.add(pairKey);

      results.push({
        level: 'warn',
        rule: 'contradiction',
        subsystem: dontRule.subsystem,
        message: `Potential contradiction with ${doRule.subsystem} on ${sharedReferences[0]}`,
        details: `DON'T: ${dontRule.text} | DO: ${doRule.text}`,
      });
    }
  }

  return results;
}

function lintConstraintViolations(repoDir: string, specs: SpecInfo[]): LintResult[] {
  const diffText = getRecentDiff(repoDir);
  if (!diffText) {
    return [];
  }

  const rules = extractConstraintRules(specs).filter((rule) => rule.kind === 'dont');
  const addedLinesByFile = parseAddedLinesByFile(diffText);
  const results: LintResult[] = [];

  for (const rule of rules) {
    const candidateFiles = rule.references.filter((reference) => looksLikeFileReference(reference));
    const normalizedFiles = candidateFiles.map((reference) => normalizeRepoPath(reference));
    const fileMatches = normalizedFiles.filter((reference) => addedLinesByFile.has(reference));

    const keywordMatches = rule.keywords.filter((keyword) =>
      Array.from(addedLinesByFile.values()).some((lines) => lines.some((line) => line.includes(keyword)))
    );

    if (fileMatches.length === 0 && keywordMatches.length === 0) {
      continue;
    }

    results.push({
      level: 'warn',
      rule: 'constraint-violation',
      subsystem: rule.subsystem,
      message: `Recent changes may violate constraint: ${rule.text}`,
      details: [
        fileMatches.length > 0 ? `files ${fileMatches.join(', ')}` : '',
        keywordMatches.length > 0 ? `keywords ${keywordMatches.join(', ')}` : '',
      ].filter(Boolean).join('; '),
    });
  }

  return results;
}

function extractMarkdownTargets(sectionContent: string): string[] {
  const targets = new Set<string>();
  const linkRegex = /\[[^\]]+\]\(([^)]+\.md)\)/g;

  for (const match of sectionContent.matchAll(linkRegex)) {
    targets.add(match[1].trim());
  }

  return Array.from(targets);
}

function extractConstraintRules(specs: SpecInfo[]): ConstraintRule[] {
  const rules: ConstraintRule[] = [];

  for (const spec of specs) {
    const section = extractSection(spec.content, 'Architectural Constraints');
    if (!section.trim()) {
      continue;
    }

    let mode: ConstraintRule['kind'] | null = null;
    for (const rawLine of section.split('\n')) {
      const line = rawLine.trim();
      if (/^###\s+DO\b/i.test(line)) {
        mode = 'do';
        continue;
      }
      if (/^###\s+DON['’]?T\b/i.test(line)) {
        mode = 'dont';
        continue;
      }
      if (!mode || !line.startsWith('- ')) {
        continue;
      }

      const text = line.slice(2).trim();
      rules.push({
        subsystem: spec.id,
        kind: mode,
        text,
        references: extractReferences(text),
        keywords: extractConstraintKeywords(text),
      });
    }
  }

  return rules;
}

function extractReferences(text: string): string[] {
  const refs = new Set<string>();

  for (const match of text.matchAll(/`([^`]+)`/g)) {
    refs.add(normalizeRepoPath(match[1]));
  }

  for (const match of text.matchAll(/\b(?:src|lib|shared|tools|commands|tests)\/[A-Za-z0-9_./-]+\b/g)) {
    refs.add(normalizeRepoPath(match[0]));
  }

  return Array.from(refs);
}

function extractConstraintKeywords(text: string): string[] {
  const keywords = new Set<string>();

  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const value = match[1].trim();
    if (!looksLikeFileReference(value) && value.length >= 3) {
      keywords.add(value);
    }
  }

  for (const match of text.matchAll(/"(.*?)"/g)) {
    const value = match[1].trim();
    if (value.length >= 3) {
      keywords.add(value);
    }
  }

  return Array.from(keywords);
}

function getRecentDiff(repoDir: string): string {
  try {
    const revisions = execShellCommand('git rev-list --count HEAD', {
      encoding: 'utf-8',
      cwd: repoDir,
    }).trim();
    const commitCount = Number.parseInt(revisions, 10);
    if (!Number.isFinite(commitCount) || commitCount === 0) {
      return '';
    }

    const baseRef = commitCount > 5 ? 'HEAD~5' : 'HEAD~1';
    return execShellCommand(`git diff ${baseRef} --`, {
      encoding: 'utf-8',
      cwd: repoDir,
      maxBuffer: 10 * 1024 * 1024,
    }).toString();
  } catch {
    return '';
  }
}

function parseAddedLinesByFile(diffText: string): Map<string, string[]> {
  const addedLinesByFile = new Map<string, string[]>();
  let currentFile: string | null = null;

  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = normalizeRepoPath(line.slice('+++ b/'.length).trim());
      if (!addedLinesByFile.has(currentFile)) {
        addedLinesByFile.set(currentFile, []);
      }
      continue;
    }
    if (!currentFile || !line.startsWith('+') || line.startsWith('+++')) {
      continue;
    }
    addedLinesByFile.get(currentFile)!.push(line.slice(1));
  }

  return addedLinesByFile;
}

function normalizeRepoPath(value: string): string {
  return value.replace(/^\.\//, '').replace(/^\/+/, '').trim();
}

function looksLikeFileReference(value: string): boolean {
  return /[/.]/.test(value) && /\.[A-Za-z0-9]+$/.test(value);
}

function sortResults(results: LintResult[]): LintResult[] {
  return [...results].sort((a, b) =>
    levelWeight(a.level) - levelWeight(b.level) ||
    a.rule.localeCompare(b.rule) ||
    a.subsystem.localeCompare(b.subsystem) ||
    a.message.localeCompare(b.message)
  );
}

function levelWeight(level: LintResult['level']): number {
  return level === 'error' ? 0 : 1;
}
