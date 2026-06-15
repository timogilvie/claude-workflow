#!/usr/bin/env -S npx tsx
/**
 * Sync the OpenRouter launch-priority model catalog.
 *
 * Fetches model metadata from the OpenRouter public API, joins it against
 * the static launch-priority list (HOK-2211), normalizes the data, and
 * writes a deterministic snapshot artifact to disk.
 *
 * Exit code is non-zero if any tier-1 active model is blocked (e.g.
 * missing from OpenRouter), so this can be wired into CI as a gate.
 *
 * @module sync-openrouter-catalog
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  buildCatalogSnapshot,
  fetchOpenRouterModels,
  hashLaunchPriorityFixture,
  hasTier1ActiveBlockers,
  loadLaunchPriorityFixture,
  normalizeCatalog,
  serializeSnapshot,
} from '../shared/lib/openrouter-catalog.ts';

const DEFAULT_OUTPUT_PATH = '.wavemill/openrouter-catalog-snapshot.json';

runTool({
  name: 'sync-openrouter-catalog',
  description: 'Fetch OpenRouter model catalog and write a normalized snapshot',
  options: {
    fixture: {
      type: 'string',
      description: 'Path to launch-priority fixture (defaults to bundled fixture)',
    },
    output: {
      type: 'string',
      description: `Snapshot output path (default: ${DEFAULT_OUTPUT_PATH})`,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Print snapshot to stdout instead of writing to disk',
    },
  },
  examples: [
    'npx tsx tools/sync-openrouter-catalog.ts',
    'npx tsx tools/sync-openrouter-catalog.ts --output .wavemill/catalog.json',
    'npx tsx tools/sync-openrouter-catalog.ts --dry-run',
  ],
  async run({ args }) {
    const fixturePath = args.fixture ? resolve(args.fixture) : undefined;
    const outputPath = resolve(args.output ?? DEFAULT_OUTPUT_PATH);

    const fixture = loadLaunchPriorityFixture(fixturePath);
    const sourceHash = hashLaunchPriorityFixture(fixturePath);

    console.error(`📡 Fetching OpenRouter model catalog…`);
    const orModels = await fetchOpenRouterModels();
    console.error(`   Fetched ${orModels.size} OpenRouter models`);

    const { entries, blockers } = normalizeCatalog(fixture.models, orModels);
    const snapshot = buildCatalogSnapshot(entries, blockers, sourceHash);
    const serialized = serializeSnapshot(snapshot);

    if (blockers.length > 0) {
      console.error(`\n⚠️  ${blockers.length} blocker(s):`);
      for (const b of blockers) {
        console.error(
          `   [tier${b.priorityTier} ${b.status}] ${b.wavemillAlias} (${b.openrouterId}) — ${b.reason}: ${b.detail}`,
        );
      }
    }

    console.error(`\n✓ Normalized ${entries.length} active/watchlist entries`);

    if (args['dry-run']) {
      process.stdout.write(serialized);
    } else {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, serialized, 'utf-8');
      console.error(`✓ Snapshot written to ${outputPath}`);
    }

    if (hasTier1ActiveBlockers(blockers)) {
      console.error('\n❌ Tier-1 active models are blocked. Failing.');
      process.exitCode = 1;
    }
  },
});
