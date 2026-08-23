#!/usr/bin/env node
/** Thin CLI wrapper for the shadow-mode task packet scorer. */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  TaskPacketNotFoundError,
  extractTaskPacketFeaturesFromPath,
} from '../src/evaluation/scorers/task-packet-feature-extractor.ts';
import { scoreTaskPacket } from '../src/evaluation/scorers/task-packet-scorer.ts';

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8');
  await rename(temporary, destination);
}

runTool({
  name: 'score-task-packet', description: 'Score an expanded task packet without changing dispatch.',
  positional: { name: 'packet-path-or-dir', description: 'Task packet file or artifact directory', required: true },
  options: {
    'repo-dir': { type: 'string', description: 'Repository path for deterministic layer-1 checks' },
    output: { type: 'string', description: 'Optional JSON output file' },
    features: { type: 'boolean', description: 'Include the extracted feature vector' },
    quiet: { type: 'boolean', description: 'Reserved for shell integration; output remains JSON only' },
  },
  async run({ args, positional }) {
    const input = positional[0];
    try {
      const features = await extractTaskPacketFeaturesFromPath(input, { repoDir: args['repo-dir'] });
      const result = scoreTaskPacket(features);
      const output = args.features ? { ...result, features } : result;
      if (args.output) await writeJsonAtomically(args.output, output);
      process.stdout.write(`${JSON.stringify(output)}\n`);
    } catch (error) {
      if (error instanceof TaskPacketNotFoundError) {
        process.stderr.write(`Error: ${error.message}\n`); process.exitCode = 1; return;
      }
      process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2;
    }
  },
});
