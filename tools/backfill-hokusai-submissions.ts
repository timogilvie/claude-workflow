#!/usr/bin/env -S npx tsx

import { resolve } from 'node:path';
import { backfillHokusaiSubmissions } from '../shared/lib/hokusai-backfill.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

runTool({
  name: 'backfill-hokusai-submissions',
  description: 'Reconcile and re-submit Hokusai eval records (dry-run by default)',
  options: {
    since: { type: 'string', description: 'Inclusive lower bound on record date (YYYY-MM-DD)' },
    until: { type: 'string', description: 'Inclusive upper bound on record date (YYYY-MM-DD)' },
    ids: { type: 'string', description: 'Comma-separated eval record ids (overrides date range)' },
    'repo-dir': { type: 'string', description: 'Repository directory (default: cwd)' },
    'config-dir': { type: 'string', description: 'User config directory for Hokusai consent gates' },
    'promotion-manifest': { type: 'string', description: 'Reviewed model-promotion manifest for promoted-evidence backfill' },
    apply: { type: 'boolean', description: 'Actually enqueue; default is a dry run' },
  },
  examples: [
    'npx tsx tools/backfill-hokusai-submissions.ts --since 2026-08-17 --until 2026-08-18',
    'npx tsx tools/backfill-hokusai-submissions.ts --since 2026-08-17 --until 2026-08-18 --apply',
    'npx tsx tools/backfill-hokusai-submissions.ts --promotion-manifest .wavemill/model-promotions/reviewed.json',
  ],
  additionalHelp: [
    'Promoted-evidence mode:',
    '  --promotion-manifest must point at a reviewed/applied manifest with explicit eval rows and from/to identity revisions.',
    '  Dry-run is read-only. Apply writes a hash-addressed reconciliation report under .wavemill/hokusai/reconciliation before enqueueing.',
    '  Accepted provisional rows are refused until a Hokusai correction/tombstone protocol is available and acknowledged.',
    'Rollback before drain:',
    '  Remove only pending queue entries whose provenance references the reconciliationReportHash printed by apply; retain the report.',
  ].join('\n'),
  async run({ args }) {
    const promotionManifest = args['promotion-manifest'] as string | undefined;
    const summary = await backfillHokusaiSubmissions({
      repoDir: resolve((args['repo-dir'] as string | undefined) || '.'),
      configDir: args['config-dir'] ? resolve(args['config-dir'] as string) : undefined,
      since: args.since as string | undefined,
      until: args.until as string | undefined,
      ids: String(args.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      apply: args.apply === true,
      promotionManifestPath: promotionManifest ? resolve(promotionManifest) : undefined,
    });

    for (const r of summary.results) {
      console.error(`  ${r.timestamp.slice(0, 19)}  ${r.issueId.padEnd(12)} ${r.status}`);
    }
    console.error(`\nscanned=${summary.scanned} selected=${summary.selected}`);
    for (const [k, v] of Object.entries(summary.counts)) console.error(`  ${k}: ${v}`);
    if (summary.reconciliationReportHash) {
      console.error(`\nreconciliationReportHash=${summary.reconciliationReportHash}`);
    }
    if (summary.reconciliationReportPath) {
      console.error(`reconciliationReportPath=${summary.reconciliationReportPath}`);
    }
    if (!summary.applied) console.error('\nDry run: nothing enqueued. Re-run with --apply.');
    console.log(JSON.stringify({
      applied: summary.applied,
      selected: summary.selected,
      counts: summary.counts,
      reconciliationReportHash: summary.reconciliationReportHash,
      reconciliationReportPath: summary.reconciliationReportPath,
    }, null, 2));
  },
});
