import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { getPermissionsConfig } from './config.ts';
import {
  isSafePattern,
  getDefaultPatterns,
  getCategoryNames,
  getPatternsByCategory,
} from './permission-patterns.ts';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  info: string[];
}

function createValidationResult(): ValidationResult {
  return {
    valid: true,
    errors: [],
    warnings: [],
    info: [],
  };
}

export function validatePermissionsConfig(repoDir: string, verbose: boolean): ValidationResult {
  const result = createValidationResult();
  const permissionsConfig = getPermissionsConfig(repoDir);

  if (!permissionsConfig.autoApprovePatterns && !permissionsConfig.worktreeMode) {
    result.warnings.push('No permissions configured in .wavemill-config.json');
    result.info.push('Add a "permissions" section to enable auto-approval');
    return result;
  }

  const patterns = permissionsConfig.autoApprovePatterns || [];

  if (patterns.length === 0 && !permissionsConfig.worktreeMode?.autoApproveReadOnly) {
    result.warnings.push('No auto-approve patterns configured');
    result.info.push('Add patterns to "permissions.autoApprovePatterns" or enable worktreeMode.autoApproveReadOnly');
  }

  if (verbose) {
    result.info.push(`Found ${patterns.length} custom pattern(s)`);
  }

  const unsafePatterns = patterns.filter((pattern) => !isSafePattern(pattern));
  if (unsafePatterns.length > 0) {
    result.valid = false;
    result.errors.push(`Unsafe patterns detected (${unsafePatterns.length}):`);
    for (const pattern of unsafePatterns) {
      result.errors.push(`  - ${pattern}`);
    }
    result.info.push('Remove unsafe patterns or make them more specific');
  }

  if (permissionsConfig.worktreeMode) {
    if (verbose) {
      result.info.push(`Worktree mode: ${permissionsConfig.worktreeMode.enabled ? 'enabled' : 'disabled'}`);
      result.info.push(`Auto-approve read-only: ${permissionsConfig.worktreeMode.autoApproveReadOnly ? 'yes' : 'no'}`);
    }

    if (permissionsConfig.worktreeMode.autoApproveReadOnly && verbose) {
      result.info.push(`Will auto-approve ${getDefaultPatterns().length} default read-only patterns`);
    }
  }

  return result;
}

export function checkClaudeSettings(verbose: boolean): ValidationResult {
  const result = createValidationResult();
  const settingsPath = resolve(homedir(), 'Library/Application Support/Claude Code/User/settings.json');

  if (!existsSync(settingsPath)) {
    result.warnings.push('Claude Code settings file not found');
    result.info.push(`Expected at: ${settingsPath}`);
    result.info.push('Run: npx tsx tools/generate-claude-permissions.ts');
    return result;
  }

  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const autoApprove = settings['claudeCode.autoApprove'];

    if (!autoApprove) {
      result.warnings.push('No auto-approve settings found in Claude Code');
      result.info.push('Run: npx tsx tools/generate-claude-permissions.ts');
      return result;
    }

    if (verbose) {
      const bashPatterns = autoApprove.bash || [];
      result.info.push(`Claude Code has ${bashPatterns.length} bash auto-approve pattern(s)`);
    }

    result.info.push('✓ Claude Code settings appear configured');
  } catch (error) {
    result.valid = false;
    result.errors.push(`Failed to read Claude Code settings: ${(error as Error).message}`);
  }

  return result;
}

export function checkCodexSettings(verbose: boolean): ValidationResult {
  const result = createValidationResult();
  const settingsPath = resolve(homedir(), '.codex/permissions.json');

  if (!existsSync(settingsPath)) {
    result.warnings.push('Codex permissions file not found');
    result.info.push(`Expected at: ${settingsPath}`);
    result.info.push('Run: npx tsx tools/generate-codex-permissions.ts');
    return result;
  }

  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    if (!settings.autoApprovePatterns) {
      result.warnings.push('No auto-approve patterns found in Codex');
      result.info.push('Run: npx tsx tools/generate-codex-permissions.ts');
      return result;
    }

    if (verbose) {
      result.info.push(`Codex has ${settings.autoApprovePatterns.length} auto-approve pattern(s)`);
    }

    result.info.push('✓ Codex settings appear configured');
  } catch (error) {
    result.valid = false;
    result.errors.push(`Failed to read Codex settings: ${(error as Error).message}`);
  }

  return result;
}

export function formatValidationResult(result: ValidationResult, label: string): string {
  const lines = [`\n${label}:`, '─'.repeat(60)];

  if (result.errors.length > 0) {
    lines.push('\n❌ Errors:');
    for (const error of result.errors) {
      lines.push(`  ${error}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push('\n⚠️  Warnings:');
    for (const warning of result.warnings) {
      lines.push(`  ${warning}`);
    }
  }

  if (result.info.length > 0) {
    lines.push('\nℹ️  Info:');
    for (const info of result.info) {
      lines.push(`  ${info}`);
    }
  }

  if (result.valid && result.errors.length === 0 && result.warnings.length === 0) {
    lines.push('\n✅ All checks passed');
  }

  return lines.join('\n');
}

export function getPatternSummary(verbose: boolean): string[] {
  const lines = ['\nDefault Pattern Categories:', '─'.repeat(60)];

  for (const category of getCategoryNames()) {
    const patterns = getPatternsByCategory(category);
    lines.push(`\n${category} (${patterns.length} patterns):`);

    if (verbose) {
      for (const pattern of patterns.slice(0, 5)) {
        lines.push(`  - ${pattern}`);
      }
      if (patterns.length > 5) {
        lines.push(`  ... and ${patterns.length - 5} more`);
      }
    }
  }

  return lines;
}
