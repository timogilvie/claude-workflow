#!/usr/bin/env -S npx tsx

import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditLaunchPriorityCoverage } from '../shared/lib/launch-priority-audit.ts';
import { loadLaunchPriorityList, type LaunchPriorityModel } from '../shared/lib/openrouter-catalog.ts';
import { runTool, resolveRepoDir, type ParsedArgs } from '../shared/lib/tool-runner.ts';

const DEFAULT_OUT_PATH = '.wavemill/audits/launch-priority-coverage.json';

const options = {
  out: { type: 'string', description: 'Output JSON path' },
  'repo-dir': { type: 'string', description: 'Repository directory to audit' },
  target: { type: 'string', description: 'Coverage target per role', default: '3' },
  'max-attempts': { type: 'string', description: 'Maximum planned follow-up attempts', default: '10' },
  json: { type: 'boolean', description: 'Print the full audit artifact as JSON' },
} as const;

type CliArgs = ParsedArgs<typeof options>;

export interface LaunchPriorityAuditToolDeps {
  auditCoverage: typeof auditLaunchPriorityCoverage;
  loadCatalog: () => LaunchPriorityModel[];
}

const defaultDeps: LaunchPriorityAuditToolDeps = {
  auditCoverage: auditLaunchPriorityCoverage,
  loadCatalog: () => loadLaunchPriorityList(),
};

function parseInteger(name: string, raw: string | undefined, minimum: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

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

export async function runLaunchPriorityAuditCommand(
  args: CliArgs,
  deps: LaunchPriorityAuditToolDeps = defaultDeps,
): Promise<void> {
  const repoDir = resolveRepoDir(args['repo-dir']);
  const outPath = resolveOutPath(repoDir, args.out);
  const coverageTargetPerRole = parseInteger('--target', args.target, 1);
  const maxAttempts = parseInteger('--max-attempts', args['max-attempts'], 0);
  const audit = deps.auditCoverage({
    catalog: deps.loadCatalog(),
    repoDir,
    coverageTargetPerRole,
    maxAttempts,
  });
  const serialized = JSON.stringify(audit, null, 2);

  writeAtomic(outPath, `${serialized}\n`);

  console.log(
    `Audited ${audit.summary.totalLaunchPriority} launch-priority models. `
      + `Zero-evidence: ${audit.zeroEvidence.length}. `
      + `Below-target: ${audit.belowTarget.length}. `
      + `Sampled: ${audit.summary.sampledCount}. `
      + `Blocked: ${audit.summary.blockedCount}.`,
  );
  if (audit.samplingPlan.length === 0) {
    console.log('Top sampled models: none');
  } else {
    console.log('Top sampled models:');
    for (const entry of audit.samplingPlan.slice(0, Math.min(10, audit.samplingPlan.length))) {
      console.log(`  ${entry.wavemillAlias}\t${entry.role}\t${entry.tier}\tgap=${entry.gap}`);
    }
  }
  if (args.json === true) {
    console.log(serialized);
  }
}

export async function runLaunchPriorityAuditCli(
  argv: string[] = process.argv.slice(2),
  deps: LaunchPriorityAuditToolDeps = defaultDeps,
): Promise<void> {
  await runTool({
    name: 'launch-priority-audit',
    description: 'Audit launch-priority model coverage and emit targeted follow-up sampling',
    options,
    examples: [
      'npx tsx tools/launch-priority-audit.ts',
      'npx tsx tools/launch-priority-audit.ts --repo-dir /path/to/repo --target 3 --max-attempts 10',
      'npx tsx tools/launch-priority-audit.ts --out reports/launch-priority.json --json',
    ],
    run: ({ args }) => runLaunchPriorityAuditCommand(args, deps),
  }, argv);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runLaunchPriorityAuditCli();
}
