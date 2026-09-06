#!/usr/bin/env -S npx tsx

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runTool, type ParsedArgs } from '../shared/lib/tool-runner.ts';
import { errorMessage } from '../shared/lib/error-utils.ts';
import {
  type AttributionSignal,
  type PullRequestInput,
  type SignalEvidence,
  type AttributedPullRequest,
  type AttributionSummary,
  attributePullRequest,
  DETECTOR_SIGNATURES,
  SIGNAL_ORDER,
  pct,
  extractCoAuthorTrailers,
  validateRepoSlug,
  analyzePullRequest,
  summarizeAttribution,
  parseGitHubPullRequest,
  parseGitHubCommitMessages,
  parseReposFileContent,
} from '../shared/lib/pr-attribution.ts';
import {
  type AttributionConfigFile,
  type AuditData,
  type MultiRepoAttributionReport,
  type RepositoryAttributionReport,
  DEFAULT_ATTRIBUTION_CONFIG,
  loadConfig,
  computeRepositoryReport,
  computeAggregates,
} from '../shared/lib/attribution-coverage.ts';

const execFileAsync = promisify(execFile);

interface GitHubPullRequest {
  number: unknown;
  title?: unknown;
  user?: { login?: unknown; type?: unknown } | null;
  head?: { ref?: unknown; sha?: unknown } | null;
  labels?: Array<{ name?: unknown }> | null;
  merged_at?: unknown;
  body?: unknown;
}

interface GitHubCommit {
  commit?: { message?: unknown } | null;
}

interface Fetcher {
  gh(args: string[]): Promise<string>;
}

const options = {
  repo: { type: 'string', description: 'Repository slug owner/name', multiple: true },
  'repos-file': { type: 'string', description: 'Text or JSON file containing repository slugs' },
  limit: { type: 'string', description: 'Merged PR sample size per repository', default: '50' },
  output: { type: 'string', description: 'Write combined JSON report to this path' },
  json: { type: 'boolean', description: 'Print combined JSON report to stdout' },
  'attribution-config': { type: 'string', description: 'JSON config file for attribution settings (defaults, per-repo floors)' },
  audit: { type: 'string', description: 'JSON file with manual audit data for precision measurement' },
} as const;

type CliArgs = ParsedArgs<typeof options>;

// Re-export for backward compatibility with existing imports
export {
  type AttributionSignal,
  type PullRequestInput,
  type SignalEvidence,
  type AttributedPullRequest,
  type AttributionSummary,
  DETECTOR_SIGNATURES,
  extractCoAuthorTrailers,
  validateRepoSlug,
  analyzePullRequest,
  summarizeAttribution,
  parseGitHubPullRequest,
  parseGitHubCommitMessages,
  parseReposFileContent,
  attributePullRequest,
} from '../shared/lib/pr-attribution.ts';

// Re-export v2 schema types and functions
export {
  type MultiRepoAttributionReport,
  type RepositoryAttributionReport,
  type AttributionConfigFile,
  type AuditData,
} from '../shared/lib/attribution-coverage.ts';

async function defaultGh(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      maxBuffer: 1024 * 1024 * 32,
    });
    return stdout;
  } catch (err) {
    throw new Error(`gh ${args.join(' ')} failed: ${errorMessage(err)}`);
  }
}

