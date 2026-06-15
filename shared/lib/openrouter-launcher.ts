import { mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OPENROUTER_BASE_URL, openrouterIdForModel } from './openrouter-provider.ts';
import { getOpenRouterProviderConfig } from './config.ts';

const DEFAULT_API_KEY_ENV = 'OPENROUTER_API_KEY';
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

export class InvalidOpenRouterModelError extends Error {
  constructor(model: string) {
    super(`Unsupported OpenRouter launch model '${model}': no mapped OpenRouter model ID was found.`);
    this.name = 'InvalidOpenRouterModelError';
  }
}

export class InvalidPathSegmentError extends Error {
  constructor(field: string, value: string) {
    super(
      `Invalid ${field} path segment '${value}': must match [A-Za-z0-9._-]+. ` +
      `Shell-special characters and path separators are not allowed.`,
    );
    this.name = 'InvalidPathSegmentError';
  }
}

export interface BuildOpenRouterLauncherEnvOptions {
  repoDir?: string;
  session: string;
  issue: string;
  model: string;
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
  CLAUDE_CODE_SUBAGENT_MODEL: string;
  CLAUDE_CODE_EFFORT_LEVEL: string;
  CLAUDE_CONFIG_DIR: string;
  HOME: string;
  XDG_CONFIG_HOME: string;
  XDG_DATA_HOME: string;
  WAVEMILL_AGENT_KIND: string;
  WAVEMILL_OPENROUTER_STATE_DIR: string;
}

export function resolveOpenRouterLauncherStateDir(opts: {
  repoDir: string;
  session: string;
  issue: string;
  processEnv?: Record<string, string | undefined>;
}): string {
  if (!SAFE_SEGMENT_RE.test(opts.session)) {
    throw new InvalidPathSegmentError('session', opts.session);
  }
  if (!SAFE_SEGMENT_RE.test(opts.issue)) {
    throw new InvalidPathSegmentError('issue', opts.issue);
  }

  const runDir = opts.processEnv?.WAVEMILL_RUN_DIR?.trim();
  if (runDir) {
    return join(runDir, 'providers', 'openrouter');
  }

  return join(resolve(opts.repoDir), '.wavemill', 'runs', `${opts.session}-${opts.issue}`, 'providers', 'openrouter');
}

export function buildOpenRouterLauncherEnv(
  opts: BuildOpenRouterLauncherEnvOptions,
): OpenRouterLauncherEnv {
  const repoDir = opts.repoDir ?? process.cwd();
  const processEnv = opts.processEnv ?? (process.env as Record<string, string | undefined>);
  const providerConfig = getOpenRouterProviderConfig(repoDir);
  const apiKeyEnv = providerConfig.apiKeyEnv?.trim() || DEFAULT_API_KEY_ENV;
  const apiKey = (processEnv[apiKeyEnv] || '').trim();

  if (!apiKey) {
    throw new MissingOpenRouterApiKeyError(apiKeyEnv);
  }

  const openrouterId = openrouterIdForModel(opts.model);
  if (!openrouterId) {
    throw new InvalidOpenRouterModelError(opts.model);
  }

  const baseUrl = providerConfig.baseUrl?.trim() || OPENROUTER_BASE_URL;
  const effortLevel = providerConfig.effortLevel || 'medium';
  const stateDir = resolveOpenRouterLauncherStateDir({
    repoDir,
    session: opts.session,
    issue: opts.issue,
    processEnv,
  });

  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_MODEL: openrouterId,
    ANTHROPIC_DEFAULT_OPUS_MODEL: openrouterId,
    ANTHROPIC_DEFAULT_SONNET_MODEL: openrouterId,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: openrouterId,
    CLAUDE_CODE_SUBAGENT_MODEL: openrouterId,
    CLAUDE_CODE_EFFORT_LEVEL: effortLevel,
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
    mkdirSync(dir, { recursive: true });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Best effort only.
    }
  }
}

export function writeOpenRouterStateDiscoveryFile(
  session: string,
  issue: string,
  stateDir: string,
): string {
  const discoveryPath = `/tmp/wavemill-${session}-${issue}.openrouter-state`;
  writeFileSync(discoveryPath, stateDir, 'utf8');
  return discoveryPath;
}
