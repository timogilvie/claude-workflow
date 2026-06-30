#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  buildModelReport,
  formatModelReportText,
} from '../shared/lib/native-agent/certification/model-report.ts';

if (import.meta.main) {
  runTool({
    name: 'native-agent-models-report',
    description: 'Report certification status, phase eligibility, suite version, age, and known limitations for all known native-agent models. Makes no paid API calls.',
    options: {
      repo: {
        type: 'string',
        description: 'Repository directory. Defaults to current working directory.',
      },
      json: {
        type: 'boolean',
        description: 'Emit machine-readable JSON instead of the human-readable table.',
      },
    },
    examples: [
      'npx tsx tools/native-agent-models-report.ts',
      'npx tsx tools/native-agent-models-report.ts --json',
      'npx tsx tools/native-agent-models-report.ts --repo /path/to/repo --json',
    ],
    async run({ args }) {
      const repoDir = (args.repo as string | undefined) ?? process.cwd();
      const report = buildModelReport(repoDir);

      if (args.json === true) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatModelReportText(report));
      }
    },
  });
}
