#!/usr/bin/env -S npx tsx

import { resolve } from 'node:path';
import { backfillHokusaiSubmissions } from '../shared/lib/hokusai-backfill.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

runTool({
  name: 'backfill-hokusai-submissions',
  description: 'Re-submit eval records whose Hokusai enqueue was skipped (dry-run by default)',
  options: {
    since: { type: 'string', description: 'Inclusive lower bound on record date (YYYY-MM-DD)' },
    until: { type: 'string', description: 'Inclusive upper bound on record date (YYYY-MM-DD)' },
    ids: { type: 'string', description: 'Comma-separated eval record ids (overrides date range)' },
    'repo-dir': { type: 'string', description: 'Repository directory (default: cwd)' },
    apply: { type: 'boolean', description: 'Actually enqueue; default is a dry run' },
  },
  examples: [
    'npx tsx tools/backfill-hokusai-submissions.ts --since 2026-08-17 --until 2026-08-18',
    'npx tsx tools/backfill-hokusai-submissions.ts --since 2026-08-17 --until 2026-08-18 --apply',
  ],
  async run({ args }) {
    const summary = await backfillHokusaiSubmissions({
      repoDir: resolve((args['repo-dir'] as string | undefined) || '.'),
      since: args.since as string | undefined,
      until: args.until as string | undefined,
      ids: String(args.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      apply: args.apply === true,
    });

    for (const r of summary.results) {
      console.error(`  ${r.timestamp.slice(0, 19)}  ${r.issueId.padEnd(12)} ${r.status}`);
    }
    console.error(`\nscanned=${summary.scanned} selected=${summary.selected}`);
    for (const [k, v] of Object.entries(summary.counts)) console.error(`  ${k}: ${v}`);
    if (!summary.applied) console.error('\nDry run: nothing enqueued. Re-run with --apply.');
    console.log(JSON.stringify({ applied: summary.applied, selected: summary.selected, counts: summary.counts }, null, 2));
  },
});
