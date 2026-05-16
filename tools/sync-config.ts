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
import { findLocalPromotionConflicts, prepareConfigSync } from '../shared/lib/config-sync.ts';

async function syncConfig(options: { yes?: boolean; dryRun?: boolean } = {}) {
  const repoDir = process.cwd();
  const prepared = prepareConfigSync(repoDir);
  const {
    additions,
    alreadyCurrent,
    backupPath,
    configExists,
    configPath,
    localConfigExists,
    localConfigPath,
    currentConfig,
    mergedConfig,
    localOverrideClassifications,
  } = prepared;

  console.log('🔧 Wavemill Config Sync');
  console.log('   Sync writes shared defaults to .wavemill-config.json only.\n');

  if (configExists) {
    console.log(`✓ Found existing .wavemill-config.json at ${configPath}`);
  } else {
    console.log(`ℹ No existing .wavemill-config.json found. Will create new one.`);
  }

  if (localConfigExists) {
    console.log(`ℹ Found .wavemill-config.local.json at ${localConfigPath}`);
    console.log('  Local overrides are read at runtime and are never modified by sync.');
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
    if (localConfigExists) {
      console.log();
      if (localOverrideClassifications.length > 0) {
        console.log('🔎 Local override classification (missing from .wavemill-config.json):\n');
        localOverrideClassifications.forEach(entry => {
          console.log(`   - ${entry.path}: ${entry.label}`);
          console.log(`     ${entry.reason}`);
        });
      } else {
        console.log('ℹ No local-only missing fields found in .wavemill-config.local.json.');
      }
      console.log();
    }
    console.log('📄 Merged config (dry-run, not written):\n');
    console.log(JSON.stringify(mergedConfig, null, 2));
    return;
  }

  const localPromotionConflicts = findLocalPromotionConflicts(prepared);
  if (localPromotionConflicts.length > 0) {
    const paths = localPromotionConflicts.map(entry => entry.path).join(', ');
    throw new Error(
      `Refusing to update .wavemill-config.json: local override path(s) require explicit decision (${paths}). ` +
        'Review .wavemill-config.local.json and .wavemill-config.json, then set shared defaults manually.',
    );
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
    throw new Error(`Failed to write config: ${errorMessage(err)}`);
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
