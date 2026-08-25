import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  INTEGRATION_DEFAULTS,
  getIntegrationConfig,
  loadWavemillConfig,
} from './config.ts';
import { resolveDefaultBaseRef } from './git-base-resolver.ts';
import { execArgvCommand } from './shell-utils.ts';

const REGISTRATION_COMPANIONS = new Set([
  'tests/run-unit-tests.sh',
  'tests/run-shell-suite.sh',
]);

const TEST_COMPANION_PATTERN = /^(?<base>.+)\.(?:test|spec)\.(?<ext>ts|tsx|js|jsx|mjs|cjs|sh)$/;

export const REVIEW_SCOPE_GUARD_NO_COMMIT_MESSAGE =
  'No review commit may be created until every out-of-scope staged path is unstaged or reverted.';

export const REVIEW_SCOPE_GUARD_UNVERIFIED_MESSAGE =
  'No review commit may be created because the review scope guard could not verify staged scope.';

export const REVIEW_SCOPE_GUARD_EXIT_OK = 0;
export const REVIEW_SCOPE_GUARD_EXIT_POLICY = 1;
export const REVIEW_SCOPE_GUARD_EXIT_TOOL = 2;

export interface ReviewScopeGuardToolError {
  commandClass: string;
  command: string;
  args: string[];
  exitCode?: number;
  stderr: string;
}

export interface ReviewScopeGuardResult {
  status: 'pass' | 'fail' | 'error';
  repoDir: string;
  integrationRef: string;
  mergeBase?: string;
  taskPaths: string[];
  stagedPaths: string[];
  allowedCompanionPaths: string[];
  outOfScopePaths: string[];
  message: string;
  toolError?: ReviewScopeGuardToolError;
}

export interface ReviewScopeGuardInput {
  repoDir: string;
  integrationRef?: string;
  headRef?: string;
}

export interface ReviewScopeGuardDeps {
  execArgvCommand: typeof execArgvCommand;
  getIntegrationConfig: typeof getIntegrationConfig;
  loadWavemillConfig: typeof loadWavemillConfig;
  resolveDefaultBaseRef: typeof resolveDefaultBaseRef;
  existsSync: typeof existsSync;
}

export const reviewScopeGuardDeps: ReviewScopeGuardDeps = {
  execArgvCommand,
  getIntegrationConfig,
  loadWavemillConfig,
  resolveDefaultBaseRef,
  existsSync,
};

class ReviewScopeGuardToolFailure extends Error {
  readonly toolError: ReviewScopeGuardToolError;

  constructor(toolError: ReviewScopeGuardToolError) {
    super(toolError.stderr || `${toolError.commandClass} failed`);
    this.toolError = toolError;
  }
}

export function runReviewScopeGuard(
  input: ReviewScopeGuardInput,
  deps: ReviewScopeGuardDeps = reviewScopeGuardDeps,
): ReviewScopeGuardResult {
  const repoDir = path.resolve(input.repoDir);
  let integrationRef = input.integrationRef || INTEGRATION_DEFAULTS.integrationBranch;
  const emptyResult = {
    repoDir,
    taskPaths: [],
    stagedPaths: [],
    allowedCompanionPaths: [],
    outOfScopePaths: [],
  };

  try {
    integrationRef = resolveIntegrationRef(repoDir, input.integrationRef, deps);
    const headRef = input.headRef || 'HEAD';
    const mergeBase = git(repoDir, ['merge-base', integrationRef, headRef], deps, 'git-merge-base').trim();
    if (!mergeBase) {
      throw new ReviewScopeGuardToolFailure({
        commandClass: 'git-merge-base',
        command: 'git merge-base',
        args: ['merge-base', integrationRef, headRef],
        stderr: `git merge-base returned an empty merge base for ${integrationRef} and ${headRef}`,
      });
    }

    const taskPaths = normalizeGitPaths(
      splitNullDelimited(git(repoDir, ['diff', '--name-only', '-z', mergeBase, headRef], deps, 'git-diff-task-scope')),
      'task scope',
    );
    const stagedPaths = normalizeGitPaths(
      splitNullDelimited(git(repoDir, ['diff', '--cached', '--name-only', '-z'], deps, 'git-diff-staged')),
      'staged index',
    );
    const taskPathSet = new Set(taskPaths);
    const allowedCompanionPaths = findAllowedCompanionPaths(stagedPaths, taskPathSet);
    const allowedCompanionSet = new Set(allowedCompanionPaths);
    const outOfScopePaths = stagedPaths.filter((stagedPath) => {
      return !taskPathSet.has(stagedPath) && !allowedCompanionSet.has(stagedPath);
    });

    if (outOfScopePaths.length > 0) {
      return {
        status: 'fail',
        repoDir,
        integrationRef,
        mergeBase,
        taskPaths,
        stagedPaths,
        allowedCompanionPaths,
        outOfScopePaths,
        message: REVIEW_SCOPE_GUARD_NO_COMMIT_MESSAGE,
      };
    }

    return {
      status: 'pass',
      repoDir,
      integrationRef,
      mergeBase,
      taskPaths,
      stagedPaths,
      allowedCompanionPaths,
      outOfScopePaths: [],
      message: 'Review scope guard passed: every staged path is in task scope or an allowed companion.',
    };
  } catch (error) {
    const toolError = error instanceof ReviewScopeGuardToolFailure
      ? error.toolError
      : {
          commandClass: 'internal',
          command: 'review-scope-guard',
          args: [],
          stderr: error instanceof Error ? error.message : String(error),
        };
    return {
      status: 'error',
      integrationRef,
      ...emptyResult,
      message: REVIEW_SCOPE_GUARD_UNVERIFIED_MESSAGE,
      toolError,
    };
  }
}