async function fetchJson(fetcher: Fetcher, args: string[]): Promise<unknown> {
  const stdout = await fetcher.gh(args);
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Malformed gh JSON response for "${args.join(' ')}": ${errorMessage(err)}`);
  }
}

async function assertGhAvailable(fetcher: Fetcher): Promise<void> {
  await fetcher.gh(['auth', 'status']);
}

async function fetchMergedPulls(repo: string, limit: number, fetcher: Fetcher): Promise<PullRequestInput[]> {
  const collected: PullRequestInput[] = [];

  for (let page = 1; collected.length < limit; page += 1) {
    const rawPulls = await fetchJson(fetcher, [
      'api',
      `repos/${repo}/pulls`,
      '--method',
      'GET',
      '-f',
      'state=closed',
      '-f',
      'sort=updated',
      '-f',
      'direction=desc',
      '-f',
      'per_page=100',
      '-f',
      `page=${String(page)}`,
    ]);
    if (!Array.isArray(rawPulls)) {
      throw new Error(`Malformed pull request response for ${repo}: expected array`);
    }

    const mergedPulls = rawPulls.filter((raw) => {
      const pr = raw as GitHubPullRequest;
      return typeof pr.merged_at === 'string' && pr.merged_at.length > 0;
    });

    for (const raw of mergedPulls) {
      if (collected.length >= limit) break;
      const prNumber = (raw as GitHubPullRequest).number;
      if (typeof prNumber !== 'number') {
        throw new Error(`Malformed pull request response for ${repo}: missing numeric number`);
      }
      const commitMessages = await fetchPullRequestCommitMessages(repo, prNumber, fetcher);
      collected.push(parseGitHubPullRequest(raw, commitMessages));
    }

    if (rawPulls.length < 100) break;
  }

  return collected;
}

async function fetchPullRequestCommitMessages(repo: string, prNumber: number, fetcher: Fetcher): Promise<string[]> {
  const messages: string[] = [];

  for (let page = 1; ; page += 1) {
    const rawCommits = await fetchJson(fetcher, [
      'api',
      `repos/${repo}/pulls/${String(prNumber)}/commits`,
      '--method',
      'GET',
      '-f',
      'per_page=100',
      '-f',
      `page=${String(page)}`,
    ]);
    const pageMessages = parseGitHubCommitMessages(rawCommits, prNumber);
    messages.push(...pageMessages);
    if (pageMessages.length < 100) break;
  }

  return messages;
}

async function resolveRepos(args: CliArgs): Promise<string[]> {
  const repos = [...(args.repo ?? [])].map(validateRepoSlug);
  if (args['repos-file']) {
    repos.push(...parseReposFileContent(await readFile(args['repos-file'], 'utf-8')));
  }
  const deduped = [...new Set(repos)];
  if (deduped.length === 0) {
    throw new Error('Provide at least one --repo or --repos-file entry');
  }
  return deduped;
}

function parseLimit(raw: string | undefined): number {
  const limit = Number.parseInt(raw ?? '50', 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error(`Invalid --limit value: ${raw ?? ''}; expected an integer from 1 to 200`);
  }
  return limit;
}

async function loadConfigFile(path: string | undefined): Promise<AttributionConfigFile | undefined> {
  if (!path) return undefined;
  try {
    const content = await readFile(path, 'utf-8');
    const parsed = JSON.parse(content);
    // Validate that it has the expected structure
    if (typeof parsed !== 'object') {
      throw new Error('Configuration file must be a JSON object');
    }
    return parsed as AttributionConfigFile;
  } catch (err) {
    throw new Error(`Failed to load attribution config from ${path}: ${errorMessage(err)}`);
  }
}

async function loadAuditFile(path: string | undefined): Promise<AuditData | undefined> {
  if (!path) return undefined;
  try {
    const content = await readFile(path, 'utf-8');
    const parsed = JSON.parse(content);
    // Validate structure
    if (typeof parsed !== 'object') {
      throw new Error('Audit file must be a JSON object');
    }
    return parsed as AuditData;
  } catch (err) {
    throw new Error(`Failed to load audit data from ${path}: ${errorMessage(err)}`);
  }
}

export async function measureRepositories(
  repos: string[],
  limit: number,
  fetcher: Fetcher = { gh: defaultGh },
  now: () => Date = () => new Date(),
  configFile?: AttributionConfigFile,
  auditData?: AuditData,
): Promise<MultiRepoAttributionReport> {
  await assertGhAvailable(fetcher);

  const repositories: RepositoryAttributionReport[] = [];
  const configByRepo: Record<string, unknown> = {};

  for (const repo of repos) {
    const prs = await fetchMergedPulls(repo, limit, fetcher);
    const config = loadConfig(configFile, repo);
    configByRepo[repo] = config;

    // Convert to three-dimension PRs using attributePullRequest
    const attributedPrs = prs.map((pr) => attributePullRequest(pr, new Set(config.disabledSignals)));

    // Compute repository report with new structure
    repositories.push(computeRepositoryReport(repo, attributedPrs, config));
  }

  // Compute aggregates
  const aggregate = computeAggregates(repositories, auditData);

  return {
    schemaVersion: 2,
    generatedAt: now().toISOString(),
    sampleLimit: limit,
    detectorSignatures: DETECTOR_SIGNATURES,
    config: configByRepo,
    repositories,
    aggregate,
  };
}

function renderHuman(report: MultiRepoAttributionReport): void {
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Sample limit per repo: ${report.sampleLimit}`);
  console.log(`Schema version: ${report.schemaVersion}`);
  console.log('');

  // Signal-level coverage table
  console.log('=== Signal Coverage ===');
  console.log([
    'repo',
    'n',
    'first-party',
    'bot',
    'coauthor',
    'branch',
    'label',
    'commit',
    'union',
    'unattributed',
  ].join('\t'));
  for (const repo of report.repositories) {
    console.log([
      repo.repo,
      repo.sampledMergedPrs,
      `${repo.signalCounts.firstPartyRoute ?? 0} (${repo.coverage.firstPartyRoute ?? 0}%)`,
      `${repo.signalCounts.botAuthor} (${repo.coverage.botAuthor}%)`,
      `${repo.signalCounts.coAuthoredBy} (${repo.coverage.coAuthoredBy}%)`,
      `${repo.signalCounts.branchPrefix} (${repo.coverage.branchPrefix}%)`,
      `${repo.signalCounts.label} (${repo.coverage.label}%)`,
      `${repo.signalCounts.commitSignature} (${repo.coverage.commitSignature}%)`,
      `${repo.coverage.union}%`,
      `${repo.coverage.unattributed}%`,
    ].join('\t'));
  }

  // Dimension coverage table
  console.log('');
  console.log('=== Dimension Coverage ===');
  console.log([
    'repo',
    'eligible',
    'agentAuth%',
    'harness%',
    'model%',
    'agentOrHarness%',
    'survivalByModel',
    'survivalByHarness',
  ].join('\t'));
  for (const repo of report.repositories) {
    console.log([
      repo.repo,
      repo.eligible ? 'yes' : `no(${repo.eligibilityReason})`,
      `${repo.dimensionCoverage.agentAuthored.coverage}%`,
      `${repo.dimensionCoverage.harness.coverage}%`,
      `${repo.dimensionCoverage.model.coverage}%`,
      `${repo.dimensionCoverage.agentOrHarness.coverage}%`,
      repo.sections.survivalByModel.render ? `yes(${repo.sections.survivalByModel.reason})` : `no(${repo.sections.survivalByModel.reason})`,
      repo.sections.survivalByHarness.render ? `yes(${repo.sections.survivalByHarness.reason})` : `no(${repo.sections.survivalByHarness.reason})`,
    ].join('\t'));
  }

  // Aggregate summary
  console.log('');
  console.log('=== Aggregate Coverage ===');
  console.log(`Micro (pooled across all PRs):`);
  console.log(`  agentAuthored: ${report.aggregate.micro.agentAuthored.attributed}/${report.aggregate.micro.agentAuthored.total} = ${report.aggregate.micro.agentAuthored.coverage}%`);
  console.log(`  harness: ${report.aggregate.micro.harness.attributed}/${report.aggregate.micro.harness.total} = ${report.aggregate.micro.harness.coverage}%`);
  console.log(`  model: ${report.aggregate.micro.model.attributed}/${report.aggregate.micro.model.total} = ${report.aggregate.micro.model.coverage}%`);
  console.log(`  agentOrHarness: ${report.aggregate.micro.agentOrHarness.attributed}/${report.aggregate.micro.agentOrHarness.total} = ${report.aggregate.micro.agentOrHarness.coverage}%`);

  console.log(`Macro (mean of eligible repos):`);
  console.log(`  agentAuthored: ${report.aggregate.macro.agentAuthored.attributed}/${report.aggregate.macro.agentAuthored.total} = ${report.aggregate.macro.agentAuthored.coverage}%`);
  console.log(`  harness: ${report.aggregate.macro.harness.attributed}/${report.aggregate.macro.harness.total} = ${report.aggregate.macro.harness.coverage}%`);
  console.log(`  model: ${report.aggregate.macro.model.attributed}/${report.aggregate.macro.model.total} = ${report.aggregate.macro.model.coverage}%`);
  console.log(`  agentOrHarness: ${report.aggregate.macro.agentOrHarness.attributed}/${report.aggregate.macro.agentOrHarness.total} = ${report.aggregate.macro.agentOrHarness.coverage}%`);

  console.log(`Feasibility gate (eligible repos with agentOrHarness >= 60%):`);
  console.log(`  ${report.aggregate.feasibility.agentOrHarnessGate.passed}/${report.aggregate.feasibility.agentOrHarnessGate.total} = ${report.aggregate.feasibility.agentOrHarnessGate.percentage}%`);

  if (report.aggregate.precision.audited) {
    console.log(`Precision (manually audited):`);
    if (report.aggregate.precision.agentAuthored) {
      console.log(`  agentAuthored: ${report.aggregate.precision.agentAuthored.confirmed}/${report.aggregate.precision.agentAuthored.audited}`);
    }
    if (report.aggregate.precision.harness) {
      console.log(`  harness: ${report.aggregate.precision.harness.confirmed}/${report.aggregate.precision.harness.audited}`);
    }
    if (report.aggregate.precision.model) {
      console.log(`  model: ${report.aggregate.precision.model.confirmed}/${report.aggregate.precision.model.audited}`);
    }
  } else {
    console.log('Precision: not audited');
  }
}

