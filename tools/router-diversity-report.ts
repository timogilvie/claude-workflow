#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  formatDiversityReport,
  generateDiversityReport,
} from '../shared/lib/router-diversity.ts';

runTool({
  name: 'router-diversity-report',
  description: 'Report model share per stage, per-model-per-stage coverage vs target, and routing-mode breakdown from eval records.',
  options: {
    'repo-dir': { type: 'string', description: 'Repository directory' },
    window: { type: 'string', description: 'Recent-record window for share and mode breakdowns (default from router.coverage.window, else 50)' },
    'min-records': { type: 'string', description: 'Coverage target per model per stage (default from router.coverage.minRecordsPerModelStage, else 15)' },
    'max-share': { type: 'string', description: 'Dominance warning threshold 0-1 (default from router.coverage.maxStageShare, else 0.7)' },
    json: { type: 'boolean', description: 'Emit the report as JSON' },
  },
  async run({ args }) {
    const parseIntOption = (value: unknown): number | undefined => {
      const parsed = Number.parseInt(String(value ?? ''), 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    };
    const parseShareOption = (value: unknown): number | undefined => {
      const parsed = Number.parseFloat(String(value ?? ''));
      return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : undefined;
    };

    const report = generateDiversityReport({
      repoDir: (args['repo-dir'] as string) || process.cwd(),
      window: parseIntOption(args.window),
      minRecordsPerModelStage: parseIntOption(args['min-records']),
      maxStageShare: parseShareOption(args['max-share']),
    });

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(formatDiversityReport(report));
  },
});
