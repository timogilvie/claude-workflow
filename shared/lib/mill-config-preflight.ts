import { resolve } from 'node:path';
import { loadWavemillConfig } from './config.ts';
import {
  type RemovedModelSettingInventoryItem,
  scanForbiddenModelSettings,
} from './model-settings-migrator.ts';
import {
  evaluateSuiteCoverage,
  type SuiteCoverageResult,
} from './native-agent/certification/coverage.ts';

export const MILL_CONFIG_MIGRATION_COMMAND = 'wavemill config migrate-model-settings';

export interface MillConfigPreflightReport {
  repoDir: string;
  removedFields: RemovedModelSettingInventoryItem[];
  validationError: string | null;
  migrationCommand: string;
  certificationCoverage?: SuiteCoverageResult;
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

  const certificationCoverage = process.env.WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD === '1'
    ? undefined
    : evaluateSuiteCoverage({ repoDir: absRepoDir });
  const certificationCoverageBlocked = certificationCoverage?.status === 'bump-without-publish';

  const report: MillConfigPreflightReport = {
    repoDir: absRepoDir,
    removedFields,
    validationError,
    migrationCommand: MILL_CONFIG_MIGRATION_COMMAND,
    ...(certificationCoverage ? { certificationCoverage } : {}),
  };

  return {
    ok: removedFields.length === 0 && validationError === null && !certificationCoverageBlocked,
    report,
  };
}

export function formatMillConfigPreflightReport(report: MillConfigPreflightReport): string {
  const lines = [
    'Mill preflight failed.',
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

  if (report.certificationCoverage?.status === 'bump-without-publish') {
    const coverage = report.certificationCoverage;
    const otherSuites = Object.entries(coverage.artifactCountByOtherSuite)
      .map(([suiteVersion, count]) => `${count} ${suiteVersion}`)
      .join(', ');
    lines.push(
      '',
      'Native certification suite coverage:',
      `  ERROR: certificationSuiteVersion is '${coverage.requiredSuiteVersion}' but the global store (${coverage.root}) has 0 matching artifacts${otherSuites ? ` (${otherSuites} found)` : ''}.`,
      '  The suite version was bumped without republishing the matrix.',
      `  Run: ${coverage.remediationCommand}`,
      '  To skip only this guard, set WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD=1.',
    );
  }

  if (report.removedFields.length > 0 || report.validationError) {
    lines.push(
      '',
      'Run the migration once from the repository root:',
      `  ${report.migrationCommand}`,
      '',
      'Preview first with:',
      `  ${report.migrationCommand} --dry-run`,
    );
  }

  return lines.join('\n');
}
