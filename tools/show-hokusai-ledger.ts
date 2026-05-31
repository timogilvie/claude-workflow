#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  listRewardLedgerEntries,
  summarizeRewardLedger,
  type HokusaiRewardLedgerStatus,
} from '../shared/lib/hokusai-reward-ledger.ts';

const ALLOWED_STATUSES = new Set<HokusaiRewardLedgerStatus>(['pending', 'accepted', 'rejected']);

runTool({
  name: 'show-hokusai-ledger',
  description: 'Inspect the local Hokusai contribution reward ledger.',
  options: {
    json: { type: 'boolean', description: 'Output JSON instead of a text summary' },
    status: { type: 'string', description: 'Filter entries by status: pending, accepted, or rejected' },
    'repo-dir': { type: 'string', description: 'Override the repo directory used to locate .wavemill/hokusai' },
    'config-dir': { type: 'string', description: 'Override the user config directory (defaults to ~/.wavemill)' },
  },
  examples: [
    'npx tsx tools/show-hokusai-ledger.ts',
    'npx tsx tools/show-hokusai-ledger.ts --json',
    'npx tsx tools/show-hokusai-ledger.ts --status pending',
  ],
  run({ args }) {
    const statusFilter = args.status as HokusaiRewardLedgerStatus | undefined;
    if (statusFilter && !ALLOWED_STATUSES.has(statusFilter)) {
      throw new Error(`Invalid --status value "${statusFilter}". Expected pending, accepted, or rejected.`);
    }

    const options = {
      repoDir: args['repo-dir'],
      configDir: args['config-dir'],
    };

    if (args.json) {
      const payload = statusFilter
        ? listRewardLedgerEntries({ ...options, status: statusFilter })
        : summarizeRewardLedger(options);
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    if (statusFilter) {
      const listed = listRewardLedgerEntries({ ...options, status: statusFilter });
      if (listed.status === 'disabled') {
        console.log('Hokusai contribution ledger is disabled.');
        return;
      }
      if (listed.status === 'corrupt_state') {
        throw new Error(listed.error ?? 'Reward ledger state is corrupt');
      }
      console.log(`Hokusai reward ledger (${statusFilter}): ${listed.entries.length} entr${listed.entries.length === 1 ? 'y' : 'ies'}`);
      for (const entry of listed.entries) {
        console.log(`${entry.contributionId} ${entry.status} rows=${entry.rowCount} tokens=${entry.tokenAmount ?? 'pending'} jobs=${entry.hokusaiJobIds.join(',') || '-'}`);
      }
      return;
    }

    const summary = summarizeRewardLedger(options);
    if (summary.status === 'disabled') {
      console.log('Hokusai contribution ledger is disabled.');
      return;
    }
    if (summary.status === 'corrupt_state') {
      throw new Error(summary.error ?? 'Reward ledger state is corrupt');
    }

    console.log('Hokusai reward ledger');
    console.log(`entries: ${summary.entryCount}`);
    console.log(`pending: ${summary.pendingCount}`);
    console.log(`accepted: ${summary.acceptedCount}`);
    console.log(`rejected: ${summary.rejectedCount}`);
    console.log(`tokens: ${summary.totalTokenAmount}`);
  },
});
