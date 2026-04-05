#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  generatePermissions,
  getDefaultPermissionsOutputPath,
  printPermissionsApplyInstructions,
  writePermissionsOutput,
  type PermissionAgent,
} from '../shared/lib/permissions-tool.ts';

runTool({
  name: 'generate-permissions',
  description: 'Generate agent permission settings from wavemill config',
  options: {
    agent: {
      type: 'string',
      description: 'Target agent: claude or codex',
    },
    output: {
      type: 'string',
      description: 'Output file path (default depends on agent)',
    },
    stdout: {
      type: 'boolean',
      description: 'Print to stdout instead of file',
    },
  },
  examples: [
    'npx tsx tools/generate-permissions.ts --agent claude',
    'npx tsx tools/generate-permissions.ts --agent codex',
    'npx tsx tools/generate-permissions.ts --agent claude --output ./my-settings.json',
    'npx tsx tools/generate-permissions.ts --agent codex --stdout',
  ],
  run({ args }) {
    const agent = args.agent as PermissionAgent | undefined;
    if (agent !== 'claude' && agent !== 'codex') {
      throw new Error('--agent must be "claude" or "codex"');
    }

    const repoDir = process.cwd();
    const settings = generatePermissions(repoDir, agent);
    const json = JSON.stringify(settings, null, 2);

    if (args.stdout) {
      console.log(json);
      return;
    }

    const outputPath = args.output
      ? resolve(args.output)
      : getDefaultPermissionsOutputPath(repoDir, agent);
    writePermissionsOutput(outputPath, json);
    printPermissionsApplyInstructions(agent, outputPath);
  },
});
