/**
 * Score a task packet for readiness.
 *
 * Usage:
 *   npx tsx tools/score-task-packet.ts <path>
 *   npx tsx tools/score-task-packet.ts /path/to/packet.md --output result.json
 *   npx tsx tools/score-task-packet.ts /path/to/dir --title "Task Name"
 */

import { readFileSync } from 'node:fs';
import { runTool } from '../shared/lib/tool-runner.ts';
import { extractTaskPacketFeatures, TaskPacketNotFoundError } from '../src/evaluation/scorers/wavemill/task-packet-feature-extractor.ts';
import { scoreTaskPacket } from '../src/evaluation/scorers/wavemill/task-packet-scorer.ts';

runTool({
  name: 'score-task-packet',
  description: 'Score a task packet for readiness',
  async run({ flags, positional, args }) {
    const pathArg = positional[0];

    if (!pathArg) {
      console.error('Error: Task packet path required as first argument');
      process.exit(1);
    }

    const title = (flags.title as string) || '';
    const outputFile = (flags.output as string) || '';
    const includeFeatures = flags['include-features'] || false;
    const repoDir = (flags['repo-dir'] as string) || process.cwd();

    let packetText = '';

    try {
      const features = extractTaskPacketFeatures(pathArg, { title, repoDir });

      // Try to read the raw packet text for feature context
      try {
        if (pathArg.endsWith('.md')) {
          packetText = readFileSync(pathArg, 'utf-8');
        }
      } catch {
        // If we can't read text, that's ok - we still have features
      }

      const result = scoreTaskPacket(features, { text: packetText });

      // Add features if requested
      const output = includeFeatures ? { ...result, features } : result;

      const resultJson = JSON.stringify(output);

      if (outputFile) {
        const fs = require('node:fs');
        fs.writeFileSync(outputFile, resultJson);
        console.error(`[score-task-packet] Result written to ${outputFile}`);
      } else {
        console.log(resultJson);
      }

      process.exit(0);
    } catch (err) {
      if (err instanceof TaskPacketNotFoundError) {
        console.error(`Error: Task packet not found at path: ${pathArg}`);
      } else {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    }
  },
});