export async function runMeasureRepoAttributionCommand(args: CliArgs): Promise<number> {
  const repos = await resolveRepos(args);
  const limit = parseLimit(args.limit);
  const configFile = await loadConfigFile(args['attribution-config']);
  const auditData = await loadAuditFile(args.audit);

  const report = await measureRepositories(repos, limit, { gh: defaultGh }, () => new Date(), configFile, auditData);

  if (args.output) {
    await mkdir(dirname(args.output), { recursive: true });
    await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    renderHuman(report);
    if (args.output) {
      console.log('');
      console.log(`Wrote ${args.output}`);
    }
  }

  return 0;
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runTool<typeof options>({
    name: 'measure-repo-attribution',
    description: 'Measure observable agent/model attribution coverage in merged GitHub pull requests (schema v2)',
    options,
    examples: [
      'npx tsx tools/measure-repo-attribution.ts --repo owner/name --limit 50',
      'npx tsx tools/measure-repo-attribution.ts --repos-file repos.txt --output results.json',
      'npx tsx tools/measure-repo-attribution.ts --repo owner/name --attribution-config config.json --audit audit.json --json',
    ],
    async run({ args }) {
      const code = await runMeasureRepoAttributionCommand(args);
      if (code !== 0) {
        process.exit(code);
      }
    },
  });
}
