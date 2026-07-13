#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  diagnoseOpenRouter,
  formatDoctorReport,
  formatZeroTrafficWarning,
  type DoctorStage,
} from '../shared/lib/openrouter-doctor.ts';

const VALID_STAGES = new Set<DoctorStage>(['planner', 'coder', 'reviewer']);

runTool({
  name: 'openrouter-doctor',
  description: 'Report OpenRouter/router/challenge eligibility, blocking gates, and recent zero-traffic warnings.',
  options: {
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON.',
    },
    stage: {
      type: 'string',
      description: 'Limit output to one stage: planner, coder, or reviewer.',
    },
    repo: {
      type: 'string',
      description: 'Repository directory. Defaults to current working directory.',
    },
    'recent-window': {
      type: 'string',
      description: 'Number of recent eval records to inspect for zero-traffic warnings.',
    },
    strict: {
      type: 'boolean',
      description: 'Exit non-zero when alerts are present.',
    },
    'warning-only': {
      type: 'boolean',
      description: 'Print one concise warning line or nothing; always exits zero.',
    },
  },
  examples: [
    'npx tsx tools/openrouter-doctor.ts',
    'npx tsx tools/openrouter-doctor.ts --json',
    'npx tsx tools/openrouter-doctor.ts --stage coder',
    'npx tsx tools/openrouter-doctor.ts --warning-only --repo .',
  ],
  async run({ args }) {
    const repoDir = (args.repo as string | undefined) || process.cwd();
    const rawStage = args.stage as string | undefined;
    const rawRecentWindow = args['recent-window'] as string | undefined;
    const stage = rawStage?.trim();
    if (stage && !VALID_STAGES.has(stage as DoctorStage)) {
      throw new Error(`invalid --stage "${stage}". Expected planner, coder, or reviewer.`);
    }

    let recentWindow: number | undefined;
    if (rawRecentWindow !== undefined) {
      recentWindow = Number(rawRecentWindow);
      if (!Number.isInteger(recentWindow) || recentWindow <= 0) {
        throw new Error(`invalid --recent-window "${rawRecentWindow}". Expected a positive integer.`);
      }
    }

    const report = diagnoseOpenRouter({
      repoDir,
      stages: stage ? [stage as DoctorStage] : undefined,
      ...(recentWindow ? { recentWindow } : {}),
    });

    if (args['warning-only'] === true) {
      const warning = formatZeroTrafficWarning(report);
      if (warning) {
        console.log(warning);
      }
      return;
    }

    if (args.json === true) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      process.stdout.write(formatDoctorReport(report));
    }

    if (args.strict === true && report.alerts.length > 0) {
      process.exitCode = 1;
    }
  },
});
