#!/usr/bin/env tsx

import { resolve } from 'node:path';
import { getHarnessRetentionConfig } from '../shared/lib/config.ts';
import {
  DEFAULT_HARNESS_REPLAY_REPORT_DIR,
  DEFAULT_HARNESS_REPLAY_SUITE_PATH,
  runHarnessReplayFromSuite,
  type HarnessReplayMode,
} from '../shared/lib/harness-replay.ts';

interface CliOptions {
  repoDir: string;
  suitePath: string;
  baselineHarnessId: string;
  candidateHarnessId: string;
  mode: HarnessReplayMode;
  tolerance?: number;
  reportPath?: string;
}

function usage(): never {
  console.error([
    'Usage: npx tsx tools/run-harness-replay.ts [options]',
    '',
    'Options:',
    '  --repo-dir <path>                 Repository root (default: cwd)',
    '  --suite <path>                    Replay suite manifest path',
    '  --baseline-harness-id <id>        Deployed/baseline harness ID',
    '  --candidate-harness-id <id>       Candidate harness ID',
    '  --mode <shadow|enforce>           Report-only or fail-closed mode',
    '  --tolerance <n>                   D tolerance (default: config/default 1)',
    '  --report <path>                   Report path relative to repo root',
  ].join('\n'));
  process.exit(2);
}

function readArg(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const repoDir = resolve(process.cwd());
  const config = getHarnessRetentionConfig(repoDir);
  const opts: CliOptions = {
    repoDir,
    suitePath: config.suitePath || DEFAULT_HARNESS_REPLAY_SUITE_PATH,
    baselineHarnessId: config.baselineHarnessId,
    candidateHarnessId: config.candidateHarnessId,
    mode: config.mode,
    tolerance: config.tolerance,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--repo-dir':
        opts.repoDir = resolve(readArg(argv, i, arg));
        i += 1;
        break;
      case '--suite':
        opts.suitePath = readArg(argv, i, arg);
        i += 1;
        break;
      case '--baseline-harness-id':
        opts.baselineHarnessId = readArg(argv, i, arg);
        i += 1;
        break;
      case '--candidate-harness-id':
        opts.candidateHarnessId = readArg(argv, i, arg);
        i += 1;
        break;
      case '--mode': {
        const mode = readArg(argv, i, arg);
        if (mode !== 'shadow' && mode !== 'enforce') {
          throw new Error('--mode must be shadow or enforce');
        }
        opts.mode = mode;
        i += 1;
        break;
      }
      case '--tolerance':
        opts.tolerance = Number.parseInt(readArg(argv, i, arg), 10);
        if (!Number.isInteger(opts.tolerance) || opts.tolerance < 0) {
          throw new Error('--tolerance must be a non-negative integer');
        }
        i += 1;
        break;
      case '--report':
        opts.reportPath = readArg(argv, i, arg);
        i += 1;
        break;
      case '--help':
      case '-h':
        usage();
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  if (!opts.baselineHarnessId) {
    throw new Error('--baseline-harness-id is required');
  }
  if (!opts.candidateHarnessId) {
    throw new Error('--candidate-harness-id is required');
  }
  return opts;
}

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const reportPath = opts.reportPath
      ?? `${DEFAULT_HARNESS_REPLAY_REPORT_DIR}/harness-retention-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const report = await runHarnessReplayFromSuite({
      repoDir: opts.repoDir,
      suitePath: opts.suitePath,
      baselineHarnessId: opts.baselineHarnessId,
      candidateHarnessId: opts.candidateHarnessId,
      mode: opts.mode,
      tolerance: opts.tolerance,
      reportPath,
    });
    console.log(JSON.stringify({
      verdict: report.verdict,
      mode: report.mode,
      D: report.D,
      tolerance: report.tolerance,
      suiteVersion: report.suiteVersion,
      reportPath: report.reportPath,
    }, null, 2));
    if (report.mode === 'enforce' && report.verdict !== 'pass') {
      process.exit(1);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
  }
}

await main();
