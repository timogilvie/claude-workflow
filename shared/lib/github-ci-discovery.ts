/**
 * GitHub CI check discovery engine.
 *
 * Discovers branch-protection required checks from GitHub without assuming
 * command mappings. Returns check names and workflow job provenance for
 * explicit recipe configuration.
 *
 * Does not execute workflow YAML locally — only discovers available checks.
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface GitHubDiscoveryResult {
  checks: string[];
  source: 'protection' | 'ruleset' | 'mixed';
  timestamp: string; // ISO 8601
  workflows?: WorkflowJob[];
}

export interface WorkflowJob {
  name: string;
  path: string; // Relative path to workflow file
  triggers: string[]; // Event triggers (push, pull_request, etc.)
}

export class GitHubPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubPermissionError';
  }
}

export class GitHubNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubNotFoundError';
  }
}

export class GitHubAPIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAPIError';
  }
}

// ────────────────────────────────────────────────────────────────
// Discovery Functions
// ────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/**
 * Retry a function on transient failures (network errors, rate limits).
 * Throws on persistent errors.
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts = MAX_RETRIES,
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;

      // Don't retry permission errors
      if (err instanceof GitHubPermissionError) {
        throw err;
      }

      // Check if this is a transient error
      const isTransient =
        /timeout|ECONNRESET|ECONNREFUSED|rate limit/i.test((err as Error).message);

      if (!isTransient || attempt === maxAttempts) {
        throw err;
      }

      // Exponential backoff
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error('Unknown error in retryWithBackoff');
}

/**
 * Discover required checks from GitHub branch protection or rulesets.
 *
 * @param repo Repository in "owner/repo" format
 * @param branch Branch name (default: integration)
 * @returns Discovery result with check names and source
 * @throws GitHubPermissionError if auth is missing or insufficient
 * @throws GitHubNotFoundError if repo/branch not found
 */
export async function discoverGitHubRequiredChecks(
  repo: string,
  branch = 'auto/integration',
): Promise<GitHubDiscoveryResult> {
  const checks = new Set<string>();
  let source: 'protection' | 'ruleset' | 'mixed' = 'protection';

  // Try branch protection rules first
  try {
    const protection = await retryWithBackoff(async () => {
      const output = execSync(
        `gh api repos/${repo}/branches/${branch}/protection/required_status_checks --jq '.contexts[]' 2>&1`,
        { encoding: 'utf-8' },
      );
      return output.trim().split('\n').filter((line) => line.length > 0);
    });

    for (const check of protection) {
      checks.add(check);
    }
  } catch (err) {
    const msg = (err as Error).message;
    if (/not found|404|does not exist/i.test(msg)) {
      // Branch or repo doesn't exist
      throw new GitHubNotFoundError(
        `Repository or branch not found: ${repo}/${branch}\n` +
        `Ensure the branch exists and is protected with required checks.`,
      );
    }
    if (/permission denied|unauthorized|403|requires authentication/i.test(msg)) {
      throw new GitHubPermissionError(
        `GitHub API permission denied. Ensure you have access to the repository.\n` +
        `Install gh CLI: https://cli.github.com\n` +
        `Authenticate: gh auth login`,
      );
    }
    // Other errors — try rulesets below
  }

  // Try rulesets (GitHub Enterprise / newer API)
  try {
    const rulesets = await retryWithBackoff(async () => {
      const output = execSync(
        `gh api repos/${repo}/rulesets --jq '.[] | select(.target == "branch") | .rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[]' 2>&1`,
        { encoding: 'utf-8' },
      );
      return output.trim().split('\n').filter((line) => line.length > 0);
    });

    const hadProtection = checks.size > 0;
    for (const check of rulesets) {
      checks.add(check);
    }
    if (rulesets.length > 0) {
      source = hadProtection ? 'mixed' : 'ruleset';
    }
  } catch (err) {
    // Rulesets not available is not an error
    if (!/not found|404|does not exist/i.test((err as Error).message)) {
      if (checks.size === 0) {
        // No checks from either source
        throw new GitHubAPIError(
          `Failed to discover checks from GitHub.\n` +
          `Ensure gh CLI is installed and authenticated: gh auth login\n` +
          `Error: ${(err as Error).message}`,
        );
      }
    }
  }

  if (checks.size === 0) {
    throw new GitHubAPIError(
      `No required checks found for ${repo}/${branch}\n` +
      `Repository may not have branch protection configured.`,
    );
  }

  return {
    checks: Array.from(checks).sort(),
    source,
    timestamp: new Date().toISOString(),
  };
}

