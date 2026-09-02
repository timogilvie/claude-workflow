/**
 * CI test-timing CLI: deterministic weighted shard assignment, weight-manifest
 * generation, and the preflight balance/registration guard (HOK-2939).
 *
 * Subcommands:
 *   assign   --suite <unit|custom> --shard N/M [--weights <file>]
 *            Reads the full registered test list from stdin (one per line,
 *            piped by tests/run-unit-tests.sh / tests/run-custom-tests.sh)
 *            and prints shard N's subset, one per line, in input order.
 *   generate --suite <s> --out <file> [--allow-few] <sample.json...>
 *            Builds tests/timings/<s>-weights.json from >=3 timing artifacts
 *            (median per test, p90 default for unknown tests).
 *   check    [repoDir]
 *            Preflight guard: manifests parse and are positive-finite, ci.yml
 *            shard counts are consistent (matrix values, job name, --shard
 *            argument), every registered test is assigned exactly once, and
 *            the 130%-of-median balance rule holds (named indivisible-hotspot
 *            exceptions allowed). Wired into `npm run test:preflight`.
 *   report   [repoDir]
 *            Human-readable balance report for the current manifests and
 *            ci.yml shard counts.
 *
 * Business logic lives in shared/lib/test-partitioner.ts; this file owns the
 * repo plumbing (stdin, ci.yml parsing, runner --list invocation) following
 * the same self-contained pattern as tools/check-ci-command-map-drift.ts.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  balanceReport,
  mergeSamples,
  partition,
  validateManifest,
  type BalanceReport,
  type PartitionAssignment,
  type TimingSample,
  type WeightManifest,
} from '../shared/lib/test-partitioner.ts';

const __filename = fileURLToPath(import.meta.url);
const defaultRepoRoot = join(dirname(__filename), '..');

interface SuiteSpec {
  /** ci.yml job id whose matrix drives the shard count. */
  jobId: string;
  /** Runner script, invoked with --list to enumerate registered tests. */
  runner: string;
  /** Checked-in weight manifest path (repo-relative). */
  manifest: string;
}

export const SUITES: Record<string, SuiteSpec> = {
  unit: {
    jobId: 'unit',
    runner: 'tests/run-unit-tests.sh',
    manifest: 'tests/timings/unit-weights.json',
  },
  custom: {
    jobId: 'custom',
    runner: 'tests/run-custom-tests.sh',
    manifest: 'tests/timings/custom-weights.json',
  },
};

// ── assign ───────────────────────────────────────────────────────────────────

export interface AssignInput {
  tests: string[];
  manifest: WeightManifest;
  shardIndex: number;
  shardTotal: number;
}

/**
 * Deterministic shard selection: partition the full list by manifest weights
 * and return the requested shard's tests in input order.
 */
export function assignShard(input: AssignInput): string[] {
  const { tests, manifest, shardIndex, shardTotal } = input;
  if (!Number.isInteger(shardIndex) || shardIndex < 1 || shardIndex > shardTotal) {
    throw new Error(`ci-test-timings: invalid shard ${shardIndex}/${shardTotal}`);
  }
  const assignment = partition({
    tests,
    weights: manifest.weights,
    defaultWeightMs: manifest.defaultWeightMs,
    shardTotal,
  });
  return assignment.shards[shardIndex - 1];
}

// ── generate ─────────────────────────────────────────────────────────────────

export interface GenerateInput {
  suite: string;
  samples: TimingSample[];
  /** Labels recorded in the manifest (file names or run ids). */
  sampleLabels: string[];
  allowFew?: boolean;
}

export function generateManifest(input: GenerateInput): WeightManifest {
  const merged = mergeSamples(input.samples, { allowFew: input.allowFew });
  return {
    suite: input.suite,
    generatedAt: new Date().toISOString(),
    samples: input.sampleLabels,
    defaultWeightMs: merged.defaultWeightMs,
    weights: merged.weights,
  };
}

// ── ci.yml shard-count parsing ───────────────────────────────────────────────

export interface CiShardConfig {
  /** Shard values from the job's matrix, in file order (empty when unsharded). */
  matrixShards: number[];
  /** Denominator in the job name, e.g. 5 in "Unit Tests (shard ${{...}}/5)". */
  nameDenominator: number | null;
  /** Denominator in the run step, e.g. 5 in "--shard ${{ matrix.shard }}/5". */
  runDenominator: number | null;
}

