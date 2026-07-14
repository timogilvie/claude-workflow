#!/usr/bin/env -S npx tsx

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { runReviewFlow } from '../shared/lib/native-agent/workflow-tools/review-flow.ts';
import type {
  WorkflowToolStageArtifactEntry,
  WorkflowToolTranscriptEvent,
  LinearClient,
} from '../shared/lib/native-agent/workflow-tools/linear-tools.ts';
import { DEFAULT_NETWORK_POLICY, type NetworkPolicy } from '../shared/lib/native-agent/network-policy.ts';
import { resolveOwnerRepo } from '../shared/lib/github.ts';
import { createComment, getIssue, updateComment } from '../shared/lib/linear.ts';

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function appendJsonLine(path: string, payload: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(payload)}\n`, 'utf-8');
}

function readLinearIdentifier(session: string, issue: string): string {
  const issuePath = `/tmp/${session}-${issue}-issue.json`;
  if (!existsSync(issuePath)) {
    return issue.replace(/_c$/, '');
  }

  try {
    const parsed = JSON.parse(readFileSync(issuePath, 'utf-8')) as { identifier?: string };
    return parsed.identifier?.trim() || issue.replace(/_c$/, '');
  } catch {
    return issue.replace(/_c$/, '');
  }
}

function buildPrBody(input: {
  issue: string;
  title: string;
  reviewerModel: string;
  baseBranch: string;
  headBranch: string;
}): string {
  return [
    '## Summary',
    '',
    `- ${input.title}`,
    `- Native review flow executed for ${input.issue} using ${input.reviewerModel || 'the configured native reviewer'}.`,
    '',
    '## Changes',
    '',
    `- Branch: \`${input.headBranch}\``,
    `- Base: \`${input.baseBranch}\``,
    '',
    '## Test plan',
    '',
    '- Native review flow ran `review_changes` and attached the structured findings below.',
    '',
    '<!-- wavemill-meta',
    `task: ${input.issue}`,
    '-->',
  ].join('\n');
}

async function main(): Promise<void> {
  const session = readOption('session') ?? process.env.WAVEMILL_SESSION ?? '';
  const issue = readOption('issue') ?? process.env.WAVEMILL_ISSUE ?? '';
  const slug = readOption('slug') ?? process.env.WAVEMILL_FEATURE_SLUG ?? process.env.WAVEMILL_SLUG ?? '';
  const wtDir = resolve(readOption('wt-dir') ?? process.env.WAVEMILL_WT_DIR ?? process.cwd());
  const repoDir = resolve(readOption('repo-dir') ?? process.env.WAVEMILL_REPO_DIR ?? process.cwd());
  const featureDir = resolve(readOption('feature-dir') ?? join(wtDir, 'features', slug));
  const title = readOption('title') ?? process.env.WAVEMILL_TITLE ?? issue;
  const baseBranch = readOption('base-branch') ?? process.env.WAVEMILL_BASE_BRANCH ?? 'main';
  const reviewerModel = process.env.WAVEMILL_RESOLVED_MODEL ?? '';

  if (!session || !issue || !slug) {
    throw new Error('session, issue, and slug are required');
  }

  const repo = resolveOwnerRepo(wtDir);
  if (!repo) {
    throw new Error(`could not resolve GitHub owner/repo from ${wtDir}`);
  }

  const headBranch = readOption('branch') ?? process.env.WAVEMILL_BRANCH ?? git(['rev-parse', '--abbrev-ref', 'HEAD'], wtDir);
  const headSha = git(['rev-parse', 'HEAD'], wtDir);
  const prTitle = title.includes(issue) ? title : `${issue}: ${title}`;
  const linearIssue = readLinearIdentifier(session, issue);
  const workflowLogPath = join(featureDir, '.native-review-workflow.jsonl');

  const transcript = {
    append(event: WorkflowToolTranscriptEvent) {
      appendJsonLine(workflowLogPath, { kind: 'transcript', ...event });
    },
  };
  const stageArtifact = {
    append(entry: WorkflowToolStageArtifactEntry) {
      appendJsonLine(workflowLogPath, { kind: 'stage-artifact', ...entry });
    },
  };
  const linearClient: LinearClient = {
    async getIssue(identifier) {
      return await getIssue(identifier === issue ? linearIssue : identifier);
    },
    async createComment(issueId, body) {
      return await createComment(issueId, body);
    },
    async updateComment(commentId, body) {
      return await updateComment(commentId, body);
    },
  };
  const networkPolicy: NetworkPolicy = {
    ...DEFAULT_NETWORK_POLICY,
    review: {
      ...DEFAULT_NETWORK_POLICY.review,
      review_changes: { kind: 'allow' },
    },
  };

  const result = await runReviewFlow({
    issueId: issue,
    featureDir,
    repo,
    base: baseBranch,
    head: headBranch,
    headSha,
    title: prTitle,
    body: buildPrBody({
      issue,
      title,
      reviewerModel,
      baseBranch,
      headBranch,
    }),
    labels: ['wavemill'],
    sessionId: session,
    phase: 'review',
    transcript,
    stageArtifact,
    linearClient,
    networkPolicy,
  });

  if (!result.ok) {
    throw new Error(result.warnings.join('; ') || 'native review flow failed');
  }

  appendJsonLine(workflowLogPath, {
    kind: 'summary',
    haltedBeforeMerge: result.haltedBeforeMerge,
    merged: result.merged,
    warningCount: result.warnings.length,
  });

  if (linearIssue !== issue) {
    appendJsonLine(workflowLogPath, {
      kind: 'linear-issue-alias',
      issue,
      linearIssue,
    });
  }
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
