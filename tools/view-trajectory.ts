#!/usr/bin/env -S npx tsx

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  projectTrajectory,
  readTrajectoryFile,
  renderTrajectoryHtml,
} from '../shared/lib/native-agent/trajectory-viewer.ts';
import { SessionStreamParseError } from '../shared/lib/native-agent/session-stream.schema.ts';

export function runViewTrajectoryCommand(argv = process.argv.slice(2)): Promise<void> {
  return runTool({
    name: 'view-trajectory',
    description: 'Render a searchable HTML trajectory projection from canonical native session events.',
    options: {
      input: { type: 'string', description: 'Path to a session events JSONL file.' },
      output: { type: 'string', description: 'Output HTML path. Defaults to <input>.trajectory.html.' },
      stdout: { type: 'boolean', description: 'Write HTML or JSON to stdout.' },
      json: { type: 'boolean', description: 'Emit the trajectory projection as JSON instead of HTML.' },
      title: { type: 'string', description: 'Custom page title.' },
    },
    positional: {
      name: 'input',
      description: 'Path to a session events JSONL file.',
      required: false,
    },
    examples: [
      'npx tsx tools/view-trajectory.ts .wavemill/session-events/session.jsonl',
      'npx tsx tools/view-trajectory.ts --input session.jsonl --output trajectory.html',
      'npx tsx tools/view-trajectory.ts session.jsonl --json --stdout',
    ],
    async run({ args, positional }) {
      const inputArg = (args.input as string | undefined) ?? positional[0];
      if (!inputArg) {
        console.error('Missing required input JSONL path.');
        process.exit(2);
      }

      const inputPath = resolve(inputArg);
      try {
        const projection = projectTrajectory(readTrajectoryFile(inputPath));
        const rendered = args.json === true
          ? `${JSON.stringify(projection, null, 2)}\n`
          : renderTrajectoryHtml(projection, { title: args.title as string | undefined });

        if (args.stdout === true) {
          process.stdout.write(rendered);
        } else if (args.json === true) {
          process.stdout.write(rendered);
        } else {
          const outputPath = resolve(args.output as string | undefined ?? defaultOutputPath(inputPath));
          writeFileSync(outputPath, rendered, 'utf8');
          console.error(`Wrote ${outputPath}`);
        }

        console.error(`${projection.totalEvents} events, ${projection.totalSteps} steps, ${projection.turns} turns`);
      } catch (error) {
        if (error instanceof SessionStreamParseError) {
          console.error(`${error.message} (line ${error.lineNumber})`);
          process.exit(3);
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Unable to render trajectory from ${inputPath}: ${message}`);
        process.exit(2);
      }
    },
  }, argv);
}

function defaultOutputPath(inputPath: string): string {
  const dir = dirname(inputPath);
  const file = inputPath.split(/[\\/]/).pop() ?? 'session.jsonl';
  return resolve(dir, `${file}.trajectory.html`);
}

if (import.meta.main) {
  await runViewTrajectoryCommand();
}
