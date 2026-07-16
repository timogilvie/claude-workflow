#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import { launchNativePlanning } from '../shared/lib/native-agent/launch-planning.ts';

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const session = readOption('session') ?? process.env.WAVEMILL_SESSION ?? '';
  const issue = readOption('issue') ?? process.env.WAVEMILL_ISSUE ?? '';
  const slug = readOption('slug') ?? process.env.WAVEMILL_FEATURE_SLUG ?? process.env.WAVEMILL_SLUG ?? '';
  const wtDir = resolve(readOption('wt-dir') ?? process.env.WAVEMILL_WT_DIR ?? process.cwd());
  const repoDir = resolve(readOption('repo-dir') ?? process.env.WAVEMILL_REPO_DIR ?? process.cwd());

  if (!session || !issue || !slug) {
    throw new Error('session, issue, and slug are required');
  }

  await launchNativePlanning({
    session,
    issue,
    slug,
    wtDir,
    repoDir,
    phase: 'planning',
    planDepth: readOption('plan-depth') ?? process.env.WAVEMILL_PLAN_DEPTH ?? 'light',
    operatingMode: readOption('operating-mode') ?? process.env.WAVEMILL_OPERATING_MODE ?? 'normal',
    branch: readOption('branch') ?? process.env.WAVEMILL_BRANCH,
    baseBranch: readOption('base-branch') ?? process.env.WAVEMILL_BASE_BRANCH,
    title: readOption('title') ?? process.env.WAVEMILL_TITLE,
    issueContext: readOption('issue-context') ?? process.env.WAVEMILL_ISSUE_CONTEXT,
    linearIssue: readOption('linear-issue') ?? process.env.WAVEMILL_LINEAR_ISSUE,
  });
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
