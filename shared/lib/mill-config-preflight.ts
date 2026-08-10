import { resolve } from 'node:path';
import { loadWavemillConfig } from './config.ts';
import {
  type RemovedModelSettingInventoryItem,
  scanForbiddenModelSettings,
} from './model-settings-migrator.ts';

export const MILL_CONFIG_MIGRATION_COMMAND = 'wavemill config migrate-model-settings';

export interface MillConfigPreflightReport {
  repoDir: string;
  removedFields: RemovedModelSettingInventoryItem[];
  validationError: string | null;
  migrationCommand: string;
}

export interface MillConfigPreflightResult {
  ok: boolean;
  report: MillConfigPreflightReport;
}

export interface MillConfigPreflightOptions {
  json?: boolean;
}

function validationMessage(err: unknown): string | null {
  if (!(err instanceof Error)) {
    return null;
  }
  if (!err.message.startsWith('Config validation failed:')) {
    return null;
  }
  return err.message;
}

export function runMillConfigPreflight(
  repoDir: string,
  _options: MillConfigPreflightOptions = {},
): MillConfigPreflightResult {
  const absRepoDir = resolve(repoDir);
  const removedFields = scanForbiddenModelSettings(absRepoDir);
  let validationError: string | null = null;

  try {
    loadWavemillConfig(absRepoDir);
  } catch (err) {
    const message = validationMessage(err);
    if (!message) {
      throw err;
    }
    validationError = message;
  }

  const report: MillConfigPreflightReport = {
    repoDir: absRepoDir,
    removedFields,
    validationError,
    migrationCommand: MILL_CONFIG_MIGRATION_COMMAND,
  };

  return {
    ok: removedFields.length === 0 && validationError === null,
    report,
  };
}

export function formatMillConfigPreflightReport(report: MillConfigPreflightReport): string {
  const lines = [
    'Mill preflight failed - repo-local model configuration still present.',
    '',
    `Repository: ${report.repoDir}`,
  ];

  if (report.removedFields.length > 0) {
    lines.push('', 'Removed repo-local model fields:');
    for (const item of report.removedFields) {
      const modelList = item.modelIds.length > 0 ? ` models=${item.modelIds.join(',')}` : '';
      lines.push(`  ${item.file}: ${item.path} - ${item.summary}${modelList}`);
    }
  }

  if (report.validationError) {
    lines.push('', 'TypeScript config validation error:', report.validationError);
  }

  lines.push(
    '',
    'Run the migration once from the repository root:',
    `  ${report.migrationCommand}`,
    '',
    'Preview first with:',
    `  ${report.migrationCommand} --dry-run`,
  );

  return lines.join('\n');
}
