#!/usr/bin/env -S npx tsx

import { readFile } from 'node:fs/promises';
import { runTool, resolveRepoDir } from '../shared/lib/tool-runner.ts';
// Thin CLI over the pure shared/lib/openrouter-alias-audit module (Thin Tools Pattern).
import {
  auditRegistryAgainstCatalog,
  auditRegistryAliasResolution,
  listNativeOpenRouterRegistryModels,
  renderAliasAuditReport,
  type AliasAuditReport,
} from '../shared/lib/openrouter-alias-audit.ts';
import { fetchOpenRouterModels, type OpenRouterApiResponse, type OpenRouterModel } from '../shared/lib/openrouter-catalog.ts';

/**
 * Load a saved `{data:[...]}` OpenRouter models response from disk so the CLI
 * can run deterministically without hitting the network.
 */
async function loadCatalogFile(path: string): Promise<Map<string, OpenRouterModel>> {
  const raw = await readFile(path, 'utf-8');
  const parsed = JSON.parse(raw) as OpenRouterApiResponse;
  if (!parsed || !Array.isArray(parsed.data)) {
    throw new Error(`Catalog file ${path} is missing a "data" array`);
  }
  const map = new Map<string, OpenRouterModel>();
  for (const model of parsed.data) {
    if (model && typeof model.id === 'string' && model.id.length > 0) {
      map.set(model.id, model);
    }
  }
  return map;
}

runTool({
  name: 'audit-openrouter-aliases',
  description: 'Audit native-openrouter registry aliases against their wire identity and the live OpenRouter catalog.',
  options: {
    json: { type: 'boolean', description: 'Emit machine-readable JSON instead of the human-readable report.' },
    offline: { type: 'boolean', description: 'Skip the live catalog fetch; run offline alias-resolution checks only.' },
    'catalog-file': { type: 'string', description: 'Path to a saved {data:[...]} OpenRouter models response for deterministic runs.' },
    'repo-dir': { type: 'string', description: 'Repository directory (defaults to cwd).' },
  },
  examples: [
    'npx tsx tools/audit-openrouter-aliases.ts',
    'npx tsx tools/audit-openrouter-aliases.ts --json',
    'npx tsx tools/audit-openrouter-aliases.ts --offline',
    'npx tsx tools/audit-openrouter-aliases.ts --catalog-file .wavemill/openrouter-models.json',
  ],
  async run({ args }) {
    const offline = args.offline === true;
    const catalogFile = args['catalog-file'] as string | undefined;
    const asJson = args.json === true;
    // repo-dir is accepted for consistency with other tools but the audit reads
    // the global registry, so it only affects path resolution helpers.
    void resolveRepoDir(args['repo-dir'] as string | undefined);

    if (offline && catalogFile) {
      console.error('Error: --offline and --catalog-file are mutually exclusive');
      process.exit(2);
    }

    try {
      let report: AliasAuditReport;
      if (offline) {
        const findings = auditRegistryAliasResolution();
        const auditedModels = listNativeOpenRouterRegistryModels();
        report = {
          auditedAt: new Date().toISOString(),
          catalogSize: null,
          auditedModels,
          findings,
          selectableFindingCount: findings.filter((f) => f.selectable).length,
        };
      } else {
        const catalog = catalogFile
          ? await loadCatalogFile(catalogFile)
          : await fetchOpenRouterModels();
        report = auditRegistryAgainstCatalog(catalog);
      }

      const output = asJson ? JSON.stringify(report, null, 2) : renderAliasAuditReport(report);
      console.log(output);
      process.exit(report.selectableFindingCount > 0 ? 1 : 0);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
  },
});
