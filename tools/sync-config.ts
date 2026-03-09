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
 * Usage:
 *   npx tsx tools/sync-config.ts [--yes] [--dry-run]
 *
 * Options:
 *   --yes      Skip confirmation prompt
 *   --dry-run  Show changes without writing
 */

import { writeFileSync, copyFileSync } from 'node:fs';
import { errorMessage } from '../shared/lib/error-utils.ts';
import { CURRENT_CONFIG_VERSION } from '../shared/lib/config.ts';
import { prepareConfigSync } from '../shared/lib/config-sync.ts';

function showHelp(): void {
  console.log(`Sync/upgrade .wavemill-config.json to the latest version.

Usage:
  npx tsx tools/sync-config.ts [--yes] [--dry-run]

Options:
  --yes      Skip confirmation prompt
  --dry-run  Show changes without writing
  -h, --help Show this help message`);
}

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
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await rl.question('Apply these changes? [Y/n] ');
    rl.close();

    if (answer.toLowerCase() === 'n') {
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

// Main
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  showHelp();
  process.exit(0);
}
const yes = args.includes('--yes');
const dryRun = args.includes('--dry-run');

syncConfig({ yes, dryRun }).catch(err => {
  console.error(`Error: ${errorMessage(err)}`);
  process.exit(1);
});
