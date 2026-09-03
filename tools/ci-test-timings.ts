/**
 * ci-test-timings - Merge CI timing artifacts into the weights manifest and
 * report aggregator durations (HOK-2939).
 *
 * Subcommands:
 *
 *   collect <timing.json...>  Merge >=3 timing artifacts per suite (downloaded
 *                             with `gh run download` or produced locally via
 *                             the runners' --timing-out) into
 *                             tests/ci-test-weights.json as per-test medians.
 *                             Refuses under-sampled input unless --allow-fewer.
 *
 *   report <run-id...>        For each CI run, print per-job durations and the
 *                             workflow-created -> "Shell and Unit Tests"
 *                             completion duration, plus median/p90 across runs
 *                             (the REQ-F6 measurement). Requires `gh`.
 *
 * Examples:
 *   npx tsx tools/ci-test-timings.ts collect artifacts/timing-*.json
 *   npx tsx tools/ci-test-timings.ts collect --allow-fewer local/unit-1.json
 *   npx tsx tools/ci-test-timings.ts report 33665710870 33664879422
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { execArgvCommand } from '../shared/lib/shell-utils.ts';
import { loadWeightsManifest, WEIGHTS_MANIFEST_PATH } from '../shared/lib/shard-balance.ts';
import {
  parseTimingDoc,
  collectWeights,
  serializeManifest,
  summarizeRuns,
  formatReport,
  type RunRecord,
} from '../shared/lib/ci-test-timings.ts';

function fetchRun(runId: string): RunRecord {
  const result = execArgvCommand('gh', ['run', 'view', runId, '--json', 'createdAt,jobs'], {
    timeout: 60_000,
    encoding: 'utf8',
  });
  if (result.exitCode !== 0) {
    throw new Error(`gh run view ${runId} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  const parsed = JSON.parse(result.stdout) as { createdAt: string; jobs: RunRecord['jobs'] };
  return { runId, createdAt: parsed.createdAt, jobs: parsed.jobs };
}

runTool({
  name: 'ci-test-timings',
  description: 'Merge CI timing artifacts into tests/ci-test-weights.json and report run durations',
  options: {
    manifest: { type: 'string', description: `Manifest path to write for collect (default: ${WEIGHTS_MANIFEST_PATH})` },
    'allow-fewer': { type: 'boolean', description: 'collect: allow fewer than 3 samples per test (bootstrap only)' },
    'default-ms': { type: 'string', description: 'collect: defaultMs for unmeasured tests (default: keep existing manifest value)' },
  },
  positional: { name: 'inputs', description: 'collect|report followed by timing files or run ids', multiple: true, required: true },
  examples: [
    'npx tsx tools/ci-test-timings.ts collect artifacts/timing-*.json',
    'npx tsx tools/ci-test-timings.ts report 33665710870 33664879422 33663802971',
  ],
  async run({ args, positional }) {
    const [subcommand, ...inputs] = positional;

    if (subcommand === 'collect') {
      if (inputs.length === 0) {
        throw new Error('collect: pass at least one timing artifact JSON file');
      }
      const manifestPath = args.manifest ?? join(process.cwd(), WEIGHTS_MANIFEST_PATH);
      let defaultMs = args['default-ms'] !== undefined ? Number(args['default-ms']) : undefined;
      if (defaultMs === undefined) {
        try {
          defaultMs = loadWeightsManifest(manifestPath).defaultMs;
        } catch {
          defaultMs = 30_000;
        }
      }
      const docs = inputs.map((file) => parseTimingDoc(readFileSync(file, 'utf8'), file));
      if (args['allow-fewer']) {
        console.warn('ci-test-timings: --allow-fewer set: writing a manifest from LIMITED samples; refresh from >=3 CI runs before relying on it.');
      }
      const manifest = collectWeights(docs, {
        defaultMs,
        allowFewer: Boolean(args['allow-fewer']),
      });
      writeFileSync(manifestPath, serializeManifest(manifest));
      const suiteCounts = Object.entries(manifest.suites)
        .map(([suite, weights]) => `${suite}:${Object.keys(weights).length}`)
        .join(' ');
      console.log(`ci-test-timings: wrote ${manifestPath} (${suiteCounts}; ${manifest.sources.length} source runs)`);
      return;
    }

    if (subcommand === 'report') {
      if (inputs.length === 0) {
        throw new Error('report: pass at least one CI run id');
      }
      const runs = inputs.map((runId) => fetchRun(runId));
      console.log(formatReport(summarizeRuns(runs)));
      return;
    }

    throw new Error(`unknown subcommand "${subcommand ?? ''}" (expected collect or report)`);
  },
});
