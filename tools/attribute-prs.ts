#!/usr/bin/env -S npx tsx

// Arbiter P2.6 scan step (HOK-2808): three-dimension agent/harness/model
// attribution over merged PRs. Thin wrapper - business logic lives in
// shared/lib/pr-attribution.ts. Runs with no wavemill state (gh + inputs only);
// low coverage is a reported result, never an error.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool, type ParsedArgs } from '../shared/lib/tool-runner.ts';
import { errorMessage } from '../shared/lib/error-utils.ts';
import {
  assertGhAvailable,
  createDefaultFetcher,
  fetchMergedPulls,
  parseReposFileContent,
  validateRepoSlug,
  type Fetcher,
} from '../shared/lib/merged-pr-fetcher.ts';
import {
  buildAttributionReport,
  resolveAttributionConfig,
  sampleForPrecisionAudit,
  summarizeRepoAttribution,
  type AttributionReport,
  type GateResult,
  type RepoAttributionSummary,
} from '../shared/lib/pr-attribution.ts';

const options = {
  repo: { type: 'string', description: 'Repository slug owner/name', multiple: true },
  'repos-file': { type: 'string', description: 'Text or JSON file containing repository slugs' },
  limit: { type: 'string', description: 'Merged PR sample size per repository', default: '50' },
  config: { type: 'string', description: 'Standalone attribution config JSON file' },
  output: { type: 'string', description: 'Write JSON report to this path' },
  json: { type: 'boolean', description: 'Print JSON report to stdout' },
  'audit-sample': { type: 'string', description: 'Deterministic precision-audit sample size per repository' },
  'audit-seed': { type: 'string', description: 'Seed for the precision-audit sample', default: '1' },
} as const;

type CliArgs = ParsedArgs<typeof options>;

interface AuditSample {
  repo: string;
  seed: number;
  prNumbers: number[];
}

export interface AttributePrsReport extends AttributionReport {
  auditSamples?: AuditSample[];
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

function parsePositiveInt(raw: string | undefined, flag: string, max: number, fallback: number): number {
  const value = Number.parseInt(raw ?? String(fallback), 10);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`Invalid ${flag} value: ${raw ?? ''}; expected an integer from 1 to ${max}`);
  }
  return value;
}

async function loadRawConfig(path: string | undefined): Promise<unknown> {
  if (!path) return undefined;
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read attribution config ${path}: ${errorMessage(err)}`);
  }
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`Attribution config ${path} is not valid JSON: ${errorMessage(err)}`);
  }
}

function pct(count: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Number(((count / denominator) * 100).toFixed(1));
}

function gateLine(name: string, gate: GateResult): string {
  return gate.render
    ? `  ${name}: RENDER (coverage ${gate.coverage}%)`
    : `  ${name}: SUPPRESS (${gate.reason ?? 'no reason recorded'})`;
}

function renderHuman(report: AttributePrsReport): void {
  console.log(`Generated: ${report.generatedAt}`);
  console.log('');
  console.log(['repo', 'n', 'agent', 'harness', 'model', 'unattributed'].join('\t'));
  for (const repo of report.repositories) {
    console.log([
      repo.repo,
      repo.sampledMergedPrs,
      `${repo.dimensions.agent.identifiedCount} (${repo.dimensions.agent.coveragePercent}%)`,
      `${repo.dimensions.harness.identifiedCount} (${repo.dimensions.harness.coveragePercent}%)`,
      `${repo.dimensions.model.identifiedCount} (${repo.dimensions.model.coveragePercent}%)`,
      `${repo.unattributedCount} (${pct(repo.unattributedCount, repo.eligiblePrCount)}%)`,
    ].join('\t'));
  }
  console.log('');
  console.log(
    `Aggregate (macro/micro): agent ${report.aggregate.dimensionCoverage.agent.macroPercent}%/${report.aggregate.dimensionCoverage.agent.microPercent}%, ` +
      `harness ${report.aggregate.dimensionCoverage.harness.macroPercent}%/${report.aggregate.dimensionCoverage.harness.microPercent}%, ` +
      `model ${report.aggregate.dimensionCoverage.model.macroPercent}%/${report.aggregate.dimensionCoverage.model.microPercent}%`,
  );
  console.log(
    `Feasibility: ${report.aggregate.eligibleRepoCount}/${report.aggregate.repoCount} repos eligible (>=${report.config.minEligiblePrs} eligible PRs)`,
  );
  console.log('Report gates (pooled over eligible repos):');
  console.log(gateLine('survival-by-model', report.gates.survivalByModel));
  console.log(gateLine('survival-by-harness', report.gates.survivalByHarness));
  for (const sample of report.auditSamples ?? []) {
    console.log('');
    console.log(
      `Precision-audit sample for ${sample.repo} (seed ${sample.seed}): ` +
        (sample.prNumbers.length > 0 ? sample.prNumbers.map((n) => `#${n}`).join(', ') : '(no attributed PRs)'),
    );
  }
}

export async function runAttributePrsCommand(
  args: CliArgs,
  fetcher: Fetcher = createDefaultFetcher(),
  now: () => Date = () => new Date(),
): Promise<number> {
  const repos = await resolveRepos(args);
  const limit = parsePositiveInt(args.limit, '--limit', 200, 50);
  const rawConfig = await loadRawConfig(args.config);
  const fileConfig = resolveAttributionConfig(rawConfig);

  await assertGhAvailable(fetcher);

  const repositories: RepoAttributionSummary[] = [];
  for (const repo of repos) {
    const repoConfig = resolveAttributionConfig(rawConfig, repo);
    const prs = await fetchMergedPulls(repo, limit, fetcher);
    repositories.push(summarizeRepoAttribution(repo, prs, repoConfig));
  }

  const report: AttributePrsReport = buildAttributionReport(repositories, fileConfig, now());
  if (args['audit-sample']) {
    const size = parsePositiveInt(args['audit-sample'], '--audit-sample', 1000, 25);
    const seed = parsePositiveInt(args['audit-seed'], '--audit-seed', 2 ** 31, 1);
    report.auditSamples = repositories.map((summary) => ({
      repo: summary.repo,
      seed,
      prNumbers: sampleForPrecisionAudit(summary.pullRequests, size, seed).map((pr) => pr.number),
    }));
  }

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
    name: 'attribute-prs',
    description: 'Attribute merged PRs to agent, harness and exact model with per-repo coverage and report gates',
    options,
    examples: [
      'npx tsx tools/attribute-prs.ts --repo owner/name --limit 50',
      'npx tsx tools/attribute-prs.ts --repos-file repos.txt --config attribution.json --output report.json',
      'npx tsx tools/attribute-prs.ts --repo owner/name --json --audit-sample 25 --audit-seed 7',
    ],
    async run({ args }) {
      const code = await runAttributePrsCommand(args);
      if (code !== 0) {
        process.exit(code);
      }
    },
  });
}
