import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearConfigCache } from './config.ts';
import { deepMergeConfig } from './config-sync.ts';
import { errorMessage } from './error-utils.ts';

export const HOKUSAI_CONTRIBUTION_ENDPOINT = 'https://api.hokus.ai/api/v1/contributions';
export const HOKUSAI_ENDPOINT_TOKEN_ENV = 'HOKUSAI_API_TOKEN';
export const HOKUSAI_BATCH_SIZE = 50;

export interface ConfigureContributionsOptions {
  repoDir?: string;
  endpoint?: string;
  endpointTokenEnv?: string;
  batchSize?: number;
}

export interface ConfigureContributionsResult {
  action: 'created' | 'updated' | 'unchanged';
  localConfigPath: string;
  endpoint: string;
}

function readLocalConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${errorMessage(err)}`);
  }
}

function writeLocalConfig(path: string, config: Record<string, unknown>): void {
  const tempPath = `${path}.tmp-${process.pid}`;
  writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  renameSync(tempPath, path);
}

export function configureContributionUpload(
  opts: ConfigureContributionsOptions = {},
): ConfigureContributionsResult {
  const repoDir = opts.repoDir ?? process.cwd();
  const localConfigPath = join(repoDir, '.wavemill-config.local.json');

  const endpoint = opts.endpoint ?? HOKUSAI_CONTRIBUTION_ENDPOINT;
  const endpointTokenEnv = opts.endpointTokenEnv ?? HOKUSAI_ENDPOINT_TOKEN_ENV;
  const batchSize = opts.batchSize ?? HOKUSAI_BATCH_SIZE;

  const existing = readLocalConfig(localConfigPath);
  const existed = existsSync(localConfigPath);

  const patch = {
    hokusai: {
      contributions: {
        endpoint,
        endpointTokenEnv,
        batchSize,
      },
    },
  };

  const merged = deepMergeConfig(existing, patch) as Record<string, unknown>;

  // Check if the merged result already matches existing (idempotent)
  const existingStr = JSON.stringify(existing);
  const mergedStr = JSON.stringify(merged);
  if (existed && existingStr === mergedStr) {
    return { action: 'unchanged', localConfigPath, endpoint };
  }

  writeLocalConfig(localConfigPath, merged);
  clearConfigCache(repoDir);

  return {
    action: existed ? 'updated' : 'created',
    localConfigPath,
    endpoint,
  };
}

export function ensureGitignoreEntry(repoDir: string, entry: string): 'added' | 'exists' {
  const gitignorePath = join(repoDir, '.gitignore');

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, `${entry}\n`, 'utf-8');
    return 'added';
  }

  const content = readFileSync(gitignorePath, 'utf-8');
  const lines = content.split('\n');
  if (lines.some((line) => line.trim() === entry)) {
    return 'exists';
  }

  const appended = content.endsWith('\n') ? `${content}${entry}\n` : `${content}\n${entry}\n`;
  writeFileSync(gitignorePath, appended, 'utf-8');
  return 'added';
}