/**
 * Extract shard configuration for one job id from ci.yml text. Parsing follows
 * the same line-oriented conventions as tools/check-ci-command-map-drift.ts.
 */
export function parseCiShardConfig(workflow: string, jobId: string): CiShardConfig | null {
  const jobMatch = workflow.match(new RegExp(`^  ${jobId}:\\s*$`, 'm'));
  if (!jobMatch || jobMatch.index === undefined) return null;
  const rest = workflow.slice(jobMatch.index + jobMatch[0].length);
  const nextJob = rest.match(/^  [A-Za-z0-9_-]+:\s*$/m);
  const block = nextJob && nextJob.index !== undefined ? rest.slice(0, nextJob.index) : rest;

  const matrixLine = block.match(/^\s+shard:\s*\[(.*?)\]\s*$/m);
  const matrixShards = matrixLine
    ? matrixLine[1].split(',').map((value) => Number.parseInt(value.trim(), 10))
    : [];

  const nameLine = block.match(/^\s+name:\s*(.+?)\s*$/m)?.[1] ?? '';
  const nameDenom = nameLine.match(/\$\{\{\s*matrix\.shard\s*\}\}\/(\d+)/);

  const runDenom = block.match(/--shard\s+\$\{\{\s*matrix\.shard\s*\}\}\/(\d+)/);

  return {
    matrixShards,
    nameDenominator: nameDenom ? Number.parseInt(nameDenom[1], 10) : null,
    runDenominator: runDenom ? Number.parseInt(runDenom[1], 10) : null,
  };
}

// ── check ────────────────────────────────────────────────────────────────────

export interface SuiteCheckResult {
  suite: string;
  shardTotal: number;
  registeredCount: number;
  balance: BalanceReport | null;
  errors: string[];
  warnings: string[];
}

export interface CiTimingsCheckResult {
  ok: boolean;
  suites: SuiteCheckResult[];
}

