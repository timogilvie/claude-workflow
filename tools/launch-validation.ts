#!/usr/bin/env -S npx tsx

import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateLaunchValidationReport,
  type LaunchValidationMode,
} from '../shared/lib/launch-validation.ts';
import { runTool, resolveRepoDir, type ParsedArgs } from '../shared/lib/tool-runner.ts';

const DEFAULT_OUT_PATH = '.wavemill/audits/launch-validation.json';

const options = {
  out: { type: 'string', description: 'Output JSON path' },
  'repo-dir': { type: 'string', description: 'Repository directory to validate' },
  live: { type: 'boolean', description: 'Fetch the live catalog and run live smoke coverage.' },
  prompt: { type: 'string', description: 'Override the smoke prompt (default: ping).' },
  target: { type: 'string', description: 'Coverage target per role', default: '3' },
  'max-attempts': { type: 'string', description: 'Maximum follow-up sampling attempts', default: '10' },
  'anchor-share': { type: 'string', description: 'Anchor dominance threshold between 0 and 1', default: '0.45' },
  json: { type: 'boolean', description: 'Print the full validation artifact as JSON' },
} as const;

type CliArgs = ParsedArgs<typeof options>;

export interface LaunchValidationCommandDeps {
  generateReport: typeof generateLaunchValidationReport;
}

const defaultDeps: LaunchValidationCommandDeps = {
  generateReport: generateLaunchValidationReport,
};

function parseInteger(name: string, raw: string | undefined, minimum: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function parseShare(raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error('--anchor-share must be a number > 0 and <= 1');
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

export async function runLaunchValidationCommand(
  args: CliArgs,
  deps: LaunchValidationCommandDeps = defaultDeps,
): Promise<void> {
  const repoDir = resolveRepoDir(args['repo-dir']);
  const outPath = resolveOutPath(repoDir, args.out);
  const coverageTargetPerRole = parseInteger('--target', args.target, 1);
  const maxAttempts = parseInteger('--max-attempts', args['max-attempts'], 0);
  const anchorShareThreshold = parseShare(args['anchor-share']);
  const mode: LaunchValidationMode = args.live === true ? 'live' : 'fixture';
  const report = await deps.generateReport({
    repoDir,
    smokeMode: mode,
    prompt: args.prompt,
    coverageTargetPerRole,
    maxAttempts,
    anchorShareThreshold,
    apiKey: process.env.OPENROUTER_API_KEY,
  });

  const serialized = JSON.stringify(report, null, 2);
  writeAtomic(outPath, `${serialized}\n`);

  console.log(
    `Validated ${report.groupedAudit.models.length} launch-priority models. `
      + `Smoke ok: ${report.smoke.summary.ok}. `
      + `Smoke blockers: ${report.smoke.summary.blocker}. `
      + `Under-sampled: ${report.groupedAudit.samplingPlan.length}. `
      + `Hokusai rows: ${report.hokusai.validRows} valid / ${report.hokusai.invalidRows} invalid.`,
  );
  if (report.familyChecks.length > 0) {
    console.log('Family checks:');
    for (const check of report.familyChecks) {
      console.log(`  ${check.family}\t${check.status}\t${check.challengerAlias ?? 'none'}`);
    }
  }
  if (args.json === true) {
    console.log(serialized);
  }
}

export async function runLaunchValidationCli(
  argv: string[] = process.argv.slice(2),
  deps: LaunchValidationCommandDeps = defaultDeps,
): Promise<void> {
  await runTool({
    name: 'launch-validation',
    description: 'Validate launch-priority OpenRouter coverage, smoke status, and Hokusai exportability',
    options,
    examples: [
      'npx tsx tools/launch-validation.ts',
      'npx tsx tools/launch-validation.ts --live --target 3 --max-attempts 10',
      'npx tsx tools/launch-validation.ts --out reports/launch-validation.json --json',
    ],
    run: ({ args }) => runLaunchValidationCommand(args, deps),
  }, argv);
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  await runLaunchValidationCli();
}
