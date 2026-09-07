#!/usr/bin/env -S npx tsx

// Arbiter R4 recon instrument (HOK-2791). Its observable behaviour is frozen:
// the checked-in docs/arbiter/attribution-coverage-* artifacts were produced by
// this tool. The signature vocabulary and GitHub fetch path now live in
// shared/lib (single source of truth for the P2.6 attribution engine); a golden
// parity test asserts the projected DETECTOR_SIGNATURES lists are unchanged.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTool, type ParsedArgs } from '../shared/lib/tool-runner.ts';
import { legacyDetectorSignatures } from '../shared/lib/pr-attribution.ts';
import {
  assertGhAvailable,
  createDefaultFetcher,
  fetchMergedPulls,
  parseReposFileContent,
  validateRepoSlug,
  type Fetcher,
} from '../shared/lib/merged-pr-fetcher.ts';

export {
  parseGitHubCommitMessages,
  parseGitHubPullRequest,
  parseReposFileContent,
  validateRepoSlug,
} from '../shared/lib/merged-pr-fetcher.ts';

export type AttributionSignal =
  | 'botAuthor'
  | 'coAuthoredBy'
  | 'branchPrefix'
  | 'label'
  | 'commitSignature';

export interface PullRequestInput {
  number: number;
  title?: string;
  authorLogin: string | null;
  authorType: string | null;
  headRef: string | null;
  labels: string[];
  mergedAt: string;
  commitMessages: string[];
}

export interface SignalEvidence {
  pr: number;
  signal: AttributionSignal;
  value: string;
  rule: string;
}

export interface AttributedPullRequest {
  number: number;
  signals: AttributionSignal[];
  evidence: SignalEvidence[];
}

export interface AttributionSummary {
  repo: string;
  sampledMergedPrs: number;
  signalCounts: Record<AttributionSignal, number>;
  unionCount: number;
  unattributedCount: number;
  coverage: Record<AttributionSignal | 'union' | 'unattributed', number>;
  pullRequests: AttributedPullRequest[];
}

const SIGNALS: AttributionSignal[] = [
  'botAuthor',
  'coAuthoredBy',
  'branchPrefix',
  'label',
  'commitSignature',
];

export const DETECTOR_SIGNATURES = legacyDetectorSignatures();

const options = {
  repo: { type: 'string', description: 'Repository slug owner/name', multiple: true },
  'repos-file': { type: 'string', description: 'Text or JSON file containing repository slugs' },
  limit: { type: 'string', description: 'Merged PR sample size per repository', default: '50' },
  output: { type: 'string', description: 'Write combined JSON report to this path' },
  json: { type: 'boolean', description: 'Print combined JSON report to stdout' },
} as const;

type CliArgs = ParsedArgs<typeof options>;

function normalized(value: string): string {
  return value.toLocaleLowerCase().trim();
}

function pct(count: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Number(((count / denominator) * 100).toFixed(1));
}

function addEvidence(
  evidenceBySignal: Map<AttributionSignal, SignalEvidence>,
  signal: AttributionSignal,
  pr: number,
  value: string,
  rule: string,
): void {
  if (!evidenceBySignal.has(signal)) {
    evidenceBySignal.set(signal, { pr, signal, value, rule });
  }
}

function extractCoAuthorTrailers(message: string): string[] {
  const trailers: string[] = [];
  for (const line of message.split(/\r?\n/)) {
    const match = line.match(/^Co-authored-by:\s*(.+)$/i);
    if (match) {
      trailers.push(match[1].trim());
    }
  }
  return trailers;
}

export function analyzePullRequest(pr: PullRequestInput): AttributedPullRequest {
  const evidenceBySignal = new Map<AttributionSignal, SignalEvidence>();
  const authorLogin = pr.authorLogin ? normalized(pr.authorLogin) : '';
  const authorType = pr.authorType ? normalized(pr.authorType) : '';

  if (authorLogin && DETECTOR_SIGNATURES.botLogins.includes(authorLogin)) {
    addEvidence(evidenceBySignal, 'botAuthor', pr.number, pr.authorLogin ?? '', 'known-agent-bot-login');
  } else if (authorType === 'bot') {
    const stripped = authorLogin.replace(/\[bot\]$/, '');
    if (DETECTOR_SIGNATURES.botLogins.includes(stripped)) {
      addEvidence(evidenceBySignal, 'botAuthor', pr.number, pr.authorLogin ?? '', 'known-agent-bot-type-login');
    }
  }

  for (const message of pr.commitMessages) {
    for (const trailer of extractCoAuthorTrailers(message)) {
      const trailerText = normalized(trailer);
      const matched = DETECTOR_SIGNATURES.coAuthorFragments.find((fragment) => trailerText.includes(fragment));
      if (matched) {
        addEvidence(evidenceBySignal, 'coAuthoredBy', pr.number, trailer, `co-author-fragment:${matched}`);
      }
    }
  }

  if (pr.headRef) {
    const headRef = normalized(pr.headRef);
    const matched = DETECTOR_SIGNATURES.branchPrefixes.find((prefix) => headRef.startsWith(prefix));
    if (matched) {
      addEvidence(evidenceBySignal, 'branchPrefix', pr.number, pr.headRef, `branch-prefix:${matched}`);
    }
  }

  for (const label of pr.labels) {
    const labelName = normalized(label);
    const matched = DETECTOR_SIGNATURES.labelNames.find((candidate) => labelName === candidate);
    if (matched) {
      addEvidence(evidenceBySignal, 'label', pr.number, label, `label:${matched}`);
    }
  }

  for (const message of pr.commitMessages) {
    const messageText = normalized(message);
    const matched = DETECTOR_SIGNATURES.commitSignatureFragments.find((fragment) => messageText.includes(fragment));
    if (matched) {
      addEvidence(evidenceBySignal, 'commitSignature', pr.number, matched, `commit-signature:${matched}`);
    }
  }

  const evidence = [...evidenceBySignal.values()];
  return {
    number: pr.number,
    signals: evidence.map((item) => item.signal),
    evidence,
  };
}

