#!/usr/bin/env -S npx tsx
import { runTool } from '../shared/lib/tool-runner.ts';
import {
  checkClaudeSettings,
  checkCodexSettings,
  formatValidationResult,
  getPatternSummary,
  validatePermissionsConfig,
} from '../shared/lib/permissions-verifier.ts';

runTool({
  name: 'verify-permissions',
  description: 'Verify permission configuration',
  options: {
    agent: { type: 'string', description: 'Check specific agent (claude|codex)' },
    verbose: { type: 'boolean', short: 'v', description: 'Show detailed output' },
  },
  examples: [
    'npx tsx tools/verify-permissions.ts',
    'npx tsx tools/verify-permissions.ts --agent claude',
    'npx tsx tools/verify-permissions.ts --verbose',
  ],
  additionalHelp: `Validates that permission patterns are configured correctly and
checks if they match expected agent settings.`,
  run({ args }) {
    if (args.agent && args.agent !== 'claude' && args.agent !== 'codex') {
      throw new Error(`Invalid agent: ${args.agent}. Must be 'claude' or 'codex'`);
    }

    const repoDir = process.cwd();
    const verbose = !!args.verbose;

    console.log('🔍 Verifying Permission Configuration');

    const configResult = validatePermissionsConfig(repoDir, verbose);
    console.log(formatValidationResult(configResult, 'Configuration Validation'));

    if (args.agent === 'claude') {
      const claudeResult = checkClaudeSettings(verbose);
      console.log(formatValidationResult(claudeResult, 'Claude Code Settings'));
    } else if (args.agent === 'codex') {
      const codexResult = checkCodexSettings(verbose);
      console.log(formatValidationResult(codexResult, 'Codex Settings'));
    }

    if (verbose) {
      console.log(getPatternSummary(verbose).join('\n'));
    }

    if (!configResult.valid) {
      throw new Error('Validation failed');
    }

    console.log('\n✅ Verification complete');
  },
});
