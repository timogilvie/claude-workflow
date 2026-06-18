import { mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { join, resolve, normalize } from 'node:path';
import { homedir } from 'node:os';
import { getOpenRouterProviderConfig } from './config.ts';
import { readDotEnvFile } from './env-file.ts';
import { OPENROUTER_BASE_URL, isOpenRouterModel, resolveOpenRouterModelId } from './openrouter-provider.ts';

const DEFAULT_API_KEY_ENV = 'OPENROUTER_API_KEY';
const DEFAULT_MODEL = 'qwen-3-coder';
const WAVEMILL_AGENT_KIND = 'claude-openrouter';
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export class MissingOpenRouterApiKeyError extends Error {
  constructor(envVarName: string) {
    super(
      `Missing OpenRouter API key: environment variable ${envVarName} is not set or empty. ` +
      `Export ${envVarName} before launching a claude-openrouter agent.`,
    );
    this.name = 'MissingOpenRouterApiKeyError';
  }
}

export class InvalidPathSegmentError extends Error {
  constructor(field: string, value: string) {
    super(`Invalid ${field} path segment '${value}': must match [A-Za-z0-9._-]+.`);
    this.name = 'InvalidPathSegmentError';
  }
}

export class UnsafeStateDirError extends Error {
  constructor(dir: string) {
    super(`Refusing to use '${dir}' as claude-openrouter state directory because it resolves to or under ~/.claude.`);
    this.name = 'UnsafeStateDirError';
  }
}

export interface BuildOpenRouterLauncherEnvOptions {
  repoDir?: string;
  session: string;
  issue: string;
  model?: string;
  processEnv?: Record<string, string | undefined>;
}

export interface OpenRouterLauncherEnv {
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_AUTH_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_MODEL: string;
  ANTHROPIC_DEFAULT_OPUS_MODEL: string;
  ANTHROPIC_DEFAULT_SONNET_MODEL: string;
  ANTHROPIC_DEFAULT_HAIKU_MODEL: string;
  CLAUDE_CODE_EFFORT_LEVEL: string;
  CLAUDE_CONFIG_DIR: string;
  HOME: string;
  XDG_CONFIG_HOME: string;
  XDG_DATA_HOME: string;
  WAVEMILL_AGENT_KIND: string;
  WAVEMILL_OPENROUTER_STATE_DIR: string;
}

function validateSegment(field: string, value: string): void {
  if (!value || !SAFE_SEGMENT_RE.test(value)) {
    throw new InvalidPathSegmentError(field, value);
  }
}

function assertNotUnderRealClaudeHome(dir: string): void {
  const realClaudeHome = resolve(homedir(), '.claude');
  const normalized = normalize(resolve(dir));
  if (normalized === realClaudeHome || normalized.startsWith(realClaudeHome + '/')) {
    throw new UnsafeStateDirError(dir);
  }
}

export function resolveOpenRouterLauncherStateDir(
  repoDir: string,
  session: string,
  issue: string,
): string {
  validateSegment('session', session);
  validateSegment('issue', issue);
  const stateDir = join(resolve(repoDir), '.wavemill', 'openrouter-state', `${session}-${issue}`);
  assertNotUnderRealClaudeHome(stateDir);
  return stateDir;
}

function resolveApiKey(
  apiKeyEnv: string,
  processEnv: Record<string, string | undefined>,
  repoDir: string,
): string {
  const envFile = readDotEnvFile(repoDir);
  const key = (processEnv[apiKeyEnv] || envFile[apiKeyEnv] || '').trim();
  if (!key) {
    throw new MissingOpenRouterApiKeyError(apiKeyEnv);
  }
  return key;
}

function resolveModel(model: string | undefined): string {
  if (model && isOpenRouterModel(model)) {
    return model;
  }
  return DEFAULT_MODEL;
}

export function buildOpenRouterLauncherEnv(
  opts: BuildOpenRouterLauncherEnvOptions,
): OpenRouterLauncherEnv {
  const repoDir = opts.repoDir ?? process.cwd();
  const processEnv = opts.processEnv ?? (process.env as Record<string, string | undefined>);
  const providerConfig = getOpenRouterProviderConfig(repoDir);
  const apiKeyEnv = providerConfig.apiKeyEnv?.trim() || DEFAULT_API_KEY_ENV;
  const apiKey = resolveApiKey(apiKeyEnv, processEnv, repoDir);
  const wavemillModel = resolveModel(opts.model);
  const openrouterId = resolveOpenRouterModelId(wavemillModel);
  if (!openrouterId) {
    throw new Error(`No OpenRouter model ID configured for ${wavemillModel}`);
  }

  const stateDir = resolveOpenRouterLauncherStateDir(repoDir, opts.session, opts.issue);
  const baseUrl = providerConfig.baseUrl?.trim() || OPENROUTER_BASE_URL;

  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_MODEL: openrouterId,
    ANTHROPIC_DEFAULT_OPUS_MODEL: openrouterId,
    ANTHROPIC_DEFAULT_SONNET_MODEL: openrouterId,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: openrouterId,
    CLAUDE_CODE_EFFORT_LEVEL: 'medium',
    CLAUDE_CONFIG_DIR: join(stateDir, 'claude-config'),
    HOME: join(stateDir, 'home'),
    XDG_CONFIG_HOME: join(stateDir, 'xdg', 'config'),
    XDG_DATA_HOME: join(stateDir, 'xdg', 'data'),
    WAVEMILL_AGENT_KIND,
    WAVEMILL_OPENROUTER_STATE_DIR: stateDir,
  };
}

export function createOpenRouterStateDir(env: OpenRouterLauncherEnv): void {
  const dirs = [
    env.WAVEMILL_OPENROUTER_STATE_DIR,
    env.HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    env.CLAUDE_CONFIG_DIR,
  ];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
}

export function writeOpenRouterStateDiscoveryFile(session: string, issue: string, stateDir: string): string {
  const path = `/tmp/${session}-${issue}-openrouter-state.json`;
  writeFileSync(path, `${JSON.stringify({ session, issue, stateDir }, null, 2)}\n`, { mode: 0o600 });
  return path;
}