export function summarizeAttribution(repo: string, prs: PullRequestInput[]): AttributionSummary {
  const pullRequests = prs.map(analyzePullRequest);
  const signalCounts = Object.fromEntries(SIGNALS.map((signal) => [signal, 0])) as Record<AttributionSignal, number>;

  for (const pr of pullRequests) {
    for (const signal of pr.signals) {
      signalCounts[signal] += 1;
    }
  }

  const unionCount = pullRequests.filter((pr) => pr.signals.length > 0).length;
  const unattributedCount = prs.length - unionCount;
  const coverage = Object.fromEntries([
    ...SIGNALS.map((signal) => [signal, pct(signalCounts[signal], prs.length)]),
    ['union', pct(unionCount, prs.length)],
    ['unattributed', pct(unattributedCount, prs.length)],
  ]) as Record<AttributionSignal | 'union' | 'unattributed', number>;

  return {
    repo,
    sampledMergedPrs: prs.length,
    signalCounts,
    unionCount,
    unattributedCount,
    coverage,
    pullRequests,
  };
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

export interface MultiRepoAttributionReport {
  schemaVersion: 1;
  generatedAt: string;
  sampleLimit: number;
  detectorSignatures: typeof DETECTOR_SIGNATURES;
  repositories: AttributionSummary[];
}

export async function measureRepositories(
  repos: string[],
  limit: number,
  fetcher: Fetcher = createDefaultFetcher(),
  now: () => Date = () => new Date(),
): Promise<MultiRepoAttributionReport> {
  await assertGhAvailable(fetcher);

  const repositories: AttributionSummary[] = [];
  for (const repo of repos) {
    const prs = await fetchMergedPulls(repo, limit, fetcher);
    repositories.push(summarizeAttribution(repo, prs));
  }

  return {
    schemaVersion: 1,
    generatedAt: now().toISOString(),
    sampleLimit: limit,
    detectorSignatures: DETECTOR_SIGNATURES,
    repositories,
  };
}

function renderHuman(report: MultiRepoAttributionReport): void {
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Sample limit per repo: ${report.sampleLimit}`);
  console.log('');
  console.log([
    'repo',
    'n',
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
      `${repo.signalCounts.botAuthor} (${repo.coverage.botAuthor}%)`,
      `${repo.signalCounts.coAuthoredBy} (${repo.coverage.coAuthoredBy}%)`,
      `${repo.signalCounts.branchPrefix} (${repo.coverage.branchPrefix}%)`,
      `${repo.signalCounts.label} (${repo.coverage.label}%)`,
      `${repo.signalCounts.commitSignature} (${repo.coverage.commitSignature}%)`,
      `${repo.unionCount} (${repo.coverage.union}%)`,
      `${repo.unattributedCount} (${repo.coverage.unattributed}%)`,
    ].join('\t'));
  }
}

export async function runMeasureRepoAttributionCommand(args: CliArgs): Promise<number> {
  const repos = await resolveRepos(args);
  const limit = parseLimit(args.limit);
  const report = await measureRepositories(repos, limit);

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
    description: 'Measure observable agent/model attribution coverage in merged GitHub pull requests',
    options,
    examples: [
      'npx tsx tools/measure-repo-attribution.ts --repo owner/name --limit 50',
      'npx tsx tools/measure-repo-attribution.ts --repos-file repos.txt --output docs/arbiter/attribution-coverage-results.json',
      'npx tsx tools/measure-repo-attribution.ts --repo owner/name --json',
    ],
    async run({ args }) {
      const code = await runMeasureRepoAttributionCommand(args);
      if (code !== 0) {
        process.exit(code);
      }
    },
  });
}
