import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { buildTaskContract, type TaskContractField } from './task-contract.ts';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import {
  detectCrossPrReverts,
  filterUnacknowledgedReverts,
  parseRevertAcknowledgements,
  type CrossPrRevertFinding,
} from './cross-pr-revert-detector.ts';
import { getIntegrationConfig, getReviewMergeConfig } from './config.ts';

type ShellRunner = (cmd: string, opts?: { encoding?: string; cwd?: string }) => string;

export interface ReviewScopeGuardFinding {
  severity: 'blocker' | 'warning';
  category: 'review-scope' | 'deletion-budget' | 'cross-pr-revert';
  path?: string;
  status?: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ReviewScopeGuardResult {
  ok: boolean;
  baselinePaths: string[];
  declaredScope: string[];
  baselineSource: string;
  featureDir: string | null;
  findings: ReviewScopeGuardFinding[];
  crossPrReverts: CrossPrRevertFinding[];
}

export interface ReviewScopeGuardOptions {
  repoDir: string;
  featureDir?: string;
  sinceCommit?: string;
  baseRef?: string;
  headRef?: string;
  includeWorkingTree?: boolean;
  acknowledgementText?: string;
  maxRecentMerges?: number;
  writeBaseline?: boolean;
  shellRunner?: ShellRunner;
}

interface NameStatusEntry {
  status: string;
  path: string;
}

interface NumstatEntry {
  path: string;
  additions: number;
  deletions: number;
}

interface ReviewScopeBaseline {
  version: 1;
  createdAt: string;
  source: string;
  sinceCommit: string;
  headRef: string;
  paths: string[];
}

const BASELINE_FILE = '.review-scope-baseline.json';
const DEFAULT_DELETION_RATIO = 3;
const DEFAULT_DELETION_FLOOR = 50;

export const reviewScopeGuardDeps = {
  buildTaskContract,
  detectCrossPrReverts,
  execShellCommand,
};

export function validateReviewScope(options: ReviewScopeGuardOptions): ReviewScopeGuardResult {
  const repoDir = resolve(options.repoDir);
  const shellRunner = options.shellRunner ?? reviewScopeGuardDeps.execShellCommand;
  const headRef = options.headRef ?? 'HEAD';
  const findings: ReviewScopeGuardFinding[] = [];
  const featureDir = resolveFeatureDir(repoDir, options.featureDir, shellRunner);
  const declaredScope = featureDir ? loadDeclaredScope(featureDir, findings) : [];

  if (!featureDir) {
    findings.push({
      severity: 'blocker',
      category: 'review-scope',
      message: 'Unable to resolve the task feature directory; review scope cannot be proven.',
    });
  }

  const baseline = featureDir
    ? loadOrCreateBaseline({
      repoDir,
      featureDir,
      sinceCommit: options.sinceCommit,
      headRef,
      writeBaseline: options.writeBaseline ?? true,
      shellRunner,
      findings,
    })
    : null;
  const baselinePaths = baseline?.paths ?? [];

  if (!baseline) {
    findings.push({
      severity: 'blocker',
      category: 'review-scope',
      message: 'Unable to resolve a review baseline from reviewBaseCommit or an existing baseline artifact.',
    });
  }

  const baseRef = options.baseRef ?? options.sinceCommit ?? baseline?.sinceCommit;
  const changedEntries = baseRef
    ? collectChangedEntries(repoDir, baseRef, headRef, options.includeWorkingTree ?? false, shellRunner, findings)
    : [];
  const baselineSet = new Set(baselinePaths);
  const scopeMatchers = buildScopeMatchers(declaredScope);

  if (declaredScope.length === 0) {
    findings.push({
      severity: 'blocker',
      category: 'review-scope',
      message: 'Task contract has no usable Files to Modify or Scope In path entries.',
    });
  }

  for (const entry of changedEntries) {
    if (isAllowedPath(entry.path, baselineSet, scopeMatchers)) {
      continue;
    }
    findings.push({
      severity: 'blocker',
      category: 'review-scope',
      path: entry.path,
      status: entry.status,
      message:
        `Unexpected review change outside task scope: ${entry.path} (${entry.status}). ` +
        `Baseline source: ${baseline?.source ?? 'unresolved'}.`,
      details: {
        baselineSource: baseline?.source ?? null,
        declaredScope,
      },
    });
  }

  if (baseRef) {
    for (const budgetFinding of collectDeletionBudgetFindings(
      repoDir,
      baseRef,
      headRef,
      baselineSet,
      shellRunner,
      findings,
    )) {
      findings.push(budgetFinding);
    }
  }

  const crossPrReverts = baseRef
    ? collectCrossPrReverts({
      repoDir,
      baseRef,
      headRef,
      acknowledgementText: options.acknowledgementText,
      maxRecentMerges: options.maxRecentMerges,
      shellRunner,
      findings,
    })
    : [];

  for (const revert of crossPrReverts) {
    findings.push({
      severity: 'blocker',
      category: 'cross-pr-revert',
      message:
        `This branch appears to revert changes from PR #${revert.prNumber}` +
        `${revert.title ? ` (${revert.title})` : ''}. ` +
        `Acknowledge with "Reverts #${revert.prNumber}" only when intentional.`,
      details: {
        prNumber: revert.prNumber,
        files: revert.files,
        mergeCommit: revert.mergeCommit,
      },
    });
  }

  return {
    ok: !findings.some((finding) => finding.severity === 'blocker'),
    baselinePaths,
    declaredScope,
    baselineSource: baseline?.source ?? 'unresolved',
    featureDir,
    findings,
    crossPrReverts,
  };
}

function resolveFeatureDir(repoDir: string, explicit: string | undefined, shellRunner: ShellRunner): string | null {
  if (explicit) {
    return resolve(explicit);
  }

  let branch = '';
  try {
    branch = runGit(shellRunner, repoDir, 'git rev-parse --abbrev-ref HEAD').trim();
  } catch {
    return null;
  }
  const match = branch.match(/^(?:task|feature|bugfix|bug)\/(.+)$/);
  if (!match) {
    return null;
  }

  for (const root of ['features', 'bugs']) {
    const candidate = join(repoDir, root, match[1]);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function loadDeclaredScope(featureDir: string, findings: ReviewScopeGuardFinding[]): string[] {
  try {
    const { contract } = reviewScopeGuardDeps.buildTaskContract({ featureDir });
    return normalizeScopeEntries(contract.fields.allowedPaths);
  } catch (error) {
    findings.push({
      severity: 'blocker',
      category: 'review-scope',
      message: `Unable to build task contract for review scope: ${(error as Error).message}`,
    });
    return [];
  }
}

function normalizeScopeEntries(field: TaskContractField<string[]>): string[] {
  if (!field.present || !field.value) {
    return [];
  }

  const entries: string[] = [];
  for (const item of field.value) {
    const candidates = extractPathCandidates(item);
    entries.push(...(candidates.length > 0 ? candidates : [item.trim()]));
  }

  return [...new Set(entries.map(normalizeRepoPath).filter(Boolean))].sort();
}

function extractPathCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    candidates.push(...splitPathList(match[1]));
  }
  if (candidates.length > 0) {
    return candidates;
  }
  return splitPathList(text).filter((part) => /[/.]|[*]/.test(part));
}

function splitPathList(text: string): string[] {
  return text
    .split(/(?:,|\s+and\s+|\s+or\s+)/i)
    .map((part) => part.trim())
    .map((part) => part.replace(/\s+\(.+\)$/u, '').replace(/[:.;]$/u, ''))
    .filter(Boolean);
}

function loadOrCreateBaseline(input: {
  repoDir: string;
  featureDir: string;
  sinceCommit?: string;
  headRef: string;
  writeBaseline: boolean;
  shellRunner: ShellRunner;
  findings: ReviewScopeGuardFinding[];
}): ReviewScopeBaseline | null {
  const baselinePath = join(input.featureDir, BASELINE_FILE);
  const existing = readBaseline(baselinePath);
  if (existing) {
    return existing;
  }

  if (!input.sinceCommit) {
    return null;
  }

  const paths = collectNameOnly(input.repoDir, input.sinceCommit, input.headRef, input.shellRunner, input.findings);
  const baseline: ReviewScopeBaseline = {
    version: 1,
    createdAt: new Date().toISOString(),
    source: `git diff --name-only ${input.sinceCommit} ${input.headRef}`,
    sinceCommit: input.sinceCommit,
    headRef: input.headRef,
    paths,
  };

  if (input.writeBaseline) {
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8');
  }

  return baseline;
}

function readBaseline(path: string): ReviewScopeBaseline | null {
  try {
    if (!existsSync(path)) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ReviewScopeBaseline>;
    if (parsed.version !== 1 || !Array.isArray(parsed.paths) || typeof parsed.sinceCommit !== 'string') {
      return null;
    }
    return {
      version: 1,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
      source: typeof parsed.source === 'string' ? parsed.source : BASELINE_FILE,
      sinceCommit: parsed.sinceCommit,
      headRef: typeof parsed.headRef === 'string' ? parsed.headRef : 'HEAD',
      paths: [...new Set(parsed.paths.map(normalizeRepoPath).filter(Boolean))].sort(),
    };
  } catch {
    return null;
  }
}

function collectNameOnly(
  repoDir: string,
  baseRef: string,
  headRef: string,
  shellRunner: ShellRunner,
  findings: ReviewScopeGuardFinding[],
): string[] {
  try {
    return runGit(
      shellRunner,
      repoDir,
      `git diff --name-only ${escapeShellArg(baseRef)} ${escapeShellArg(headRef)}`,
    )
      .split(/\r?\n/)
      .map(normalizeRepoPath)
      .filter(Boolean)
      .sort();
  } catch (error) {
    findings.push({
      severity: 'blocker',
      category: 'review-scope',
      message: `Unable to collect review baseline files: ${(error as Error).message}`,
    });
    return [];
  }
}

function collectChangedEntries(
  repoDir: string,
  baseRef: string,
  headRef: string,
  includeWorkingTree: boolean,
  shellRunner: ShellRunner,
  findings: ReviewScopeGuardFinding[],
): NameStatusEntry[] {
  const entries = new Map<string, NameStatusEntry>();
  const commands = [
    `git diff --name-status ${escapeShellArg(baseRef)} ${escapeShellArg(headRef)}`,
  ];
  if (includeWorkingTree) {
    commands.push('git diff --name-status --cached');
    commands.push('git diff --name-status');
  }

  for (const command of commands) {
    try {
      for (const entry of parseNameStatusOutput(runGit(shellRunner, repoDir, command))) {
        entries.set(entry.path, entry);
      }
    } catch (error) {
      findings.push({
        severity: 'blocker',
        category: 'review-scope',
        message: `Unable to collect changed files for review scope: ${(error as Error).message}`,
      });
    }
  }

  if (includeWorkingTree) {
    try {
      for (const path of runGit(shellRunner, repoDir, 'git ls-files --others --exclude-standard').split(/\r?\n/)) {
        const normalized = normalizeRepoPath(path);
        if (normalized) {
          entries.set(normalized, { status: 'A', path: normalized });
        }
      }
    } catch (error) {
      findings.push({
        severity: 'blocker',
        category: 'review-scope',
        message: `Unable to collect untracked files for review scope: ${(error as Error).message}`,
      });
    }
  }

  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function collectDeletionBudgetFindings(
  repoDir: string,
  baseRef: string,
  headRef: string,
  baselineSet: ReadonlySet<string>,
  shellRunner: ShellRunner,
  findings: ReviewScopeGuardFinding[],
): ReviewScopeGuardFinding[] {
  let entries: NumstatEntry[];
  try {
    entries = parseNumstatOutput(runGit(
      shellRunner,
      repoDir,
      `git diff --numstat ${escapeShellArg(baseRef)} ${escapeShellArg(headRef)}`,
    ));
  } catch (error) {
    findings.push({
      severity: 'blocker',
      category: 'deletion-budget',
      message: `Unable to collect deletion budget evidence: ${(error as Error).message}`,
    });
    return [];
  }

  return entries
    .filter((entry) => !baselineSet.has(entry.path))
    .filter((entry) => entry.deletions >= DEFAULT_DELETION_FLOOR)
    .filter((entry) => entry.deletions > Math.max(DEFAULT_DELETION_FLOOR, entry.additions * DEFAULT_DELETION_RATIO))
    .map((entry) => ({
      severity: 'blocker' as const,
      category: 'deletion-budget' as const,
      path: entry.path,
      message:
        `Deletion budget exceeded outside task baseline: ${entry.path} ` +
        `(+${entry.additions}/-${entry.deletions}).`,
      details: {
        additions: entry.additions,
        deletions: entry.deletions,
        ratio: DEFAULT_DELETION_RATIO,
      },
    }));
}

function collectCrossPrReverts(input: {
  repoDir: string;
  baseRef: string;
  headRef: string;
  acknowledgementText?: string;
  maxRecentMerges?: number;
  shellRunner: ShellRunner;
  findings: ReviewScopeGuardFinding[];
}): CrossPrRevertFinding[] {
  const reviewMergeConfig = getReviewMergeConfig(input.repoDir);
  if (!reviewMergeConfig.crossPrRevertCheck.enabled) {
    return [];
  }

  const integrationRef = getIntegrationConfig(input.repoDir).integrationBranch;
  try {
    const reverts = reviewScopeGuardDeps.detectCrossPrReverts({
      repoDir: input.repoDir,
      baseRef: input.baseRef,
      headRef: input.headRef,
      integrationRef,
      maxRecentMerges: input.maxRecentMerges ?? reviewMergeConfig.crossPrRevertCheck.maxRecentMerges,
      shellRunner: input.shellRunner,
    });
    const acknowledgements = parseRevertAcknowledgements(input.acknowledgementText ?? loadAcknowledgementText(input.repoDir, input.shellRunner));
    return filterUnacknowledgedReverts(reverts, acknowledgements);
  } catch (error) {
    input.findings.push({
      severity: 'blocker',
      category: 'cross-pr-revert',
      message:
        `Unable to prove the branch does not revert recent integration work: ${(error as Error).message}`,
    });
    return [];
  }
}

function loadAcknowledgementText(repoDir: string, shellRunner: ShellRunner): string {
  try {
    return String(shellRunner(
      'gh pr view --json body,title,number --jq \'.title + "\\n" + (.body // "")\'',
      { cwd: repoDir, encoding: 'utf-8' },
    ));
  } catch {
    try {
      return String(shellRunner(
        'git log --format=%B -n 20 HEAD',
        { cwd: repoDir, encoding: 'utf-8' },
      ));
    } catch {
      return '';
    }
  }
}

function buildScopeMatchers(entries: string[]): Array<(path: string) => boolean> {
  return entries.map((entry) => {
    if (entry.includes('*')) {
      const re = new RegExp(`^${entry.split('*').map(escapeRegex).join('.*')}$`);
      return (path: string) => re.test(path);
    }
    if (entry.endsWith('/')) {
      return (path: string) => path.startsWith(entry);
    }
    return (path: string) => path === entry || path.startsWith(`${entry}/`);
  });
}

function isAllowedPath(
  path: string,
  baselineSet: ReadonlySet<string>,
  scopeMatchers: Array<(path: string) => boolean>,
): boolean {
  if (baselineSet.has(path) || scopeMatchers.some((matcher) => matcher(path))) {
    return true;
  }

  if (isSupportFile(path, baselineSet)) {
    return true;
  }

  return false;
}

function isSupportFile(path: string, baselineSet: ReadonlySet<string>): boolean {
  const base = basename(path);
  if (!/\.(?:test|spec)\.[^.]+$/.test(base) && !path.includes('/fixtures/')) {
    return false;
  }

  for (const ownedPath of baselineSet) {
    if (dirname(path) === dirname(ownedPath)) {
      return true;
    }
    const ownedStem = basename(ownedPath).replace(/\.[^.]+$/, '');
    if (base.startsWith(`${ownedStem}.`) || base.startsWith(`${ownedStem}-`)) {
      return true;
    }
  }

  return false;
}

function parseNameStatusOutput(output: string): NameStatusEntry[] {
  if (!output.trim()) {
    return [];
  }

  return output
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [statusToken = '', firstPath = '', secondPath = ''] = line.split('\t');
      const status = statusToken[0] ?? '';
      const path = status === 'R' || status === 'C' ? secondPath : firstPath;
      return { status, path: normalizeRepoPath(path) };
    })
    .filter((entry) => entry.status && entry.path);
}

function parseNumstatOutput(output: string): NumstatEntry[] {
  if (!output.trim()) {
    return [];
  }

  return output
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const [additions = '0', deletions = '0', path = ''] = line.split('\t');
      return {
        path: normalizeRepoPath(path),
        additions: additions === '-' ? 0 : Number.parseInt(additions, 10),
        deletions: deletions === '-' ? 0 : Number.parseInt(deletions, 10),
      };
    })
    .filter((entry) => entry.path && Number.isFinite(entry.additions) && Number.isFinite(entry.deletions));
}

function normalizeRepoPath(path: string): string {
  return path.trim().replace(/^\.\//, '').replace(/\\/g, '/');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runGit(shellRunner: ShellRunner, repoDir: string, command: string): string {
  return String(shellRunner(command, { cwd: repoDir, encoding: 'utf-8' }));
}

export function formatReviewScopeGuardResult(result: ReviewScopeGuardResult): string {
  if (result.ok) {
    return 'Review scope guard passed.';
  }

  return [
    'Review scope guard failed:',
    ...result.findings.map((finding) => {
      const location = finding.path ? ` ${finding.path}` : '';
      return `- [${finding.category}]${location} ${finding.message}`;
    }),
  ].join('\n');
}
