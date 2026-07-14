#!/usr/bin/env -S npx tsx

import { diagnoseOpenRouter, renderOpenRouterDoctorReport, type OpenRouterDoctorStage } from '../shared/lib/openrouter-doctor.ts';
import { resolveRepoDir, runTool } from '../shared/lib/tool-runner.ts';

function parseStage(value: string | undefined): OpenRouterDoctorStage | undefined {
  if (!value) {
    return undefined;
  }
  if (value === 'planner' || value === 'coder' || value === 'reviewer') {
    return value;
  }
  throw new Error(`invalid stage "${value}" (expected planner, coder, or reviewer)`);
}

runTool({
  name: 'openrouter-doctor',
  description: 'Inspect OpenRouter/native routing eligibility and zero-traffic warnings.',
  options: {
    json: { type: 'boolean', description: 'Emit machine-readable JSON.' },
    stage: { type: 'string', description: 'Limit output to planner, coder, or reviewer.' },
    'repo-dir': { type: 'string', description: 'Repository directory to inspect.' },
    lookback: { type: 'string', description: 'Recent selection lookback window (default: 20).' },
  },
  examples: [
    'npx tsx tools/openrouter-doctor.ts',
    'npx tsx tools/openrouter-doctor.ts --json --repo-dir ~/src/wavemill',
    'npx tsx tools/openrouter-doctor.ts --stage coder --lookback 50',
  ],
  async run({ args }) {
    const repoDir = resolveRepoDir(args['repo-dir'] as string | undefined);
    const lookbackRaw = args.lookback as string | undefined;
    const lookback = typeof lookbackRaw === 'string' && lookbackRaw.trim().length > 0
      ? Number.parseInt(lookbackRaw, 10)
      : 20;

    if (!Number.isInteger(lookback) || lookback <= 0) {
      console.error('Error: --lookback must be a positive integer');
      process.exit(2);
    }

    try {
      const report = diagnoseOpenRouter({
        repoDir,
        stage: parseStage(args.stage as string | undefined),
        lookback,
      });
      const hasBlockedModel = report.models.some((model) => model.eligibleStages.length === 0);
      const output = args.json === true
        ? JSON.stringify(report, null, 2)
        : renderOpenRouterDoctorReport(report);
      console.log(output);
      process.exit(hasBlockedModel ? 1 : 0);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
  },
});
