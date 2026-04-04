#!/usr/bin/env -S npx tsx
/**
 * Sync/upgrade .wavemill-config.json to the latest version.
 *
 * This tool:
 * 1. Loads the current config (if exists)
 * 2. Merges with the canonical template
 * 3. Preserves all user-configured values
 * 4. Adds missing sections and fields
 * 5. Updates configVersion to current
 * 6. Creates backup before modifying
 *
 * @module sync-config
 */

import { writeFileSync, copyFileSync } from 'node:fs';
import { runTool } from '../shared/lib/tool-runner.ts';
import { errorMessage } from '../shared/lib/error-utils.ts';
import { CURRENT_CONFIG_VERSION } from '../shared/lib/config.ts';
import { confirm } from '../shared/lib/cli-prompt.ts';
import { prepareConfigSync } from '../shared/lib/config-sync.ts';

async function syncConfig(options: { yes?: boolean; dryRun?: boolean } = {}) {
  const repoDir = process.cwd();
  const {
    additions,
    alreadyCurrent,
    backupPath,
    configExists,
    configPath,
    currentConfig,
    mergedConfig,
  } = prepareConfigSync(repoDir);

  console.log('🔧 Wavemill Config Sync\n');

  if (configExists) {
    console.log(`✓ Found existing config at ${configPath}`);
  } else {
    console.log(`ℹ No existing config found. Will create new one.`);
  }

  // Show summary
  console.log();
  if (additions.length > 0) {
    console.log(`📝 The following sections/fields will be added:\n`);
    additions.forEach(path => console.log(`   + ${path}`));
  } else if (alreadyCurrent) {
    console.log(`✓ Config is already up to date (version ${CURRENT_CONFIG_VERSION})`);
    console.log(`  No changes needed.`);
    return;
  } else if (configExists) {
    console.log(`✓ Updating configVersion: ${(currentConfig as { configVersion?: string }).configVersion || '(none)'} → ${CURRENT_CONFIG_VERSION}`);
  }

  console.log();

  // Dry run mode
  if (options.dryRun) {
    console.log('📄 Merged config (dry-run, not written):\n');
    console.log(JSON.stringify(mergedConfig, null, 2));
    return;
  }

  // Confirm
  if (!options.yes && configExists) {
    const approved = await confirm('Apply these changes?', { defaultYes: true });
    if (!approved) {
      console.log('Cancelled.');
      return;
    }
  }

  // Create backup if file exists
  if (configExists) {
    copyFileSync(configPath, backupPath);
    console.log(`✓ Backup created at ${backupPath}`);
  }

  // Write merged config
  try {
    writeFileSync(configPath, JSON.stringify(mergedConfig, null, 2) + '\n', 'utf-8');
    console.log(`✓ Config updated to version ${CURRENT_CONFIG_VERSION}`);
    console.log(`\n✅ Sync complete!`);

    if (configExists) {
      console.log(`   Backup: ${backupPath}`);
    }
  } catch (err) {
    console.error(`✗ Failed to write config: ${errorMessage(err)}`);
    process.exit(1);
  }
}

runTool({
  name: 'sync-config',
  description: 'Sync/upgrade .wavemill-config.json to the latest version',
  options: {
    yes: { type: 'boolean', description: 'Skip confirmation prompt' },
    'dry-run': { type: 'boolean', description: 'Show changes without writing' },
  },
  examples: [
    'npx tsx tools/sync-config.ts',
    'npx tsx tools/sync-config.ts --yes',
    'npx tsx tools/sync-config.ts --dry-run',
  ],
  async run({ args }) {
    await syncConfig({ yes: args.yes, dryRun: args['dry-run'] });
  },
});
