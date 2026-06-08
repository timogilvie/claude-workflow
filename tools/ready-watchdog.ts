#!/usr/bin/env -S npx tsx

import { execFile as execFileCb } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { getMillConfig } from '../shared/lib/config.ts';
import { errorMessage } from '../shared/lib/error-utils.ts';
import { runTool } from '../shared/lib/tool-runner.ts';
import { tickReadyWatchdog } from '../shared/lib/ready-watchdog.ts';
import type { WorkflowStateLike } from '../shared/lib/job-tracker.ts';

const execFile = promisify(execFileCb);

async function launchRemediation(args: {
  repoDir: string;
  stateFile: string;
  issueId: string;
  failedCheckSummary: string;
  failedCheckNamesJson: string;
  attemptNumber: number;
  maxAttempts: number;
}) {
  const workflowState = JSON.parse(await readFile(args.stateFile, 'utf-8')) as WorkflowStateLike;
  const task = workflowState.tasks?.[args.issueId] as Record<string, unknown> | undefined;
  if (!task) {
    return {
      status: 'failed',
      detail: `Ready watchdog could not find workflow task ${args.issueId}.`,
      attemptNumber: args.attemptNumber,
    };
  }

  const worktree = String(task.worktree ?? '');
  const slug = String(task.slug ?? '');
  const branch = String(task.branch ?? '');
  const prNumber = Number(task.pr ?? 0);
  const baseBranch = getMillConfig(args.repoDir).baseBranch ?? 'main';
  if (!worktree || !slug || !branch || !Number.isFinite(prNumber) || prNumber <= 0) {
    return {
      status: 'failed',
      detail: `Ready watchdog could not resolve launch metadata for ${args.issueId}.`,
      attemptNumber: args.attemptNumber,
    };
  }

  const scriptPath = path.join(args.repoDir, 'shared/lib/wavemill-mill.sh');
  const launchCommand = `
    set -euo pipefail
    source "$WAVEMILL_SCRIPT_PATH"
    launch_ready_watchdog_remediation \
      "$WAVEMILL_ISSUE_ID" \
      "$WAVEMILL_SLUG" \
      "$WAVEMILL_WORKTREE" \
      "$WAVEMILL_BRANCH" \
      "$WAVEMILL_BASE_BRANCH" \
      "$WAVEMILL_PR_NUMBER" \
      "$WAVEMILL_FAILED_CHECK_SUMMARY" \
      "$WAVEMILL_ATTEMPT_NUMBER" \
      "$WAVEMILL_MAX_ATTEMPTS" \
      "$WAVEMILL_FAILED_CHECK_NAMES_JSON"
  `;
  try {
    const { stdout } = await execFile('bash', ['-lc', launchCommand], {
      cwd: args.repoDir,
      encoding: 'utf-8',
      env: {
        ...process.env,
        SESSION: process.env.SESSION || 'wavemill',
        WAVEMILL_SCRIPT_PATH: scriptPath,
        WAVEMILL_ISSUE_ID: args.issueId,
        WAVEMILL_SLUG: slug,
        WAVEMILL_WORKTREE: worktree,
        WAVEMILL_BRANCH: branch,
        WAVEMILL_BASE_BRANCH: baseBranch,
        WAVEMILL_PR_NUMBER: String(prNumber),
        WAVEMILL_FAILED_CHECK_SUMMARY: args.failedCheckSummary,
        WAVEMILL_ATTEMPT_NUMBER: String(args.attemptNumber),
        WAVEMILL_MAX_ATTEMPTS: String(args.maxAttempts),
        WAVEMILL_FAILED_CHECK_NAMES_JSON: args.failedCheckNamesJson,
      },
      maxBuffer: 1024 * 1024,
    });
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    return JSON.parse(lines[lines.length - 1] || '{}') as Record<string, unknown>;
  } catch (error) {
    return {
      status: 'failed',
      detail: `Ready watchdog launch failed: ${errorMessage(error)}`,
      attemptNumber: args.attemptNumber,
    };
  }
}

runTool({
  name: 'ready-watchdog',
  description: 'Classify and recover stale ready-stage local state',
  options: {
    'repo-dir': {
      type: 'string',
      description: 'Repository directory (default: current directory)',
    },
    'state-file': {
      type: 'string',
      description: 'Workflow state file path (default: <repo>/.wavemill/workflow-state.json)',
    },
    once: {
      type: 'boolean',
      description: 'Run a single watchdog tick and exit',
      default: true,
    },
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON output',
    },
    recover: {
      type: 'string',
      description: 'Force a recovery attempt for one ready-stage issue id',
    },
    'launch-remediation': {
      type: 'string',
      description: 'Launch a ready remediation attempt for one ready-stage issue id',
    },
    'failed-check-summary': {
      type: 'string',
      description: 'Human summary of failing checks for launch mode',
    },
    'failed-check-names-json': {
      type: 'string',
      description: 'JSON array of failing check names for launch mode',
    },
    'attempt-number': {
      type: 'string',
      description: '1-based remediation attempt number for launch mode',
    },
    'max-attempts': {
      type: 'string',
      description: 'Remediation attempt cap for launch mode',
    },
  },
  async run({ args }) {
    const repoDir = path.resolve(args['repo-dir'] || process.cwd());
    const stateFile = path.resolve(args['state-file'] || path.join(repoDir, '.wavemill', 'workflow-state.json'));
    if (args['launch-remediation']) {
      const result = await launchRemediation({
        repoDir,
        stateFile,
        issueId: args['launch-remediation'],
        failedCheckSummary: args['failed-check-summary'] || 'checks failing',
        failedCheckNamesJson: args['failed-check-names-json'] || '[]',
        attemptNumber: Number(args['attempt-number'] || '1'),
        maxAttempts: Number(args['max-attempts'] || '3'),
      });
      console.log(JSON.stringify(result));
      return;
    }

    const result = await tickReadyWatchdog({
      repoDir,
      stateFile,
      issueFilter: args.recover,
      forceRecover: Boolean(args.recover),
    });

    if (args.json) {
      console.log(JSON.stringify(result));
      return;
    }

    if (result.findings.length === 0) {
      console.log('No stale ready-stage tasks detected.');
      return;
    }

    for (const finding of result.findings) {
      console.log(
        `${finding.issueId} ${finding.displayLabel}: ${finding.detail}`
        + (finding.recoveryCommand ? `\n  recovery: ${finding.recoveryCommand}` : ''),
      );
    }
  },
});
