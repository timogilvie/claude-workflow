#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  generatePermissions,
  getDefaultPermissionsOutputPath,
  printPermissionsApplyInstructions,
  writePermissionsOutput,
} from '../shared/lib/permissions-tool.ts';

runTool({
  name: 'generate-codex-permissions',
  description: 'Generate Codex permission settings from wavemill config',
  options: {
    output: { type: 'string', description: 'Output file path' },
    stdout: { type: 'boolean', description: 'Print to stdout instead of file' },
  },
  examples: [
    '# Generate to default location',
    'npx tsx tools/generate-codex-permissions.ts',
    '',
    '# Generate to custom location',
    'npx tsx tools/generate-codex-permissions.ts --output ./my-settings.json',
    '',
    '# Print to stdout',
    'npx tsx tools/generate-codex-permissions.ts --stdout',
  ],
  run({ args }) {
    const repoDir = process.cwd();
    const settings = generatePermissions(repoDir, 'codex');
    const json = JSON.stringify(settings, null, 2);

    if (args.stdout) {
      console.log(json);
    } else {
      const outputPath = args.output || getDefaultPermissionsOutputPath(repoDir, 'codex');
      writePermissionsOutput(outputPath, json);
      printPermissionsApplyInstructions('codex', outputPath);
    }
  },
});
