import { readFileSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const defaultRepoRoot = join(__dirname, '..');

/**
 * Contract test for the CI workflow's concurrency policy (HOK-2938).
 *
 * The policy this guards:
 * - pull_request runs group by workflow + PR number and cancel superseded
 *   runs of the *same* PR only.
 * - Every non-PR run (push to protected branches, schedule,
 *   workflow_dispatch) is isolated by github.run_id so it can never be
 *   cancelled by — or queued behind — any other run.
 * - cancel-in-progress is event-conditional, never a blanket literal.
 * - The "Shell and Unit Tests" aggregator keeps failing on cancelled
 *   dependencies, so a cancelled current-head job can never report green.
 *
 * Parsing is regex-based on purpose: the repo has no YAML dependency and the
 * sibling drift checker (check-ci-command-map-drift.ts) uses the same
 * approach.
 */

export interface CiConcurrencyResult {
  ok: boolean;
  /** Human-readable description of each violated guard, empty when ok. */
  problems: string[];
}

export function checkCiConcurrency(repoDir = defaultRepoRoot): CiConcurrencyResult {
  const workflowPath = path.join(repoDir, '.github', 'workflows', 'ci.yml');
  const workflow = readFileSync(workflowPath, 'utf-8');
  const problems: string[] = [];

  const concurrency = extractTopLevelConcurrencyBlock(workflow);
  if (!concurrency) {
    problems.push(
      'missing top-level `concurrency:` block — superseded pull-request runs will never be cancelled',
    );
  } else {
    problems.push(...checkGroupExpression(concurrency));
    problems.push(...checkCancelInProgress(concurrency));
  }

  problems.push(...checkAggregatorCancelledGuard(workflow));

  return { ok: problems.length === 0, problems };
}

export function formatCiConcurrency(result: CiConcurrencyResult): string {
  if (result.ok) {
    return 'ci-concurrency: ok (PR-scoped cancellation, non-PR isolation, aggregator cancelled-guard present)';
  }

  const lines = [
    'ci-concurrency: CI workflow concurrency contract violated:',
    ...result.problems.map((problem, index) => `${index + 1}. ${problem}`),
    '',
    'The concurrency policy in .github/workflows/ci.yml must cancel superseded',
    'pull-request runs (grouped by PR number) while keeping protected-branch,',
    'scheduled, and manual runs fully isolated. See docs/ci-concurrency.md.',
  ];
  return lines.join('\n');
}

/**
 * Returns the body of the top-level (column-0) `concurrency:` block, or null.
 * Job-level `concurrency:` keys are indented and intentionally not matched.
 */
function extractTopLevelConcurrencyBlock(workflow: string): string | null {
  const match = workflow.match(/^concurrency:[ \t]*\n((?:[ \t]+\S.*\n?|[ \t]*\n)*)/m);
  return match ? match[1] : null;
}

function checkGroupExpression(concurrencyBlock: string): string[] {
  const problems: string[] = [];
  const group = concurrencyBlock.match(/^[ \t]+group:[ \t]*(.+?)[ \t]*$/m)?.[1];

  if (!group) {
    problems.push('concurrency block has no `group:` key — runs would all share the default group');
    return problems;
  }

  if (!group.includes('github.event.pull_request.number')) {
    problems.push(
      'concurrency group does not reference `github.event.pull_request.number` — '
      + 'pull-request runs are not grouped per PR, so a new push cannot cancel only its own superseded run',
    );
  }

  if (!group.includes('github.run_id')) {
    problems.push(
      'concurrency group\'s non-PR branch does not isolate by `github.run_id` — '
      + 'protected-branch, scheduled, or manual runs could share a group and cancel or queue behind each other',
    );
  }

  if (!/github\.event_name\s*==\s*'pull_request'/.test(group)) {
    problems.push(
      'concurrency group is not conditioned on `github.event_name == \'pull_request\'` — '
      + 'PR and non-PR runs are not kept in distinct groups',
    );
  }

  return problems;
}

function checkCancelInProgress(concurrencyBlock: string): string[] {
  const cancel = concurrencyBlock.match(/^[ \t]+cancel-in-progress:[ \t]*(.+?)[ \t]*$/m)?.[1];

  if (!cancel) {
    return [
      'concurrency block has no `cancel-in-progress:` key — superseded pull-request runs would only queue, never cancel',
    ];
  }

  if (/^(['"]?)(true|false)\1$/i.test(cancel)) {
    return [
      `\`cancel-in-progress: ${cancel}\` is a bare literal — it must be an expression scoped to pull_request events `
      + '(a literal `true` would cancel protected-branch, scheduled, and manual runs; a literal `false` would never cancel superseded PR runs)',
    ];
  }

  if (!/github\.event_name\s*==\s*'pull_request'/.test(cancel)) {
    return [
      '`cancel-in-progress` is not conditioned on `github.event_name == \'pull_request\'` — '
      + 'cancellation must apply to pull-request events only',
    ];
  }

  return [];
}

/**
 * The aggregator job named "Shell and Unit Tests" must keep failing when any
 * needed job was cancelled; otherwise a cancelled current-head dependency
 * could report the required check green (REQ-F5).
 */
function checkAggregatorCancelledGuard(workflow: string): string[] {
  const aggregatorBlock = extractJobBlockByName(workflow, 'Shell and Unit Tests');
  if (!aggregatorBlock) {
    return [
      'aggregator job named "Shell and Unit Tests" not found — the required status check is missing from the workflow',
    ];
  }

  if (!/contains\(needs\.\*\.result,\s*'cancelled'\)/.test(aggregatorBlock)) {
    return [
      'aggregator "Shell and Unit Tests" no longer fails on `contains(needs.*.result, \'cancelled\')` — '
      + 'a cancelled current-head dependency could report the required check green',
    ];
  }

  return [];
}

function extractJobBlockByName(workflow: string, jobName: string): string | null {
  const jobsBlock = workflow.match(/^jobs:\n(?<body>[\s\S]*)$/m)?.groups?.body;
  if (!jobsBlock) {
    return null;
  }

  const jobMatches = [...jobsBlock.matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)];
  for (let index = 0; index < jobMatches.length; index += 1) {
    const start = (jobMatches[index].index ?? 0) + jobMatches[index][0].length;
    const end = index + 1 < jobMatches.length ? jobMatches[index + 1].index ?? jobsBlock.length : jobsBlock.length;
    const block = jobsBlock.slice(start, end);
    const name = block.match(/^    name:\s*(.+?)\s*$/m)?.[1]?.replace(/^['"]|['"]$/g, '');
    if (name === jobName) {
      return block;
    }
  }
  return null;
}

if (process.argv[1] === __filename) {
  const result = checkCiConcurrency(process.argv[2] ?? defaultRepoRoot);
  const message = formatCiConcurrency(result);
  if (!result.ok) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
}
