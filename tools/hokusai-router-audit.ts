#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  formatHokusaiAuditReport,
  runHokusaiRouterAudit,
} from '../shared/lib/hokusai-router-audit.ts';

function parsePositiveInt(value: unknown): number | undefined {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePositiveFloat(value: unknown): number | undefined {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

runTool({
  name: 'hokusai-router-audit',
  description: 'Replay eval corpus records through Hokusai Model 30 and report routing spread and correctness.',
  options: {
    'repo-dir': { type: 'string', description: 'Repository directory' },
    sample: { type: 'string', description: 'Stratified sample size (default: 100)' },
    concurrency: { type: 'string', description: 'Concurrent API requests, capped at 8 (default: 3)' },
    endpoint: { type: 'string', description: 'Override Hokusai Model 30 endpoint' },
    output: { type: 'string', description: 'JSON artifact output path (default: .wavemill/evals/hokusai-audit-<timestamp>.json)' },
    timeout: { type: 'string', description: 'Per-request timeout in milliseconds' },
    'max-share': { type: 'string', description: 'Hard-failure dominance threshold 0-1 (default from router.coverage.maxStageShare)' },
    'k-neighbors': { type: 'string', description: 'Nearest neighbors for hindsight regret (default: 20)' },
    'token-env': { type: 'string', description: 'Read Hokusai API token from this environment variable' },
    'dry-run': { type: 'boolean', description: 'Build requests and artifact without calling the API' },
    json: { type: 'boolean', description: 'Emit JSON report to stdout' },
    redact: { type: 'boolean', description: 'Redact task descriptions before sending (default)' },
    'no-redact': { type: 'boolean', description: 'Send original task descriptions to the API' },
  },
  examples: [
    'npx tsx tools/hokusai-router-audit.ts --dry-run --sample 10',
    'npx tsx tools/hokusai-router-audit.ts --sample 100 --concurrency 3',
  ],
  async run({ args }) {
    const tokenEnv = args['token-env'] ? process.env[String(args['token-env'])] : undefined;
    const report = await runHokusaiRouterAudit({
      repoDir: (args['repo-dir'] as string) || process.cwd(),
      sample: parsePositiveInt(args.sample),
      concurrency: parsePositiveInt(args.concurrency),
      endpoint: args.endpoint as string | undefined,
      output: args.output as string | undefined,
      timeoutMs: parsePositiveInt(args.timeout),
      maxShare: parsePositiveFloat(args['max-share']),
      kNeighbors: parsePositiveInt(args['k-neighbors']),
      token: tokenEnv,
      dryRun: Boolean(args['dry-run']),
      redact: args['no-redact'] ? false : true,
    });

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatHokusaiAuditReport(report));
    }

    if (report.hardFailures.length > 0) {
      process.exitCode = 1;
    }
  },
});
