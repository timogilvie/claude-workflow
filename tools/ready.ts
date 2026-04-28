#!/usr/bin/env -S npx tsx

import { getIntegrationReadyPolicy } from '../shared/lib/config.ts';
import { getPullRequest } from '../shared/lib/github.ts';
import { getIssueCompletionState } from '../shared/lib/linear.ts';
import { evaluateReady, type ReadyVerdict } from '../shared/lib/ready-engine.ts';
import { runTool } from '../shared/lib/tool-runner.ts';
import { checkMergeConflicts, runReadyStage, type ReadyCheck, type ReadyResult } from '../shared/lib/ready-stage.ts';
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
    let output: ReadyResult;

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

      output = {
        prNumber,
        verdict: verdict.status,
        checks: buildPolicyChecks(verdict),
        summary: verdict.reasons[0] ?? summarizeVerdict(verdict.status),
        timestamp: new Date().toISOString(),
        mergeConflict: await checkMergeConflicts(prNumber, repoDir),
      };
    } else {
      output = await runReadyStage({ prNumber, repoDir });
      verdict = {
        status: output.verdict,
        reasons: output.summary ? [output.summary] : [],
        output: { labels: [], comment: '' },
      };
    }

    console.log(JSON.stringify(output));

    if (verdict.status === 'fail') {
      process.exit(1);
    } else if (verdict.status === 'pending') {
      process.exit(2);
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

function buildPolicyChecks(verdict: ReadyVerdict): ReadyCheck[] {
  if (verdict.reasons.length === 0) {
    return [{
      name: 'ready-policy',
      status: verdict.status,
      message: summarizeVerdict(verdict.status),
      details: {},
    }];
  }

  return verdict.reasons.map((reason) => ({
    name: 'ready-policy',
    status: verdict.status,
    message: reason,
    details: {},
  }));
}

function summarizeVerdict(status: ReadyVerdict['status']): string {
  if (status === 'pass') {
    return 'All ready policy checks passed';
  }
  if (status === 'pending') {
    return 'Ready policy checks are still pending';
  }
  if (status === 'warn') {
    return 'Ready policy checks passed with warnings';
  }
  return 'Ready policy checks failed';
}