function listRegisteredTests(repoDir: string, runner: string): string[] {
  const output = execFileSync('bash', [runner, '--list'], {
    cwd: repoDir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * The preflight guard. Fails (via error entries) on: unparseable/invalid
 * manifests, inconsistent ci.yml shard counts, non-contiguous matrix values,
 * duplicate registrations, or a balance-rule violation without the named
 * indivisible-hotspot exception. Unknown/stale manifest entries are warnings:
 * they degrade balance, never correctness.
 */
export function checkCiTimings(repoDir = defaultRepoRoot): CiTimingsCheckResult {
  const workflow = readFileSync(join(repoDir, '.github', 'workflows', 'ci.yml'), 'utf-8');
  const suites: SuiteCheckResult[] = [];

  for (const [suite, spec] of Object.entries(SUITES)) {
    const errors: string[] = [];
    const warnings: string[] = [];
    let manifest: WeightManifest | null = null;
    let tests: string[] = [];
    let shardTotal = 1;
    let balance: BalanceReport | null = null;

    try {
      manifest = validateManifest(
        JSON.parse(readFileSync(join(repoDir, spec.manifest), 'utf-8')),
        spec.manifest,
      );
    } catch (err) {
      errors.push(`${spec.manifest}: ${(err as Error).message}`);
    }

    try {
      tests = listRegisteredTests(repoDir, spec.runner);
      if (tests.length === 0) {
        errors.push(`${spec.runner} --list returned no tests`);
      }
    } catch (err) {
      errors.push(`${spec.runner} --list failed: ${(err as Error).message}`);
    }

    const ci = parseCiShardConfig(workflow, spec.jobId);
    if (!ci) {
      errors.push(`ci.yml: job "${spec.jobId}" not found`);
    } else if (ci.matrixShards.length === 0 && ci.runDenominator === null) {
      // Unsharded job (rollback layout): single shard, nothing to cross-check.
      shardTotal = 1;
    } else {
      shardTotal = ci.matrixShards.length;
      const expected = Array.from({ length: shardTotal }, (_, i) => i + 1);
      if (ci.matrixShards.some((value, i) => value !== expected[i])) {
        errors.push(
          `ci.yml: job "${spec.jobId}" matrix shard values [${ci.matrixShards.join(', ')}] `
          + `must be exactly [${expected.join(', ')}]`,
        );
      }
      if (ci.nameDenominator !== shardTotal) {
        errors.push(
          `ci.yml: job "${spec.jobId}" name denominator (${ci.nameDenominator ?? 'missing'}) `
          + `does not match matrix count ${shardTotal}`,
        );
      }
      if (ci.runDenominator !== shardTotal) {
        errors.push(
          `ci.yml: job "${spec.jobId}" --shard denominator (${ci.runDenominator ?? 'missing'}) `
          + `does not match matrix count ${shardTotal} -- shards would be dropped or duplicated`,
        );
      }
    }

    if (manifest && tests.length > 0 && errors.length === 0) {
      try {
        const assignment = partition({
          tests,
          weights: manifest.weights,
          defaultWeightMs: manifest.defaultWeightMs,
          shardTotal,
        });
        verifyCompleteAssignment(assignment, tests, suite, errors);
        balance = balanceReport(assignment);
        for (const violation of balance.violations) {
          errors.push(
            `${suite}: shard ${violation.shard} estimate ${Math.round(violation.estimateMs)}ms exceeds `
            + `130% of median (${Math.round(violation.limitMs)}ms); rebalance or raise the shard count `
            + `(regenerate ${spec.manifest} per docs/ci-test-timings.md)`,
          );
        }
        for (const hotspot of balance.indivisibleHotspots) {
          warnings.push(
            `${suite}: shard ${hotspot.shard} exceeds the balance bound because single test `
            + `"${hotspot.test}" (${Math.round(hotspot.weightMs)}ms) alone exceeds `
            + `${Math.round(hotspot.limitMs)}ms -- allowed as an indivisible hotspot`,
          );
        }

        const registered = new Set(tests);
        const stale = Object.keys(manifest.weights).filter((id) => !registered.has(id));
        if (stale.length > 0) {
          warnings.push(
            `${suite}: ${stale.length} manifest entr${stale.length === 1 ? 'y' : 'ies'} no longer `
            + `registered (harmless): ${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ', ...' : ''}`,
          );
        }
        const unknown = tests.filter((id) => !Object.hasOwn(manifest.weights, id));
        if (unknown.length > 0) {
          warnings.push(
            `${suite}: ${unknown.length} test(s) not in the manifest use the conservative default `
            + `${manifest.defaultWeightMs}ms: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ', ...' : ''}`,
          );
        }
      } catch (err) {
        errors.push((err as Error).message);
      }
    }

    suites.push({ suite, shardTotal, registeredCount: tests.length, balance, errors, warnings });
  }

  return { ok: suites.every((entry) => entry.errors.length === 0), suites };
}

function verifyCompleteAssignment(
  assignment: PartitionAssignment,
  tests: string[],
  suite: string,
  errors: string[],
): void {
  const assigned = assignment.shards.flat();
  const assignedSet = new Set(assigned);
  if (assigned.length !== assignedSet.size) {
    errors.push(`${suite}: a test is assigned to more than one shard`);
  }
  for (const test of tests) {
    if (!assignedSet.has(test)) {
      errors.push(`${suite}: registered test "${test}" was not assigned to any shard`);
    }
  }
  for (const test of assigned) {
    if (!tests.includes(test)) {
      errors.push(`${suite}: assigned test "${test}" is not in the registered list`);
    }
  }
}

export function formatCheckResult(result: CiTimingsCheckResult): string {
  const lines: string[] = [];
  for (const suiteResult of result.suites) {
    const status = suiteResult.errors.length === 0 ? 'ok' : 'FAIL';
    const estimate = suiteResult.balance
      ? `, max shard ~${Math.round(suiteResult.balance.maxMs / 1000)}s, `
        + `max/median ${suiteResult.balance.maxOverMedian.toFixed(2)}`
      : '';
    lines.push(
      `ci-test-timings [${suiteResult.suite}]: ${status} `
      + `(${suiteResult.registeredCount} tests, ${suiteResult.shardTotal} shard(s)${estimate})`,
    );
    for (const error of suiteResult.errors) lines.push(`  ERROR ${error}`);
    for (const warning of suiteResult.warnings) lines.push(`  warn  ${warning}`);
  }
  return lines.join('\n');
}

export function formatBalanceTable(result: CiTimingsCheckResult): string {
  const lines: string[] = [];
  for (const suiteResult of result.suites) {
    lines.push(`Suite: ${suiteResult.suite} (${suiteResult.registeredCount} tests, ${suiteResult.shardTotal} shard(s))`);
    if (suiteResult.balance) {
      suiteResult.balance.estimates.forEach((ms, index) => {
        lines.push(`  shard ${index + 1}: ~${(ms / 1000).toFixed(1)}s estimated`);
      });
      lines.push(
        `  median ~${(suiteResult.balance.medianMs / 1000).toFixed(1)}s, `
        + `max/median ${suiteResult.balance.maxOverMedian.toFixed(2)} (limit 1.30)`,
      );
    }
    for (const error of suiteResult.errors) lines.push(`  ERROR ${error}`);
    for (const warning of suiteResult.warnings) lines.push(`  warn  ${warning}`);
  }
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseFlags(argv: string[]): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--allow-few') {
      flags['allow-few'] = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`ci-test-timings: flag --${key} requires a value`);
      }
      flags[key] = value;
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function readStdinLines(): string[] {
  const raw = readFileSync(0, 'utf-8');
  return raw.split('\n').map((line) => line.trim()).filter(Boolean);
}

function requireSuite(value: unknown): string {
  if (typeof value !== 'string' || !Object.hasOwn(SUITES, value)) {
    throw new Error(`ci-test-timings: --suite must be one of: ${Object.keys(SUITES).join(', ')}`);
  }
  return value;
}

function loadManifest(path: string): WeightManifest {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(`ci-test-timings: cannot read weight manifest ${path}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`ci-test-timings: malformed JSON in ${path}: ${(err as Error).message}`);
  }
  return validateManifest(parsed, path);
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseFlags(rest);

  switch (command) {
    case 'assign': {
      const suite = requireSuite(flags.suite);
      const shard = String(flags.shard ?? '');
      const match = shard.match(/^(\d+)\/(\d+)$/);
      if (!match) {
        throw new Error('ci-test-timings: assign requires --shard INDEX/TOTAL (e.g. 2/5)');
      }
      const manifestPath = typeof flags.weights === 'string'
        ? flags.weights
        : join(defaultRepoRoot, SUITES[suite].manifest);
      const selected = assignShard({
        tests: readStdinLines(),
        manifest: loadManifest(manifestPath),
        shardIndex: Number.parseInt(match[1], 10),
        shardTotal: Number.parseInt(match[2], 10),
      });
      if (selected.length > 0) {
        process.stdout.write(`${selected.join('\n')}\n`);
      }
      break;
    }
    case 'generate': {
      const suite = requireSuite(flags.suite);
      const out = flags.out;
      if (typeof out !== 'string') {
        throw new Error('ci-test-timings: generate requires --out <file>');
      }
      if (positional.length === 0) {
        throw new Error('ci-test-timings: generate requires at least one sample JSON file');
      }
      const samples = positional.map((file) => {
        const parsed = JSON.parse(readFileSync(file, 'utf-8')) as TimingSample;
        return parsed;
      });
      const manifest = generateManifest({
        suite,
        samples,
        sampleLabels: positional.map((file) => basename(file)),
        allowFew: flags['allow-few'] === true,
      });
      writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(
        `ci-test-timings: wrote ${out} (${Object.keys(manifest.weights).length} weights from `
        + `${manifest.samples.length} samples, defaultWeightMs=${manifest.defaultWeightMs})`,
      );
      break;
    }
    case 'check': {
      const result = checkCiTimings(positional[0] ?? defaultRepoRoot);
      const message = formatCheckResult(result);
      if (!result.ok) {
        console.error(message);
        process.exit(1);
      }
      console.log(message);
      break;
    }
    case 'report': {
      console.log(formatBalanceTable(checkCiTimings(positional[0] ?? defaultRepoRoot)));
      break;
    }
    default:
      console.error(
        'Usage: ci-test-timings.ts <assign|generate|check|report> [options]\n'
        + '  assign   --suite <unit|custom> --shard N/M [--weights <file>]  (test list on stdin)\n'
        + '  generate --suite <s> --out <file> [--allow-few] <sample.json...>\n'
        + '  check    [repoDir]\n'
        + '  report   [repoDir]',
      );
      process.exit(command === undefined || command === 'help' || command === '--help' ? 0 : 2);
  }
}

if (process.argv[1] === __filename) {
  try {
    main();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
