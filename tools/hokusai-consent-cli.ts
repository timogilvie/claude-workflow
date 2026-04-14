#!/usr/bin/env -S npx tsx
/**
 * CLI for managing Hokusai data submission consent.
 *
 * Subcommands:
 * - enable:  Enable data submission (shows consent prompt)
 * - disable: Disable data submission
 * - status:  Show current consent state
 * - check:   Non-interactive consent check (returns "true" or "false")
 *
 * @module hokusai-consent-cli
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  promptConsent,
  recordConsent,
  checkConsentQuiet,
  loadUserConfig,
  isConsentValid,
  revokeConsent,
  enableRepoSubmission,
  disableRepoSubmission,
} from '../shared/lib/hokusai-consent.ts';
import { loadWavemillConfig } from '../shared/lib/config.ts';
import { errorMessage } from '../shared/lib/error-utils.ts';

runTool({
  name: 'hokusai-consent-cli',
  description: 'Manage Hokusai data submission consent',
  options: {
    quiet: { type: 'boolean', description: 'Suppress output (used by mill)' },
  },
  examples: [
    'npx tsx tools/hokusai-consent-cli.ts enable',
    'npx tsx tools/hokusai-consent-cli.ts disable',
    'npx tsx tools/hokusai-consent-cli.ts status',
    'npx tsx tools/hokusai-consent-cli.ts check --quiet',
  ],
  async run({ positional, args }) {
    const subcommand = positional[0];
    const quiet = args.quiet as boolean;

    try {
      switch (subcommand) {
        case 'enable':
          await handleEnable();
          break;

        case 'disable':
          await handleDisable();
          break;

        case 'status':
          await handleStatus();
          break;

        case 'check':
          await handleCheck(quiet);
          break;

        default:
          console.error(`Unknown subcommand: ${subcommand}`);
          console.error('Usage: hokusai-consent-cli <enable|disable|status|check>');
          process.exitCode = 1;
      }
    } catch (err) {
      const message = errorMessage(err);
      console.error(`Error: ${message}`);
      process.exitCode = 1;
    }
  },
});

/**
 * Enable data submission (interactive with consent prompt)
 * Sets enabled: true in repo config and records consent in user config
 */
async function handleEnable(): Promise<void> {
  console.log('Enabling Hokusai data submission...\n');

  // Check if already enabled with valid consent
  const userConfig = await loadUserConfig();
  const repoConfig = loadWavemillConfig();
  if (
    repoConfig.hokusai?.dataSubmission?.enabled &&
    isConsentValid(userConfig, repoConfig.hokusai?.dataSubmission?.consentVersion ?? '1.0')
  ) {
    console.log('✓ Already enabled with valid consent.');
    return;
  }

  // Get repo consent version
  const repoConsentVersion = repoConfig.hokusai?.dataSubmission?.consentVersion ?? '1.0';

  // Show consent prompt
  const accepted = await promptConsent();

  if (accepted) {
    // Record consent in user config
    await recordConsent(repoConsentVersion);
    // Enable in repo config
    enableRepoSubmission();
    console.log('\n✓ Data submission enabled. Thank you for contributing!');
  } else {
    console.log('\n✗ Data submission not enabled (consent declined).');
  }
}

/**
 * Disable data submission
 * Sets enabled: false in repo config and clears consent in user config
 */
async function handleDisable(): Promise<void> {
  // Check if already disabled
  const repoConfig = loadWavemillConfig();
  const userConfig = await loadUserConfig();

  if (
    !repoConfig.hokusai?.dataSubmission?.enabled &&
    !userConfig.hokusai?.dataSubmission?.enabled
  ) {
    console.log('Already disabled.');
    return;
  }

  // Revoke user consent
  await revokeConsent();
  // Disable in repo config
  disableRepoSubmission();

  console.log('✓ Data submission disabled.');
  console.log('  You can re-enable with: wavemill hokusai enable');
}

/**
 * Show current consent state
 */
async function handleStatus(): Promise<void> {
  const userConfig = await loadUserConfig();
  const repoConfig = loadWavemillConfig();
  const submission = userConfig.hokusai?.dataSubmission;
  const repoVersion = repoConfig.hokusai?.dataSubmission?.consentVersion ?? '1.0';

  console.log('Hokusai Data Submission Status:\n');

  if (!submission || !submission.enabled) {
    console.log('  Status:   Disabled');
    console.log('  To enable, run: wavemill hokusai enable');
  } else {
    console.log('  Status:         Enabled');
    console.log(`  Consented at:   ${submission.consentedAt || 'unknown'}`);
    console.log(`  Consent version: ${submission.consentVersion || 'unknown'}`);
    console.log(`  Required version: ${repoVersion}`);

    const isValid = isConsentValid(userConfig, repoVersion);
    console.log(`  Valid:          ${isValid ? 'Yes' : 'No (re-consent may be needed)'}`);
  }

  console.log('\nTo disable, run: wavemill hokusai disable');
}

/**
 * Non-interactive consent check (for mill workflow)
 * Outputs "true" or "false" to stdout
 */
async function handleCheck(quiet: boolean): Promise<void> {
  const isValid = await checkConsentQuiet();

  // Always output result for shell script consumption
  // (checkConsentQuiet already suppresses warnings internally)
  console.log(isValid ? 'true' : 'false');

  process.exitCode = isValid ? 0 : 1;
}
