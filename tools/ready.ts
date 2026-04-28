#!/usr/bin/env -S npx tsx

import { getIntegrationReadyPolicy } from '../shared/lib/config.ts';
import { getPullRequest } from '../shared/lib/github.ts';
import { getIssueCompletionState } from '../shared/lib/linear.ts';
import { evaluateReady, type ReadyVerdict } from '../shared/lib/ready-engine.ts';
import { runTool } from '../shared/lib/tool-runner.ts';
import { runReadyStage } from '../shared/lib/ready-stage.ts';
import { readChallengeComparisons } from '../shared/lib/challenge-comparison.ts';

runTool({
  name: 'ready',
  description: 'Check PR merge-readiness (CI, approvals, conflicts)',
  positional: {
    name: 'pr',
    description: 'PR number or URL',
  },
  options: {
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: current directory)',
    },
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON output',
    },
  },
  examples: [
    '# Check PR 42 in current repo',
    'npx tsx tools/ready.ts 42',
    '',
    '# Check PR from URL',
    'npx tsx tools/ready.ts https://github.com/org/repo/pull/42',
  ],
  async run({ positional, args }) {
    if (positional.length === 0) {
      throw new Error('PR number or URL required');
    }

    // Parse PR number from URL or direct number
    const prInput = positional[0];
    const prNumber = extractPrNumber(prInput);

    const repoDir = args['repo-dir'] || process.cwd();
    const readyPolicy = getIntegrationReadyPolicy(repoDir);
    let verdict: ReadyVerdict;

    if (readyPolicy.enabled) {
      const pr = getPullRequest(prNumber);
      verdict = await evaluateReady({
        pr: {
          number: pr.number,
          url: pr.url,
          baseBranch: pr.baseRefName,
          body: pr.body || '',
          labels: pr.labels.map((label) => label.name),
          mergedAt: pr.mergedAt,
        },
        config: {
          ...readyPolicy,
          integrationBranch: readyPolicy.integrationBranch || 'auto/integration',
        },
        async fetchPrState(dependencyPrNumber) {
          try {
            const dependencyPr = getPullRequest(dependencyPrNumber);
            const state = dependencyPr.mergedAt ? 'MERGED' : dependencyPr.state === 'OPEN' ? 'OPEN' : 'CLOSED';
            return { state, mergedAt: dependencyPr.mergedAt };
          } catch (error) {
            if ((error as Error).message.includes('not found')) {
              return null;
            }
            throw error;
          }
        },
        async fetchLinearIssueState(identifier) {
          try {
            const issue = await getIssueCompletionState(identifier);
            return { completedAt: issue.completedAt ?? null, canceledAt: issue.canceledAt ?? null };
          } catch (error) {
            if ((error as Error).message.includes('Issue not found')) {
              return null;
            }
            throw error;
          }
        },
        readChallengeComparisons,
      });
    } else {
      const result = await runReadyStage({ prNumber, repoDir });
      verdict = {
        status: result.verdict,
        reasons: result.summary ? [result.summary] : [],
        output: { labels: [], comment: '' },
      };
    }

    if (args.json) {
      console.log(JSON.stringify(verdict));
    } else {
      printHumanVerdict(prNumber, verdict);
    }

    if (verdict.status === 'fail') {
      process.exit(2);
    } else if (verdict.status === 'pending') {
      process.exit(1);
    }
  },
});

function extractPrNumber(input: string): number {
  // Try direct number first
  const num = parseInt(input, 10);
  if (!isNaN(num) && num > 0) {
    return num;
  }

  // Try GitHub PR URL pattern
  const match = input.match(/\/pull\/(\d+)/);
  if (match) {
    return parseInt(match[1], 10);
  }

  throw new Error(`Invalid PR number or URL: ${input}`);
}

function printHumanVerdict(prNumber: number, verdict: ReadyVerdict): void {
  console.log(`PR #${prNumber}: ${verdict.status.toUpperCase()}`);
  if (verdict.reasons.length > 0) {
    for (const reason of verdict.reasons) {
      console.log(`- ${reason}`);
    }
  }
  if (verdict.output.labels.length > 0) {
    console.log(`labels: ${verdict.output.labels.join(', ')}`);
  }
  if (verdict.output.comment) {
    console.log('');
    console.log(verdict.output.comment);
  }
}
