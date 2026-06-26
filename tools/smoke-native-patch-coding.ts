#!/usr/bin/env -S npx tsx

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { runTool } from '../shared/lib/tool-runner.ts';
import { getNativePatchCodingConfig } from '../shared/lib/config.ts';
import {
  runPatchCodingSmokeDryRun,
  runPatchCodingSmokeLive,
  type PatchCodingSmokeResult,
} from '../shared/lib/native-agent/patch-coding-smoke.ts';
import { summarizeCertification } from '../shared/lib/native-agent/patch-coding-certification.ts';

function formatText(result: PatchCodingSmokeResult): string {
  if (result.outcome === 'skipped') {
    return `SKIPPED\nReason: ${result.skipReason ?? 'provider prerequisites unavailable'}`;
  }

  const lines = ['OK'];
  if (result.certification) {
    lines.push(summarizeCertification(result.certification));
  }
  return lines.join('\n');
}

function formatJson(result: PatchCodingSmokeResult, mode: 'dry-run' | 'live'): string {
  return JSON.stringify({ mode, ...result }, null, 2);
}

runTool({
  name: 'smoke-native-patch-coding',
  description: 'Run patch coding smoke across providers and emit a certification record.',
  options: {
    'dry-run': { type: 'boolean', description: 'Run the scripted smoke without external API calls.' },
    live: { type: 'boolean', description: 'Run live provider smoke. Skips cleanly when keys are absent.' },
    output: { type: 'string', description: 'Write the certification record to this path.' },
    json: { type: 'boolean', description: 'Emit machine-readable JSON output.' },
    repo: { type: 'string', description: 'Repository directory. Defaults to the current working directory.' },
  },
  async run({ args }) {
    const repoDir = (args.repo as string | undefined) || process.cwd();
    const mode: 'dry-run' | 'live' = args.live === true ? 'live' : 'dry-run';
    const result = mode === 'live'
      ? await runPatchCodingSmokeLive({ repoDir })
      : await runPatchCodingSmokeDryRun({ repoDir });

    const configuredOutputPath = getNativePatchCodingConfig(repoDir).certificationPath;
    const outputPath = (args.output as string | undefined) ?? configuredOutputPath;
    if (outputPath && result.certification) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(result.certification, null, 2)}\n`, 'utf-8');
    }

    const output = args.json === true
      ? formatJson(result, mode)
      : formatText(result);

    if (result.outcome === 'ok') {
      console.log(output);
    } else {
      console.error(output);
    }
  },
});
