import {
  detectVerificationDrift,
  formatVerificationDriftReport,
  type VerificationDriftInput,
  type VerificationDriftReport,
} from './ci-verification-drift-detector.ts';
import type { PrePrVerificationConfigSchema } from './config.ts';

export interface VerificationDriftValidationResult {
  passed: boolean;
  report: VerificationDriftReport;
  warnings: string[];
  errors: string[];
}

export function validateVerificationDrift(
  input: VerificationDriftInput,
): VerificationDriftValidationResult {
  const config = input.config ?? {};
  const report = detectVerificationDrift(input);
  const validation = config.driftValidation ?? {};
  const enabled = validation.enabled ?? config.source === 'github-enforced';

  if (!enabled) {
    return {
      passed: true,
      report,
      warnings: [],
      errors: [],
    };
  }

  const warnings: string[] = [];
  const errors: string[] = [];
  const blockOnUnmapped = validation.blockOnUnmapped ?? false;
  const warnOnDrift = validation.warnOnDrift ?? true;

  for (const finding of report.findings) {
    if (finding.type === 'aligned') continue;

    const message = `${finding.checkName}: ${finding.reason}`;
    const blockableMappingDrift =
      finding.type === 'unmapped-check' ||
      finding.type === 'workflow-uncovered';
    const blocking =
      finding.type === 'metadata-unavailable' ||
      (
        finding.severity === 'error' &&
        ((blockOnUnmapped && blockableMappingDrift) || finding.type === 'recipe-missing')
      );

    if (blocking) {
      errors.push(message);
    } else if (warnOnDrift || finding.severity === 'warning') {
      warnings.push(message);
    }
  }

  return {
    passed: errors.length === 0,
    report,
    warnings,
    errors,
  };
}

export function reportDriftViolations(
  result: VerificationDriftValidationResult,
  options: { proposeMapping?: boolean } = {},
): string {
  const lines: string[] = [formatVerificationDriftReport(result.report, options)];

  if (result.errors.length > 0) {
    lines.push('');
    lines.push('Blocking drift violations:');
    for (const error of result.errors) {
      lines.push(`  - ${error}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push('');
    lines.push('Drift warnings:');
    for (const warning of result.warnings) {
      lines.push(`  - ${warning}`);
    }
  }

  return lines.join('\n');
}

export function isDriftValidationEnabled(config: PrePrVerificationConfigSchema | undefined): boolean {
  if (!config?.enabled) return false;
  return config.driftValidation?.enabled ?? config.source === 'github-enforced';
}
