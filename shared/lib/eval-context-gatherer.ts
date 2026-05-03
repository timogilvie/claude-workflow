/**
 * Eval context gathering — fetch and format all context needed for evaluation.
 *
 * Centralizes data fetching for:
 * - Linear issue data (via get-issue --json)
 * - GitHub PR data (diff and URL via gh CLI)
 *
 * All functions are non-throwing: errors are caught and return null/empty
 * values so eval can proceed with degraded data.
 *
 * @module eval-context-gatherer
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { escapeShellArg, execShellCommand } from './shell-utils.ts';
import { loadMetrics } from './review-metrics.ts';
import type { RoutingDecision, RoutingCandidate } from './eval-schema.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** Complete context needed for running eval. */
export interface EvalContext {
  /** Formatted task prompt (issue title + description) */
  taskPrompt: string;
  /** PR diff content */
  prDiff: string;
  /** PR URL */
  prUrl: string;
  /** Raw issue data from Linear (null if fetch failed) */
  issueData: any | null;
  /** Expanded task packet content (if available) */
  taskPacket?: string;
  /** Implementation plan content (if available) */
  planContent?: string;
  /** Self-review summary (if available) */
  selfReviewSummary?: string;
  /** Routing decision loaded from .routing-complete (if available) */
  routingDecision?: RoutingDecision;
}

/** Input parameters for gathering context. */
export interface GatherContextParams {
  /** Linear issue ID (e.g. "HOK-870") */
  issueId?: string;
  /** GitHub PR number */
  prNumber?: string;
  /** PR URL (if already known) */
  prUrl?: string;
  /** Repository directory */
  repoDir: string;
}

// ────────────────────────────────────────────────────────────────
// Issue Data Fetching
// ────────────────────────────────────────────────────────────────

/**
 * Fetch issue data from Linear via the get-issue tool in JSON mode.
 * Returns the parsed issue object or null on failure.
 */
