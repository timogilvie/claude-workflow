#!/usr/bin/env -S npx tsx
/**
 * Check Soft Gates
 *
 * Detects inconsistencies between normalized task artifacts and existing
 * workflow artifacts, then emits structured warnings to
 * .wavemill/logs/soft-gates.jsonl. Always exits 0 — observability only.
 *
 * Usage:
 *   npx tsx tools/check-soft-gates.ts [taskId]
 *   npx tsx tools/check-soft-gates.ts --slug <slug>
 *   npx tsx tools/check-soft-gates.ts --feature-dir <path>
 *   npx tsx tools/check-soft-gates.ts --json
 *   npx tsx tools/check-soft-gates.ts --no-emit
 *
 * @module check-soft-gates
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import { evaluateSoftGates, emitSoftGates, type SoftGateWarning } from '../shared/lib/soft-gates.ts';

runTool({
  name: 'check-soft-gates',
  description: 'Detect artifact inconsistencies and emit non-blocking soft-gate warnings',
  positional: {
    name: 'taskId',
    description: 'Optional Linear task ID (e.g. HOK-1234) to scope the check',
    required: false,
  },
  options: {
    repo: {
      type: 'string',
      description: 'Repository root directory (default: current working directory)',
    },
    'feature-dir': {
      type: 'string',
      description: 'Direct path to the feature directory (overrides slug/taskId resolution)',
    },
    slug: {
      type: 'string',
      description: 'Feature slug to resolve the feature directory',
    },
    json: {
      type: 'boolean',
      description: 'Print warnings as JSON array instead of human-readable output',
    },
    'no-emit': {
      type: 'boolean',
      description: 'Detect only — do not write to log or persist dedup fingerprints',
    },
  },
  examples: [
    'npx tsx tools/check-soft-gates.ts HOK-1234',
    'npx tsx tools/check-soft-gates.ts --slug my-feature-slug',
    'npx tsx tools/check-soft-gates.ts --feature-dir features/my-feature',
    'npx tsx tools/check-soft-gates.ts --json',
    'npx tsx tools/check-soft-gates.ts --no-emit',
  ],
  async run({ args, positional }) {
    const taskId = positional[0] as string | undefined;
    const repoDir = (args['repo'] as string | undefined) ?? process.cwd();
    const featureDir = args['feature-dir'] as string | undefined;
    const slug = args['slug'] as string | undefined;
    const asJson = args['json'] === true;
    const noEmit = args['no-emit'] === true;

    let warnings: SoftGateWarning[] = [];
    try {
      warnings = evaluateSoftGates({ repoDir, taskId, slug, featureDir });
    } catch {
      // best-effort
    }

    if (asJson) {
      console.log(JSON.stringify(warnings, null, 2));
      return;
    }

    // Human-readable summary (emit will also print grep lines)
    const identity = taskId ?? slug ?? featureDir ?? 'current feature';
    console.log(`\nSoft-Gate Check — ${identity}`);
    console.log(`Generated: ${new Date().toISOString()}`);
    console.log();

    if (warnings.length === 0) {
      console.log('No soft-gate warnings detected.');
      return;
    }

    const bySeverity = { error: 0, warn: 0, info: 0 };
    for (const w of warnings) {
      bySeverity[w.severity] = (bySeverity[w.severity] ?? 0) + 1;
    }
    console.log(`${warnings.length} warning(s): ${bySeverity.error} error, ${bySeverity.warn} warn, ${bySeverity.info} info`);
    console.log();

    try {
      const result = await emitSoftGates(warnings, { repoDir, noEmit });
      if (!noEmit) {
        console.log(`\n${result.written} warning(s) written, ${result.suppressed} suppressed (already seen).`);
        console.log(`Log: .wavemill/logs/soft-gates.jsonl`);
      } else {
        console.log(`(--no-emit: ${warnings.length} warning(s) detected, nothing written)`);
      }
    } catch {
      // best-effort
    }
  },
});