export function formatReviewScopeGuardText(result: ReviewScopeGuardResult): string {
  if (result.status === 'pass') {
    return [
      'review-scope-guard: pass',
      `Integration ref: ${result.integrationRef}`,
      result.mergeBase ? `Merge base: ${result.mergeBase}` : undefined,
      `Staged paths checked: ${result.stagedPaths.length}`,
    ].filter(Boolean).join('\n');
  }

  if (result.status === 'fail') {
    return [
      'review-scope-guard: out-of-scope staged changes blocked',
      result.message,
      '',
      'Out-of-scope staged paths:',
      ...result.outOfScopePaths.map((stagedPath) => `- ${JSON.stringify(stagedPath)}`),
      '',
      `Integration ref: ${result.integrationRef}`,
      result.mergeBase ? `Merge base: ${result.mergeBase}` : undefined,
      `Task-scoped paths: ${result.taskPaths.length}`,
    ].filter((line) => line !== undefined).join('\n');
  }

  return [
    'review-scope-guard: tool error',
    result.message,
    '',
    `Integration ref: ${result.integrationRef}`,
    result.toolError ? `Failure class: ${result.toolError.commandClass}` : undefined,
    result.toolError ? `Command: ${result.toolError.command} ${result.toolError.args.map(JSON.stringify).join(' ')}`.trim() : undefined,
    result.toolError?.stderr ? `Error: ${result.toolError.stderr}` : undefined,
  ].filter((line) => line !== undefined).join('\n');
}

function resolveIntegrationRef(
  repoDir: string,
  explicitIntegrationRef: string | undefined,
  deps: ReviewScopeGuardDeps,
): string {
  if (explicitIntegrationRef?.trim()) {
    return explicitIntegrationRef.trim();
  }

  const rawConfig = deps.loadWavemillConfig(repoDir);
  const integrationConfig = deps.getIntegrationConfig(repoDir);
  const hasLocalConfigFile = deps.existsSync(path.join(repoDir, '.wavemill-config.json'))
    || deps.existsSync(path.join(repoDir, '.wavemill-config.local.json'));

  if (
    integrationConfig.integrationBranch === INTEGRATION_DEFAULTS.integrationBranch
    && !rawConfig.integration?.integrationBranch
    && !hasLocalConfigFile
  ) {
    return deps.resolveDefaultBaseRef(repoDir) ?? integrationConfig.integrationBranch;
  }

  return integrationConfig.integrationBranch;
}

function git(
  repoDir: string,
  args: string[],
  deps: ReviewScopeGuardDeps,
  commandClass: string,
): string {
  const result = deps.execArgvCommand('git', args, {
    cwd: repoDir,
    encoding: 'utf-8',
  });
  if (result.exitCode !== 0) {
    throw new ReviewScopeGuardToolFailure({
      commandClass,
      command: 'git',
      args,
      exitCode: result.exitCode,
      stderr: result.stderr || result.stdout || `git exited with ${result.exitCode}`,
    });
  }
  return result.stdout;
}

function splitNullDelimited(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

function normalizeGitPaths(paths: string[], context: string): string[] {
  const normalized = paths.map((gitPath) => normalizeGitPath(gitPath, context));
  return [...new Set(normalized)].sort();
}

function normalizeGitPath(gitPath: string, context: string): string {
  if (!gitPath || gitPath.includes('\0') || path.isAbsolute(gitPath)) {
    throw new ReviewScopeGuardToolFailure({
      commandClass: 'git-path-normalization',
      command: 'normalize-git-path',
      args: [context],
      stderr: `Ambiguous ${context} path from Git: ${JSON.stringify(gitPath)}`,
    });
  }

  const normalized = path.posix.normalize(gitPath);
  const segments = gitPath.split('/');
  if (
    normalized !== gitPath
    || normalized === '.'
    || segments.some((segment) => segment === '.' || segment === '..' || segment === '')
  ) {
    throw new ReviewScopeGuardToolFailure({
      commandClass: 'git-path-normalization',
      command: 'normalize-git-path',
      args: [context],
      stderr: `Ambiguous ${context} path from Git: ${JSON.stringify(gitPath)}`,
    });
  }

  return gitPath;
}

function findAllowedCompanionPaths(stagedPaths: string[], taskPathSet: Set<string>): string[] {
  const companionPaths = new Set<string>();
  let hasAllowedTestCompanion = false;

  for (const stagedPath of stagedPaths) {
    if (isTestCompanionForScopedSource(stagedPath, taskPathSet)) {
      companionPaths.add(stagedPath);
      hasAllowedTestCompanion = true;
    }
  }

  if (hasAllowedTestCompanion) {
    for (const stagedPath of stagedPaths) {
      if (REGISTRATION_COMPANIONS.has(stagedPath)) {
        companionPaths.add(stagedPath);
      }
    }
  }

  return [...companionPaths].sort();
}

function isTestCompanionForScopedSource(stagedPath: string, taskPathSet: Set<string>): boolean {
  const match = stagedPath.match(TEST_COMPANION_PATTERN);
  if (!match?.groups) {
    return false;
  }
  const sourcePath = `${match.groups.base}.${match.groups.ext}`;
  return taskPathSet.has(sourcePath);
}
