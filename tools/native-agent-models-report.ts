#!/usr/bin/env -S npx tsx

/**
 * native-agent-models-report — list certification status for native-capable models.
 *
 * Reads purely from the model registry and on-disk certification artifacts.
 * Never triggers a paid live provider run.
 *
 * Exit codes:
 *   0 — successful listing (even with uncertified/stale rows)
 *   2 — invalid input (unknown option or argument)
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  buildModelCertificationReport,
  serializeReport,
  renderReportTable,
} from '../shared/lib/native-agent/certification/report.ts';

runTool({
  name: 'native-agent-models-report',
  description: 'List certification status, phase eligibility, suite version, age, and known limitations for all native-capable models.',
  options: {
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON.',
    },
    provider: {
      type: 'string',
      description: 'Filter by provider (e.g. openai, openrouter).',
    },
    model: {
      type: 'string',
      description: 'Filter by model ID.',
    },
    repo: {
      type: 'string',
      description: 'Repository directory. Defaults to current working directory.',
    },
  },
  examples: [
    'npx tsx tools/native-agent-models-report.ts',
    'npx tsx tools/native-agent-models-report.ts --json',
    'npx tsx tools/native-agent-models-report.ts --provider openai',
    'npx tsx tools/native-agent-models-report.ts --model gpt-4o --json',
  ],
  async run({ args }) {
    const repoDir = (args.repo as string | undefined) || process.cwd();

    const rows = buildModelCertificationReport({
      repoDir,
      provider: args.provider as string | undefined,
      model: args.model as string | undefined,
    });

    if (args.json === true) {
      console.log(JSON.stringify(serializeReport(rows), null, 2));
    } else {
      process.stdout.write(renderReportTable(rows));
    }
  },
});
