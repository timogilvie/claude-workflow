#!/usr/bin/env npx tsx

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { errorMessage } from '../shared/lib/error-utils.ts';
import {
  loadLaunchPriorityList,
  normalizeCatalog,
  type CatalogSyncResult,
  type OpenRouterApiModel,
} from '../shared/lib/openrouter-catalog.ts';
import { runTool } from '../shared/lib/tool-runner.ts';

interface OpenRouterModelsResponse {
  data: OpenRouterApiModel[];
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, sortJsonValue(nestedValue)]),
  );
}

function stringifyCatalog(result: CatalogSyncResult): string {
  return JSON.stringify(sortJsonValue(result), null, 2);
}

runTool({
  name: 'sync-openrouter-catalog',
  description: 'Fetch and normalize the launch-priority OpenRouter model catalog',
  options: {
    output: { type: 'string', description: 'Path to write the normalized JSON snapshot (required unless --dry-run)' },
    fixture: { type: 'string', description: 'Override the launch-priority fixture path' },
    'dry-run': { type: 'boolean', description: 'Print the snapshot to stdout instead of writing to disk' },
  },
  examples: [
    'npx tsx tools/sync-openrouter-catalog.ts --output .wavemill/hokusai/openrouter-catalog.json',
    'npx tsx tools/sync-openrouter-catalog.ts --dry-run',
  ],
  async run({ args }) {
    if (!args['dry-run'] && (typeof args.output !== 'string' || args.output.length === 0)) {
      throw new Error('--output is required (unless using --dry-run)');
    }

    const response = await fetch('https://openrouter.ai/api/v1/models');
    if (!response.ok) {
      throw new Error(`OpenRouter models request failed: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json() as OpenRouterModelsResponse;
    if (!payload || !Array.isArray(payload.data)) {
      throw new Error('OpenRouter models response did not include a data array');
    }

    const fixturePath = typeof args.fixture === 'string' && args.fixture.length > 0
      ? resolve(args.fixture)
      : undefined;
    const priorityList = loadLaunchPriorityList(fixturePath);
    const result = normalizeCatalog(priorityList, payload.data, {
      snapshotAt: new Date().toISOString(),
      sourceUrl: 'https://openrouter.ai/api/v1/models',
    });
    const serialized = stringifyCatalog(result);

    if (args['dry-run']) {
      console.log(serialized);
    } else {
      const outputPath = resolve(args.output);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${serialized}\n`, 'utf-8');
      console.error(`Wrote ${result.entries.length} catalog entries and ${result.blockers.length} blockers to ${outputPath}`);
    }

    if (result.blockers.length > 0) {
      const reasonSummary = result.blockers
        .map((blocker) => `${blocker.openrouterId}:${blocker.reason}`)
        .join(', ');
      console.error(`⚠️  Catalog has unresolved models: ${reasonSummary}`);
      process.exitCode = 1;
    }
  },
}).catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
