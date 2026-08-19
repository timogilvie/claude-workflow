#!/usr/bin/env -S npx tsx

import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditStaleTaskBranches,
  cleanupAuditedStaleTaskBranches,
  type StaleBranchRecord,
} from '../shared/lib/stale-task-branches.ts';
import { runTool, resolveRepoDir, type ParsedArgs } from '../shared/lib/tool-runner.ts';

const DEFAULT_OUT_PATH = '.wavemill/audits/stale-task-branches.json';

const options = {
  'repo-dir': { type: 'string', description: 'Repository directory to audit' },
  execute: { type: 'boolean', description: 'Delete eligible remote branches' },
  'include-closed': { type: 'boolean', description: 'Also delete closed-unmerged task refs when executing' },
  json: { type: 'boolean', description: 'Print the full audit artifact as JSON' },
  out: { type: 'string', description: 'Output JSON path' },
} as const;

type CliArgs = ParsedArgs<typeof options>;

export interface CleanupStaleBranchesToolDeps {
  auditStaleTaskBranches: typeof auditStaleTaskBranches;
  cleanupAuditedStaleTaskBranches: typeof cleanupAuditedStaleTaskBranches;
}

const defaultDeps: CleanupStaleBranchesToolDeps = {
  auditStaleTaskBranches,
  cleanupAuditedStaleTaskBranches,
};

function resolveOutPath(repoDir: string, out: string | undefined): string {
  const raw = out ?? DEFAULT_OUT_PATH;
  return isAbsolute(raw) ? raw : resolve(repoDir, raw);
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, path);
}

function prSummary(record: StaleBranchRecord): string {
  if (record.prs.length === 0) return '-';
  return record.prs
    .map((pr) => `#${pr.number}:${pr.state}`)
    .join(',');
}

function count(records: StaleBranchRecord[], status: StaleBranchRecord['status']): number {
  return records.filter((record) => record.status === status).length;
}

export async function runCleanupStaleBranchesCommand(
  args: CliArgs,
  deps: CleanupStaleBranchesToolDeps = defaultDeps,
): Promise<void> {
  const repoDir = resolveRepoDir(args['repo-dir']);
  const records = deps.auditStaleTaskBranches(repoDir);
  const cleanup = deps.cleanupAuditedStaleTaskBranches(repoDir, records, {
    execute: args.execute === true,
    includeClosed: args['include-closed'] === true,
  });
  const artifact = {
    generatedAt: new Date().toISOString(),
    repoDir,
    execute: args.execute === true,
    includeClosed: args['include-closed'] === true,
    records,
    cleanup,
  };
  const serialized = JSON.stringify(artifact, null, 2);
  writeAtomic(resolveOutPath(repoDir, args.out), `${serialized}\n`);

  console.log('branch\tstatus\tprs\treason');
  for (const record of records) {
    console.log(`${record.branch}\t${record.status}\t${prSummary(record)}\t${record.reasons.join('; ')}`);
  }
  console.log(
    `${count(records, 'stale-merged')} stale-merged ${args.execute === true ? 'deleted' : 'would delete'}, `
      + `${count(records, 'closed-unmerged')} closed-unmerged, `
      + `${count(records, 'open-pr')} open, `
      + `${count(records, 'no-pr')} no-pr, `
      + `${count(records, 'local-live')} local-live`,
  );
  if (cleanup.failed.length > 0) {
    console.log(`Failed deletions: ${cleanup.failed.length}`);
  }
  if (args.json === true) {
    console.log(serialized);
  }
}

export async function runCleanupStaleBranchesCli(
  argv: string[] = process.argv.slice(2),
  deps: CleanupStaleBranchesToolDeps = defaultDeps,
): Promise<void> {
  await runTool({
    name: 'cleanup-stale-branches',
    description: 'Audit and optionally delete stale remote task branches',
    options,
    examples: [
      'npx tsx tools/cleanup-stale-branches.ts',
      'npx tsx tools/cleanup-stale-branches.ts --repo-dir /path/to/repo',
      'npx tsx tools/cleanup-stale-branches.ts --execute --include-closed',
    ],
    run: ({ args }) => runCleanupStaleBranchesCommand(args, deps),
  }, argv);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runCleanupStaleBranchesCli();
}
