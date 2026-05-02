#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { runDryRunSmoke, runLiveSmoke, type DeepSeekSmokeResult } from '../shared/lib/deepseek-smoke.ts';

interface CliResult {
  dryRun: DeepSeekSmokeResult;
  live?: DeepSeekSmokeResult;
}

function parseTimeout(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  const match = /^(\d+)(ms|s)?$/i.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid --timeout value "${value}". Use an integer like 30000, 500ms, or 30s.`);
  }

  const amount = Number(match[1]);
  const unit = (match[2] || 'ms').toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid --timeout value "${value}". Timeout must be greater than zero.`);
  }

  return unit === 's' ? amount * 1000 : amount;
}

function shouldRunLive(args: Record<string, unknown>): boolean {
  return args.live === true && args['no-live'] !== true;
}

function formatText(result: CliResult): string {
  const lines: string[] = [];
  const allResults = [result.dryRun, result.live].filter(Boolean) as DeepSeekSmokeResult[];

  for (const item of allResults) {
    lines.push(`${item.mode}: ${item.summary}`);
    for (const check of item.checks) {
      lines.push(`- ${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.details}`);
    }
  }

  return lines.join('\n');
}

function formatJson(result: CliResult): string {
  return JSON.stringify({
    ok: result.dryRun.ok && (result.live?.ok ?? true),
    dryRun: result.dryRun,
    ...(result.live ? { live: result.live } : {}),
  }, null, 2);
}

runTool({
  name: 'smoke-deepseek',
  description: 'Validate DeepSeek launcher wiring with a dry-run and optional live Claude prompt.',
  options: {
    live: { type: 'boolean', description: 'Run the optional live prompt after the dry-run passes.' },
    'no-live': { type: 'boolean', description: 'Force dry-run only, even if --live is also provided.' },
    json: { type: 'boolean', description: 'Emit machine-readable JSON output.' },
    timeout: { type: 'string', description: 'Live timeout in milliseconds or seconds (e.g. 30000, 500ms, 30s).' },
    repo: { type: 'string', description: 'Repository directory to validate. Defaults to the current working directory.' },
  },
  async run({ args }) {
    const repoDir = (args.repo as string | undefined) || process.cwd();
    const timeoutMs = parseTimeout(args.timeout as string | undefined);

    const dryRun = runDryRunSmoke({ repoDir });
    let live: DeepSeekSmokeResult | undefined;

    if (dryRun.ok && shouldRunLive(args)) {
      live = runLiveSmoke({ repoDir, timeoutMs });
    }

    const result = { dryRun, ...(live ? { live } : {}) };
    const output = args.json === true ? formatJson(result) : formatText(result);

    if (args.json === true || (dryRun.ok && (live?.ok ?? true))) {
      console.log(output);
    } else {
      console.error(output);
    }

    if (!dryRun.ok) {
      process.exit(dryRun.exitCode || 1);
    }
    if (live && !live.ok) {
      process.exit(live.exitCode || 1);
    }
  },
});