/**
 * List all GitHub Actions workflow jobs in the repository.
 *
 * @param repo Repository in "owner/repo" format
 * @returns List of workflow jobs with names and triggers
 * @throws GitHubPermissionError if auth is missing
 */
export async function getWorkflowJobs(repo: string): Promise<WorkflowJob[]> {
  const jobs: WorkflowJob[] = [];

  try {
    const workflows = await retryWithBackoff(async () => {
      const output = execSync(
        `gh api repos/${repo}/actions/workflows --jq '[.workflows[] | {path: .path, name: .name}]' 2>&1`,
        { encoding: 'utf-8' },
      );
      return JSON.parse(output);
    });

    for (const workflow of workflows) {
      try {
        const content = await retryWithBackoff(async () => {
          return execSync(
            `gh api repos/${repo}/contents/${workflow.path} --jq '.content | @base64d' 2>&1`,
            { encoding: 'utf-8' },
          );
        });

        // Parse YAML to extract jobs and triggers (simplified)
        // In production, use a YAML parser library
        const triggers = parseWorkflowTriggers(content);
        const workflowJobs = parseWorkflowJobs(content);

        for (const job of workflowJobs) {
          jobs.push({
            name: job,
            path: workflow.path,
            triggers,
          });
        }
      } catch {
        // Skip workflows we can't read
      }
    }
  } catch (err) {
    if (/permission denied|unauthorized|403/i.test((err as Error).message)) {
      throw new GitHubPermissionError(
        `GitHub API permission denied when fetching workflows.\n` +
        `Authenticate with: gh auth login`,
      );
    }
    // Other errors are non-fatal for workflow listing
  }

  return jobs;
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

/**
 * Extract trigger events from GitHub Actions workflow YAML.
 * Simplified parser — uses regex to find 'on:' section.
 */
function parseWorkflowTriggers(yaml: string): string[] {
  const triggers: string[] = [];

  // Match 'on:' section
  const onMatch = yaml.match(/^on:\s*\n([\s\S]*?)(?=^\w|$)/m);
  if (onMatch) {
    const onContent = onMatch[1];
    // Extract trigger names (push, pull_request, etc.)
    const lines = onContent.split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([a-z_]+):\s*(?:$|#)/);
      if (match) {
        triggers.push(match[1]);
      }
    }
  }

  return triggers.length > 0 ? triggers : ['unknown'];
}

/**
 * Extract job names from GitHub Actions workflow YAML.
 * Simplified parser — uses regex to find 'jobs:' section.
 */
function parseWorkflowJobs(yaml: string): string[] {
  const jobs: string[] = [];

  // Match 'jobs:' section
  const jobsMatch = yaml.match(/^jobs:\s*\n([\s\S]*?)(?=^\w|$)/m);
  if (jobsMatch) {
    const jobsContent = jobsMatch[1];
    // Extract job names (keys at start of line with colon)
    const lines = jobsContent.split('\n');
    for (const line of lines) {
      const match = line.match(/^(\s*)([a-zA-Z_][a-zA-Z0-9_-]*):\s*(?:$|#)/);
      if (match && match[1].length === 2) {
        // Top-level job (2 spaces)
        jobs.push(match[2]);
      }
    }
  }

  return jobs;
}