export function fetchIssueData(issueId: string, repoDir: string): any | null {
  const toolPath = resolve(__dirname, '../../tools/get-issue.ts');
  try {
    const raw = execShellCommand(
      `npx tsx ${escapeShellArg(toolPath)} ${escapeShellArg(issueId)} --json 2>/dev/null | sed '/^\\[dotenv/d'`,
      { encoding: 'utf-8', cwd: repoDir }
    ).trim();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Format issue data as a markdown prompt.
 */
export function formatIssueAsPrompt(issue: any | null, issueId: string): string {
  if (!issue) return `Issue: ${issueId} (details unavailable)`;
  return `# ${issue.identifier}: ${issue.title}\n\n${issue.description || ''}`;
}

// ────────────────────────────────────────────────────────────────
// PR Data Fetching
// ────────────────────────────────────────────────────────────────

/**
 * Fetch PR diff and URL from GitHub.
 */
export function fetchPrContext(prNumber: string, repoDir: string): { diff: string; url: string } {
  let url = '';
  let diff = '';

  try {
    url = execShellCommand(`gh pr view ${escapeShellArg(prNumber)} --json url --jq .url 2>/dev/null`, {
      encoding: 'utf-8', cwd: repoDir,
    }).trim();
  } catch { /* best-effort */ }

  try {
    diff = execShellCommand(`gh pr diff ${escapeShellArg(prNumber)}`, {
      encoding: 'utf-8', cwd: repoDir, maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    diff = '(PR diff unavailable)';
  }

  return { diff, url };
}

/**
 * Compute wall-clock time in seconds for a task branch.
 *
 * Uses commit timestamps from the branch's history relative to the base branch.
 * Returns null when duration cannot be determined reliably, including branches
 * with fewer than two commits or when git history cannot be read.
 *
 * @param repoDir - Repository directory
 * @param branch - Branch to inspect
 * @param baseBranch - Base branch used to define branch-local commits
 * @returns Duration in seconds, or null when indeterminate
 */
export function computeWallClockSeconds(
  repoDir: string,
  branch: string,
  baseBranch = 'main',
): number | null {
  try {
    const raw = execShellCommand(
      `git log ${escapeShellArg(baseBranch)}..${escapeShellArg(branch)} --format="%ct" --reverse`,
      { encoding: 'utf-8', cwd: repoDir }
    ).trim();

    if (!raw) {
      return null;
    }

    const timestamps = raw
      .split('\n')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);

    if (timestamps.length < 2) {
      return null;
    }

    const firstTimestamp = timestamps[0];
    const lastTimestamp = timestamps[timestamps.length - 1];

    return Math.max(0, lastTimestamp - firstTimestamp);
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────
// Orchestrator
// ────────────────────────────────────────────────────────────────

/**
 * Gather all context needed for evaluation in a single call.
 *
 * Fetches issue data from Linear and PR data from GitHub.
 * Non-blocking: failures result in degraded data (empty strings, null values).
 *
 * @param params - Context gathering parameters
 * @returns Complete eval context
 */
export function gatherEvalContext(params: GatherContextParams): EvalContext {
  const { issueId, prNumber, prUrl, repoDir } = params;

  // Fetch issue data
  let issueData: any | null = null;
  if (issueId) {
    issueData = fetchIssueData(issueId, repoDir);
  }
  const taskPrompt = formatIssueAsPrompt(issueData, issueId || '');

  // Fetch PR data
  let prDiff = '';
  let finalPrUrl = prUrl || '';
  if (prNumber) {
    const prCtx = fetchPrContext(prNumber, repoDir);
    prDiff = prCtx.diff;
    if (!finalPrUrl) finalPrUrl = prCtx.url;
  }

  return {
    taskPrompt,
    prDiff,
    prUrl: finalPrUrl,
    issueData,
  };
}

// ────────────────────────────────────────────────────────────────
// Auto-Detection
// ────────────────────────────────────────────────────────────────

/**
 * Auto-detect context from workflow state or current branch.
 *
 * Falls back in this order:
 * 1. .wavemill/workflow-state.json (most recent task with PR)
 * 2. Current branch's open PR (via gh CLI)
 *
 * @param repoDir - Repository directory
 * @returns Detected context (issueId, prNumber, branch, prUrl)
 */
export function autoDetectContext(repoDir: string): {
  issueId: string;
  prNumber: string;
  branch: string;
  prUrl: string;
} {
  let issueId = '';
  let prNumber = '';
  let branch = '';
  let prUrl = '';

  // Try workflow state file
  const stateFile = path.join(repoDir, '.wavemill', 'workflow-state.json');
  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
      const tasks = state.tasks || {};

      // Find most recently updated task that has a PR
      let mostRecent: any = null;
      let mostRecentTime = '';
      for (const [id, task] of Object.entries(tasks)) {
        const t = task as any;
        if (t.pr && (!mostRecentTime || t.updated > mostRecentTime)) {
          mostRecent = { id, ...t };
          mostRecentTime = t.updated;
        }
      }

      if (mostRecent) {
        issueId = mostRecent.id;
        prNumber = String(mostRecent.pr);
        branch = mostRecent.branch || '';
      }
    } catch {
      // Best-effort
    }
  }

  // Try current branch PR
  if (!prNumber) {
    try {
      branch = execShellCommand('git branch --show-current', {
        encoding: 'utf-8',
        cwd: repoDir,
      }).trim();

      const prJson = execShellCommand(
        'gh pr view --json number,url 2>/dev/null || echo "{}"',
        {
          encoding: 'utf-8',
          cwd: repoDir,
        }
      ).trim();

      const prData = JSON.parse(prJson);
      if (prData.number) {
        prNumber = String(prData.number);
        prUrl = prData.url || '';
      }
    } catch {
      // Best-effort
    }
  }

  if (!issueId && !prNumber) {
    throw new Error(
      'No workflow context found. Auto-detection requires either:\n' +
        '  1. .wavemill/workflow-state.json with a completed task\n' +
        '  2. An open PR on the current branch\n\n' +
        'Or provide explicit arguments: --issue HOK-123 --pr 456'
    );
  }

  return { issueId, prNumber, branch, prUrl };
}

// ────────────────────────────────────────────────────────────────
// Routing Decision Loading (HOK-1002)
// ────────────────────────────────────────────────────────────────

/** Raw shape of the .routing-complete file. */
export interface RoutingCompleteData {
  planner: string;
  coder: string;
  reviewer: string;
  planDepth?: string;
  codeDepth?: string;
  reviewMode?: string;
  maxCostUsd?: number;
}

function readMaxCostUsdFromRoutingData(data: Record<string, unknown>): number | undefined {
  const topLevel = data.maxCostUsd;
  if (typeof topLevel === 'number' && Number.isFinite(topLevel) && topLevel >= 0) {
    return topLevel;
  }

  const constraints = data.constraints;
  if (!constraints || typeof constraints !== 'object' || Array.isArray(constraints)) {
    return undefined;
  }

  const nested = (constraints as Record<string, unknown>).maxCostUsd;
  return typeof nested === 'number' && Number.isFinite(nested) && nested >= 0 ? nested : undefined;
}

/**
 * Convert raw routing data to the RoutingDecision schema.
 *
 * Builds candidates from unique models, picks the coder as the chosen model
 * (primary executor), and includes depth/mode in the rationale.
 */
export function convertToRoutingDecision(data: RoutingCompleteData): RoutingDecision {
  // Build unique candidates from all models used
  const modelSet = new Map<string, RoutingCandidate>();
  for (const modelId of [data.planner, data.coder, data.reviewer]) {
    if (modelId && !modelSet.has(modelId)) {
      modelSet.set(modelId, {
        agentType: 'claude',
        modelId,
      });
    }
  }
  const candidates = Array.from(modelSet.values());

  // Chosen is the coder model (primary executor)
  const chosen = candidates.find((c) => c.modelId === data.coder) || candidates[0];

  // Build rationale from depth/mode settings
  const parts: string[] = [];
  if (data.planDepth) parts.push(`planDepth=${data.planDepth}`);
  if (data.codeDepth) parts.push(`codeDepth=${data.codeDepth}`);
  if (data.reviewMode) parts.push(`reviewMode=${data.reviewMode}`);
  const decisionRationale = parts.length > 0
    ? `Routing: planner=${data.planner}, coder=${data.coder}, reviewer=${data.reviewer}; ${parts.join(', ')}`
    : `Routing: planner=${data.planner}, coder=${data.coder}, reviewer=${data.reviewer}`;

  return {
    candidates,
    chosen,
    decisionPolicyVersion: 'baseline',
    decisionRationale,
  };
}

/**
 * Load routing decision from .routing-complete file in the feature directory.
 *
 * Searches worktree first (if provided), then falls back to repoDir.
 *
 * Returns null if the file is missing, malformed, or lacks required fields.
 */
export function fetchRoutingDecision(
  repoDir: string,
  slug: string,
  worktreePath?: string
): RoutingDecision | null {
  const featureDirs = ['features', 'bugs'];
  const searchRoots = [worktreePath, repoDir].filter((p): p is string => Boolean(p));

  for (const root of searchRoots) {
    for (const dir of featureDirs) {
      const routingPath = path.join(root, dir, slug, '.routing-complete');
      if (!existsSync(routingPath)) continue;

      try {
        const raw = readFileSync(routingPath, 'utf-8');
        const data = JSON.parse(raw) as Record<string, unknown>;

        // Validate required fields
        if (
          typeof data.planner !== 'string' ||
          typeof data.coder !== 'string' ||
          typeof data.reviewer !== 'string' ||
          (
            (typeof data.maxCostUsd !== 'undefined'
              || (
                data.constraints
                && typeof data.constraints === 'object'
                && !Array.isArray(data.constraints)
                && 'maxCostUsd' in (data.constraints as Record<string, unknown>)
              ))
            && typeof readMaxCostUsdFromRoutingData(data) !== 'number'
          )
        ) {
          return null;
        }

        return convertToRoutingDecision({
          ...data,
          maxCostUsd: readMaxCostUsdFromRoutingData(data),
        } as RoutingCompleteData);
      } catch {
        return null;
      }
    }
  }

  return null;
}

function parseRoutingCompleteData(raw: string): RoutingCompleteData | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const maxCostUsd = readMaxCostUsdFromRoutingData(data);
    if (
      typeof data.planner !== 'string' ||
      typeof data.coder !== 'string' ||
      typeof data.reviewer !== 'string' ||
      (
        (typeof data.maxCostUsd !== 'undefined'
          || (
            data.constraints
            && typeof data.constraints === 'object'
            && !Array.isArray(data.constraints)
            && 'maxCostUsd' in (data.constraints as Record<string, unknown>)
          ))
        && typeof maxCostUsd !== 'number'
      )
    ) {
      return null;
    }
    return {
      planner: data.planner,
      coder: data.coder,
      reviewer: data.reviewer,
      ...(typeof data.planDepth === 'string' ? { planDepth: data.planDepth } : {}),
      ...(typeof data.codeDepth === 'string' ? { codeDepth: data.codeDepth } : {}),
      ...(typeof data.reviewMode === 'string' ? { reviewMode: data.reviewMode } : {}),
      ...(typeof maxCostUsd === 'number' ? { maxCostUsd } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch raw routing decision data from .routing-complete file.
 *
 * Unlike fetchRoutingDecision, this returns the raw data structure
 * without converting to RoutingDecision schema. Used by task descriptor
 * builder to extract per-stage model assignments.
 *
 * @param repoDir - Repository root directory
 * @param slug - Feature slug (e.g., "my-feature")
 * @param worktreePath - Optional worktree path to search first
 * @returns Raw routing data or null if not found
 */
export function fetchRoutingCompleteRaw(
  repoDir: string,
  slug: string,
  worktreePath?: string,
): RoutingCompleteData | null {
  const featureDirs = ['features', 'bugs'];
  const searchRoots = [worktreePath, repoDir].filter(
    (p): p is string => Boolean(p),
  );

  for (const root of searchRoots) {
    for (const dir of featureDirs) {
      const routingPath = path.join(root, dir, slug, '.routing-complete');
      if (!existsSync(routingPath)) continue;

      try {
        return parseRoutingCompleteData(readFileSync(routingPath, 'utf-8'));
      } catch {
        return null;
      }
    }
  }

  return null;
}

function loadRoutingCompleteRawFromArchive(
  repoDir: string,
  issueId: string,
): RoutingCompleteData | null {
  const content = loadFromArchive(repoDir, issueId, 'routing-complete.json');
  if (!content) {
    return null;
  }
  return parseRoutingCompleteData(content);
}

export function fetchRoutingCompleteRawWithArchive(
  repoDir: string,
  slug: string,
  issueId: string,
  worktreePath?: string,
): RoutingCompleteData | null {
  return fetchRoutingCompleteRaw(repoDir, slug, worktreePath)
    ?? loadRoutingCompleteRawFromArchive(repoDir, issueId);
}

// ────────────────────────────────────────────────────────────────
// Stage Artifacts (HOK-1004)
// ────────────────────────────────────────────────────────────────

/**
 * Derive feature slug from branch name or issue ID.
 *
 * @param branch - Git branch name (e.g., "task/my-feature")
 * @param issueId - Linear issue ID (e.g., "HOK-1004")
 * @param repoDir - Repository directory
 * @returns Feature slug or undefined
 */
function deriveFeatureSlug(
  branch: string,
  issueId: string,
  repoDir: string
): string | undefined {
  // Try branch name first (strip task/ or bug/ prefix)
  if (branch) {
    const slug = branch.replace(/^(task|bug)\//, '');
    if (slug && slug !== branch) {
      return slug;
    }
  }

  // Scan features/*/selected-task.json for matching issueId
  if (issueId) {
    try {
      const featuresDirs = ['features', 'bugs'];
      for (const dir of featuresDirs) {
        const dirPath = path.join(repoDir, dir);
        if (!existsSync(dirPath)) continue;

        const subdirs = readdirSync(dirPath, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);

        for (const subdir of subdirs) {
          const taskFile = path.join(dirPath, subdir, 'selected-task.json');
          if (existsSync(taskFile)) {
            try {
              const task = JSON.parse(readFileSync(taskFile, 'utf-8'));
              if (task.taskId === issueId || task.id === issueId) {
                return subdir;
              }
            } catch {
              // Skip malformed files
            }
          }
        }
      }
    } catch {
      // Best-effort
    }
  }

  return undefined;
}

/**
 * Find and load task packet content.
 *
 * Looks for:
 * 1. features/<slug>/task-packet.md (full format)
 * 2. features/<slug>/task-packet-header.md + task-packet-details.md (split format)
 *
 * Searches worktree first (if provided), then falls back to repoDir.
 *
 * @param repoDir - Repository directory
 * @param slug - Feature slug
 * @param worktreePath - Optional worktree path to search first
 * @returns Task packet content or undefined
 */
function loadTaskPacket(repoDir: string, slug: string, worktreePath?: string): string | undefined {
  const featureDirs = ['features', 'bugs'];
  const searchRoots = [worktreePath, repoDir].filter((p): p is string => Boolean(p));

  for (const root of searchRoots) {
    for (const dir of featureDirs) {
      const featureDir = path.join(root, dir, slug);
      if (!existsSync(featureDir)) continue;

      // Try full format first
      const fullPath = path.join(featureDir, 'task-packet.md');
      if (existsSync(fullPath)) {
        try {
          return readFileSync(fullPath, 'utf-8');
        } catch {
          // Continue to next option
        }
      }

      // Try split format (header + details)
      const headerPath = path.join(featureDir, 'task-packet-header.md');
      const detailsPath = path.join(featureDir, 'task-packet-details.md');
      if (existsSync(headerPath) && existsSync(detailsPath)) {
        try {
          const header = readFileSync(headerPath, 'utf-8');
          const details = readFileSync(detailsPath, 'utf-8');
          return `${header}\n\n---\n\n${details}`;
        } catch {
          // Continue to next option
        }
      }

      // Try just header (if details missing)
      if (existsSync(headerPath)) {
        try {
          return readFileSync(headerPath, 'utf-8');
        } catch {
          // Continue to next option
        }
      }
    }
  }

  return undefined;
}

/**
 * Find and load plan content.
 *
 * Searches worktree first (if provided), then falls back to repoDir.
 *
 * @param repoDir - Repository directory
 * @param slug - Feature slug
 * @param worktreePath - Optional worktree path to search first
 * @returns Plan content or undefined
 */
function loadPlan(repoDir: string, slug: string, worktreePath?: string): string | undefined {
  const featureDirs = ['features', 'bugs'];
  const searchRoots = [worktreePath, repoDir].filter((p): p is string => Boolean(p));

  for (const root of searchRoots) {
    for (const dir of featureDirs) {
      const planPath = path.join(root, dir, slug, 'plan.md');
      if (existsSync(planPath)) {
        try {
          return readFileSync(planPath, 'utf-8');
        } catch {
          // Continue to next option
        }
      }
    }
  }

  return undefined;
}

/**
 * Format self-review summary from review metrics.
 *
 * Loads metrics from worktree first (if provided), then repoDir, merging results.
 *
 * @param repoDir - Repository directory
 * @param branch - Git branch name
 * @param worktreePath - Optional worktree path to search first
 * @returns Formatted summary or undefined
 */
function loadSelfReviewSummary(
  repoDir: string,
  branch: string,
  worktreePath?: string
): string | undefined {
  try {
    // Load metrics from both worktree and repoDir, then merge
    const searchRoots = [worktreePath, repoDir].filter((p): p is string => Boolean(p));
    const allMetrics: any[] = [];
    const seenIds = new Set<string>();

    for (const root of searchRoots) {
      try {
        const metrics = loadMetrics(root);
        if (metrics && metrics.length > 0) {
          // Deduplicate by metric ID
          for (const metric of metrics) {
            const metricId = `${metric.branch}-${metric.timestamp}`;
            if (!seenIds.has(metricId)) {
              seenIds.add(metricId);
              allMetrics.push(metric);
            }
          }
        }
      } catch {
        // Continue to next root
      }
    }

    if (allMetrics.length === 0) return undefined;

    // Find the most recent review metric for this branch
    const relevantMetrics = allMetrics.filter((m) => m.branch === branch);
    if (relevantMetrics.length === 0) return undefined;

    // Sort by timestamp descending
    relevantMetrics.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    const metric = relevantMetrics[0];

    // Build compact summary
    const lines = [
      `Self-Review Summary (${metric.outcome})`,
      `- Iterations: ${metric.totalIterations}`,
    ];

    for (const iteration of metric.iterations) {
      const { iterationNumber, verdict, findingsSummary } = iteration;
      const blockers = findingsSummary.blockers;
      const warnings = findingsSummary.warnings;
      lines.push(
        `  - Iteration ${iterationNumber}: ${verdict} (${blockers} blockers, ${warnings} warnings)`
      );
    }

    return lines.join('\n');
  } catch {
    return undefined;
  }
}

/**
 * Gather stage artifacts for eval judge attribution.
 *
 * Best-effort collection of:
 * - Task packet (expanded issue specification)
 * - Implementation plan
 * - Self-review summary
 *
 * All failures result in undefined (judge will skip that stage).
 *
 * Searches worktree first (if provided), then falls back to repoDir.
 *
 * @param repoDir - Repository directory
 * @param issueId - Linear issue ID
 * @param branch - Git branch name
 * @param worktreePath - Optional worktree path to search first
 * @returns Object with optional stage artifacts
 */
/**
 * Load an artifact from the eval archive directory.
 *
 * Archive artifacts are created by wavemill-mill.sh's archive_stage_artifacts()
 * before worktree cleanup, so they persist even after the worktree is removed.
 *
 * @param repoDir - Repository directory
 * @param issueId - Linear issue ID
 * @param filename - Artifact filename (e.g., 'plan.md', 'task-packet.md')
 * @returns File content or undefined
 */
function loadFromArchive(repoDir: string, issueId: string, filename: string): string | undefined {
  const archivePath = path.join(repoDir, '.wavemill', 'evals', 'artifacts', issueId, filename);
  if (existsSync(archivePath)) {
    try {
      return readFileSync(archivePath, 'utf-8');
    } catch {
      // Continue
    }
  }
  return undefined;
}

export function gatherStageArtifacts(
  repoDir: string,
  issueId: string,
  branch: string,
  worktreePath?: string
): {
  taskPacket?: string;
  planContent?: string;
  selfReviewSummary?: string;
  routingDecision?: RoutingDecision;
  executionModel?: string;
} {
  // Derive feature slug
  const slug = deriveFeatureSlug(branch, issueId, repoDir);
  if (!slug) {
    // Even without a slug, try the archive dir (keyed by issueId)
    return {
      taskPacket: loadFromArchive(repoDir, issueId, 'task-packet.md'),
      planContent: loadFromArchive(repoDir, issueId, 'plan.md'),
      selfReviewSummary: undefined,
      routingDecision: undefined,
      executionModel: undefined,
    };
  }

  // Gather artifacts (search worktree first, then fall back to repoDir)
  const taskPacket = loadTaskPacket(repoDir, slug, worktreePath)
    ?? loadFromArchive(repoDir, issueId, 'task-packet.md');
  const planContent = loadPlan(repoDir, slug, worktreePath)
    ?? loadFromArchive(repoDir, issueId, 'plan.md');
  const selfReviewSummary = loadSelfReviewSummary(repoDir, branch, worktreePath);
  const routingDecision = fetchRoutingDecision(repoDir, slug, worktreePath)
    ?? loadRoutingDecisionFromArchive(repoDir, issueId)
    ?? undefined;

  return {
    taskPacket,
    planContent,
    selfReviewSummary,
    routingDecision,
    executionModel: loadStageExecutionModel(repoDir, slug, worktreePath),
  };
}

function loadStageExecutionModel(repoDir: string, slug: string, worktreePath?: string): string | undefined {
  const resultPaths = ['coding', 'review', 'planning'].flatMap((stage) => {
    const paths: string[] = [];
    if (worktreePath) {
      paths.push(path.join(worktreePath, 'features', slug, `.${stage}-result.json`));
    }
    paths.push(path.join(repoDir, 'features', slug, `.${stage}-result.json`));
    paths.push(path.join(repoDir, 'bugs', slug, `.${stage}-result.json`));
    return paths;
  });

  for (const resultPath of resultPaths) {
    if (!existsSync(resultPath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(resultPath, 'utf-8')) as { model?: unknown };
      if (typeof parsed.model === 'string' && parsed.model.trim().length > 0) {
        return parsed.model;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

/**
 * Load routing decision from the archive directory.
 */
function loadRoutingDecisionFromArchive(repoDir: string, issueId: string): RoutingDecision | null {
  const content = loadFromArchive(repoDir, issueId, 'routing-complete.json');
  if (content) {
    try {
      return JSON.parse(content) as RoutingDecision;
    } catch {
      // Invalid JSON
    }
  }
  return null;
}
