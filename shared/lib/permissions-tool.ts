import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getPermissionsConfig, type PermissionsConfig, type WorktreeModeConfig } from './config.ts';
import { getDefaultPatterns } from './permission-patterns.ts';

export type PermissionAgent = 'claude' | 'codex';

interface CommonPermissionData {
  patterns: string[];
  worktreeMode?: WorktreeModeConfig;
}

interface ClaudePermissions {
  'claudeCode.autoApprove': {
    bash?: string[];
    read?: string[];
    write?: string[];
    edit?: string[];
  };
}

interface CodexPermissions {
  autoApprovePatterns: string[];
  worktreeMode?: WorktreeModeConfig;
}

function getCommonPermissionData(repoDir: string): CommonPermissionData {
  const permissionsConfig: PermissionsConfig = getPermissionsConfig(repoDir);
  let patterns = permissionsConfig.autoApprovePatterns || [];

  if (
    permissionsConfig.worktreeMode?.enabled &&
    permissionsConfig.worktreeMode?.autoApproveReadOnly
  ) {
    patterns = [...new Set([...patterns, ...getDefaultPatterns()])];
  }

  return {
    patterns,
    worktreeMode: permissionsConfig.worktreeMode,
  };
}

export function getDefaultPermissionsOutputPath(repoDir: string, agent: PermissionAgent): string {
  return resolve(
    repoDir,
    agent === 'claude'
      ? '.wavemill/claude-permissions.json'
      : '.wavemill/codex-permissions.json',
  );
}

export function generatePermissions(repoDir: string, agent: PermissionAgent): ClaudePermissions | CodexPermissions {
  const data = getCommonPermissionData(repoDir);

  if (agent === 'claude') {
    return {
      'claudeCode.autoApprove': {
        bash: data.patterns,
      },
    };
  }

  return {
    autoApprovePatterns: data.patterns,
    worktreeMode: data.worktreeMode,
  };
}

export function writePermissionsOutput(outputPath: string, json: string): void {
  const outputDir = dirname(outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  writeFileSync(outputPath, `${json}\n`, 'utf-8');
}

export function printPermissionsApplyInstructions(agent: PermissionAgent, outputPath: string): void {
  if (agent === 'claude') {
    console.log(`Generated Claude Code settings at: ${outputPath}`);
    console.log('');
    console.log('To apply:');
    console.log('1. Open Claude Code settings (Cmd+, or Ctrl+,)');
    console.log('2. Navigate to "Extensions" -> "Claude Code" -> "Tool Permissions"');
    console.log('3. Click "Import Settings"');
    console.log(`4. Select: ${outputPath}`);
    console.log('5. Click "Apply"');
    console.log('6. Restart Claude Code');
    console.log('');
    console.log('Or manually copy to Claude Code settings file:');
    console.log('  macOS: ~/Library/Application Support/Claude Code/User/settings.json');
    console.log('  Linux: ~/.config/Claude Code/User/settings.json');
    console.log('  Windows: %APPDATA%\\Claude Code\\User\\settings.json');
    console.log('');
    console.log('See docs/worktree-auto-approve.md for detailed instructions.');
    return;
  }

  console.log(`Generated Codex settings at: ${outputPath}`);
  console.log('');
  console.log('To apply:');
  console.log('1. Copy to ~/.codex/permissions.json');
  console.log('2. Restart Codex');
  console.log('');
  console.log('See docs/worktree-auto-approve.md for detailed instructions.');
}
