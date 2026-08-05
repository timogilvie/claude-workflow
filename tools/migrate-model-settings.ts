#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { confirm } from '../shared/lib/cli-prompt.ts';
import { migrateModelSettings } from '../shared/lib/model-settings-migrator.ts';

function printHuman(report: ReturnType<typeof migrateModelSettings>): void {
  console.log('Wavemill model-settings migration');
  console.log(`Repo: ${report.repoDir}`);
  console.log(`Mode: ${report.dryRun ? 'dry-run' : 'write'}`);
  console.log();

  if (report.inventory.length === 0 && !report.localCertificationDir) {
    console.log('No removed repo-local model settings found.');
  } else {
    for (const item of report.inventory) {
      console.log(`- ${item.file}:${item.path}`);
      console.log(`  ${item.summary}`);
      if (item.modelIds.length > 0) {
        console.log(`  Models/ids: ${item.modelIds.slice(0, 20).join(', ')}${item.modelIds.length > 20 ? '...' : ''}`);
      }
    }
    if (report.localCertificationDir) {
      console.log(`- ${report.localCertificationDir}`);
      console.log('  Repo-local certification directory found. Runtime certification lookup now uses the global store only.');
    }
  }

  if (report.duplicateKeys.length > 0) {
    console.log();
    console.log('Duplicate JSON keys detected (last value was preserved by JSON parsing):');
    for (const warning of report.duplicateKeys) {
      console.log(`- ${warning.file}:${warning.path}.${warning.key}`);
    }
  }

  console.log();
  console.log(`Effective pools: planner=${report.effectivePools.planner}, coder=${report.effectivePools.coder}, reviewer=${report.effectivePools.reviewer}`);
  if (report.dryRun) {
    console.log('Dry run only; no files were changed.');
  } else if (report.changed) {
    for (const backup of report.backups) {
      console.log(`Backup: ${backup}`);
    }
    for (const file of report.migratedFiles) {
      console.log(`Migrated: ${file}`);
    }
  } else {
    console.log('No file changes needed.');
  }
}

await runTool({
  name: 'migrate-model-settings',
  description: 'Remove deprecated repo-local model membership settings from Wavemill config',
  options: {
    'dry-run': { type: 'boolean', description: 'Inventory and validate without changing files' },
    json: { type: 'boolean', description: 'Print the structured migration report as JSON' },
    yes: { type: 'boolean', short: 'y', description: 'Skip confirmation before writing' },
    'repo-dir': { type: 'string', description: 'Repository directory to migrate' },
    'ack-missing-cert': { type: 'string', multiple: true, description: 'Comma-separated model IDs whose local cert metadata is allowed to be removed before global publication' },
  },
  examples: [
    'wavemill config migrate-model-settings --dry-run',
    'wavemill config migrate-model-settings --yes',
  ],
  async run({ args }) {
    const dryRun = args['dry-run'] === true;
    const repoDir = args['repo-dir'] || process.cwd();
    const ackMissingCerts = (args['ack-missing-cert'] ?? []).flatMap((value) => value.split(',').filter(Boolean));
    const preview = migrateModelSettings({
      repoDir,
      dryRun: true,
      ackMissingCerts,
    });
    if (!dryRun && args.yes !== true && preview.changed) {
      printHuman(preview);
      const approved = await confirm('Remove these repo-local model settings?', { defaultYes: false });
      if (!approved) {
        console.log('Cancelled.');
        return;
      }
    }

    const report = dryRun
      ? preview
      : migrateModelSettings({
        repoDir,
        dryRun: false,
        ackMissingCerts,
      });
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else if (dryRun || args.yes || !preview.changed) {
      printHuman(report);
    }
  },
});
