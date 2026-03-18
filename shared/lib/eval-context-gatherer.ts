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
 * @param repoDir - Repository directory
 * @param slug - Feature slug
 * @returns Task packet content or undefined
 */
function loadTaskPacket(repoDir: string, slug: string): string | undefined {
  const featureDirs = ['features', 'bugs'];

  for (const dir of featureDirs) {
    const featureDir = path.join(repoDir, dir, slug);
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

  return undefined;
}

/**
 * Find and load plan content.
 *
 * @param repoDir - Repository directory
 * @param slug - Feature slug
 * @returns Plan content or undefined
 */
function loadPlan(repoDir: string, slug: string): string | undefined {
  const featureDirs = ['features', 'bugs'];

  for (const dir of featureDirs) {
    const planPath = path.join(repoDir, dir, slug, 'plan.md');
    if (existsSync(planPath)) {
      try {
        return readFileSync(planPath, 'utf-8');
      } catch {
        // Continue to next option
      }
    }
  }

  return undefined;
}

/**
 * Format self-review summary from review metrics.
 *
 * @param repoDir - Repository directory
 * @param branch - Git branch name
 * @returns Formatted summary or undefined
 */
function loadSelfReviewSummary(
  repoDir: string,
  branch: string
): string | undefined {
  try {
    const metrics = loadMetrics(repoDir);
    if (!metrics || metrics.length === 0) return undefined;

    // Find the most recent review metric for this branch
    const relevantMetrics = metrics.filter((m) => m.branch === branch);
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
 * @param repoDir - Repository directory
 * @param issueId - Linear issue ID
 * @param branch - Git branch name
 * @returns Object with optional stage artifacts
 */
export function gatherStageArtifacts(
  repoDir: string,
  issueId: string,
  branch: string
): {
  taskPacket?: string;
  planContent?: string;
  selfReviewSummary?: string;
} {
  // Derive feature slug
  const slug = deriveFeatureSlug(branch, issueId, repoDir);
  if (!slug) {
    return {}; // Can't locate feature directory
  }

  // Gather artifacts
  const taskPacket = loadTaskPacket(repoDir, slug);
  const planContent = loadPlan(repoDir, slug);
  const selfReviewSummary = loadSelfReviewSummary(repoDir, branch);

  return {
    taskPacket,
    planContent,
    selfReviewSummary,
  };
}
