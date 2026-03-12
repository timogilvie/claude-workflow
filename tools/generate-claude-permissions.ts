#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  generatePermissions,
  getDefaultPermissionsOutputPath,
  printPermissionsApplyInstructions,
  writePermissionsOutput,
} from '../shared/lib/permissions-tool.ts';

runTool({
  name: 'generate-claude-permissions',
  description: 'Generate Claude Code permission settings from wavemill config',
  options: {
    output: {
      type: 'string',
      description: 'Output file path (default: .wavemill/claude-permissions.json)'
    },
    stdout: {
      type: 'boolean',
      description: 'Print to stdout instead of file'
    },
  },
  examples: [
    '# Generate to default location',
    'npx tsx tools/generate-claude-permissions.ts',
    '',
    '# Generate to custom location',
    'npx tsx tools/generate-claude-permissions.ts --output ./my-settings.json',
    '',
    '# Print to stdout',
    'npx tsx tools/generate-claude-permissions.ts --stdout',
  ],
  run({ args }) {
    const repoDir = process.cwd();
    const settings = generatePermissions(repoDir, 'claude');
    const json = JSON.stringify(settings, null, 2);

    if (args.stdout) {
      console.log(json);
    } else {
      const outputPath = args.output || getDefaultPermissionsOutputPath(repoDir, 'claude');
      writePermissionsOutput(outputPath, json);
      printPermissionsApplyInstructions('claude', outputPath);
    }
  },
});
