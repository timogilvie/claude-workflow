/**
 * DeepSeek Launcher — env/state construction for claude-deepseek agent path.
 *
 * Builds the environment block and state directory needed to run Claude Code
 * against DeepSeek's Anthropic-compatible endpoint. All credential lookup and
 * path construction is isolated here so it can be tested without shell heredocs.
 *
 * @module deepseek-launcher
 */

import { mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute, normalize } from 'node:path';
import { homedir } from 'node:os';
import { getDeepSeekProviderConfig, getDeepSeekLauncherConfig } from './config.ts';
import { DEEPSEEK_BASE_URL, isDeepSeekModel } from './deepseek-provider.ts';

// ────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────

const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const WAVEMILL_AGENT_KIND = 'claude-deepseek';

// Pattern for shell-special or path-traversal characters in segment values.
// Reject anything that isn't [a-zA-Z0-9._-].
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

// ────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────

export class MissingDeepSeekApiKeyError extends Error {
  constructor(envVarName: string) {
    super(
      `Missing DeepSeek API key: environment variable ${envVarName} is not set or empty. ` +
      `Export ${envVarName} before launching a claude-deepseek agent.`,
    );
    this.name = 'MissingDeepSeekApiKeyError';
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

export class UnsafeStateDirError extends Error {
  constructor(dir: string) {
    super(
      `Refusing to use '${dir}' as claude-deepseek state directory: ` +
      `it resolves to or under the user's real ~/.claude directory. ` +
      `Provide an alternative stateDir in providers.deepseek.launcher.`,
    );
    this.name = 'UnsafeStateDirError';
  }
}

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface BuildDeepSeekLauncherEnvOptions {
  repoDir?: string;
  session: string;
  issue: string;
  /** Explicit model override from the call site (e.g. from --model flag). */
  model?: string;
  /** The process environment to read credentials from (defaults to process.env). */
  processEnv?: Record<string, string | undefined>;
}

/** The full environment block to inject into the claude-deepseek child process. */
export interface DeepSeekLauncherEnv {
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
  WAVEMILL_DEEPSEEK_STATE_DIR: string;
}

export interface ResolveStateDirOptions {
  repoDir: string;
  session: string;
  issue: string;
  /** Explicit state dir override (from config or call site). Validated against ~/.claude. */
  configuredStateDir?: string;
}

// ────────────────────────────────────────────────────────────────
// Validation helpers
// ────────────────────────────────────────────────────────────────

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

// ────────────────────────────────────────────────────────────────
// State directory resolution
// ────────────────────────────────────────────────────────────────

/**
 * Resolve the isolated Claude Code state directory for a claude-deepseek launch.
 *
 * Priority:
 *   1. Explicitly configured `stateDir` in providers.deepseek.launcher (validated)
 *   2. Default: `<repoDir>/.wavemill/deepseek-state/<session>-<issue>`
 */
export function resolveDeepSeekLauncherStateDir(opts: ResolveStateDirOptions): string {
  const { repoDir, session, issue } = opts;

  validateSegment('session', session);
  validateSegment('issue', issue);

  if (opts.configuredStateDir) {
    const resolved = resolve(opts.configuredStateDir);
    assertNotUnderRealClaudeHome(resolved);
    return resolved;
  }

  const slug = `${session}-${issue}`;
  const stateDir = join(resolve(repoDir), '.wavemill', 'deepseek-state', slug);
  assertNotUnderRealClaudeHome(stateDir);
  return stateDir;
}

// ────────────────────────────────────────────────────────────────
// Credential resolution
// ────────────────────────────────────────────────────────────────

function resolveApiKey(
  apiKeyEnv: string,
  secretSource: string | undefined,
  processEnv: Record<string, string | undefined>,
): { key: string; envVarName: string } {
  // secretSource overrides apiKeyEnv when provided
  const envVarName = secretSource?.trim() || apiKeyEnv;
  const key = (processEnv[envVarName] || '').trim();
  if (!key) {
    throw new MissingDeepSeekApiKeyError(envVarName);
  }
  return { key, envVarName };
}

// ────────────────────────────────────────────────────────────────
// Model resolution
// ────────────────────────────────────────────────────────────────

function resolveModel(
  explicitModel: string | undefined,
  launcherModel: string | undefined,
): string {
  // Explicit call-site model wins if it looks like a deepseek model
  if (explicitModel && isDeepSeekModel(explicitModel)) {
    return explicitModel;
  }
  // Config launcher model
  if (launcherModel && isDeepSeekModel(launcherModel)) {
    return launcherModel;
  }
  return DEFAULT_MODEL;
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Build the complete environment block for a claude-deepseek child process.
 *
 * Throws `MissingDeepSeekApiKeyError` when no API key is found.
 * Throws `InvalidPathSegmentError` when session or issue contains unsafe chars.
 * Throws `UnsafeStateDirError` when the resolved state dir would be ~/.claude.
 *
 * The returned object is safe to spread into a child process env. It does NOT
 * include the parent environment — callers should spread `process.env` first,
 * then spread the result of this function to override only the relevant keys.
 */
export function buildDeepSeekLauncherEnv(opts: BuildDeepSeekLauncherEnvOptions): DeepSeekLauncherEnv {
  const repoDir = opts.repoDir ?? process.cwd();
  const processEnv = opts.processEnv ?? (process.env as Record<string, string | undefined>);

  const providerConfig = getDeepSeekProviderConfig(repoDir);
  const launcherConfig = getDeepSeekLauncherConfig(repoDir);

  const apiKeyEnv = providerConfig.apiKeyEnv?.trim() || DEFAULT_API_KEY_ENV;
  const { key: apiKey } = resolveApiKey(apiKeyEnv, launcherConfig.secretSource, processEnv);

  const baseUrl = providerConfig.baseUrl?.trim() || DEEPSEEK_BASE_URL;
  const effortLevel = providerConfig.effortLevel || 'medium';

  const model = resolveModel(opts.model, launcherConfig.model);
  const subagentModel = launcherConfig.subagentModel && isDeepSeekModel(launcherConfig.subagentModel)
    ? launcherConfig.subagentModel
    : model;

  const stateDir = resolveDeepSeekLauncherStateDir({
    repoDir,
    session: opts.session,
    issue: opts.issue,
    configuredStateDir: launcherConfig.stateDir,
  });

  return {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: subagentModel,
    CLAUDE_CODE_EFFORT_LEVEL: effortLevel,
    CLAUDE_CONFIG_DIR: join(stateDir, 'claude-config'),
    HOME: join(stateDir, 'home'),
    XDG_CONFIG_HOME: join(stateDir, 'xdg', 'config'),
    XDG_DATA_HOME: join(stateDir, 'xdg', 'data'),
    WAVEMILL_AGENT_KIND,
    WAVEMILL_DEEPSEEK_STATE_DIR: stateDir,
  };
}

/**
 * Create the state directory structure for a claude-deepseek launch.
 * Sets restrictive permissions (700) on created directories.
 */
export function createDeepSeekStateDir(env: DeepSeekLauncherEnv): void {
  const dirs = [
    env.WAVEMILL_DEEPSEEK_STATE_DIR,
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
      // Best effort; non-fatal on restricted filesystems
    }
  }
}

/**
 * Write the state discovery file at `/tmp/wavemill-<session>-<issue>.deepseek-state`.
 * Contains the path to the isolated state directory.
 * Does NOT contain the API key.
 */
export function writeDeepSeekStateDiscoveryFile(
  session: string,
  issue: string,
  stateDir: string,
): string {
  const discoveryPath = `/tmp/wavemill-${session}-${issue}.deepseek-state`;
  writeFileSync(discoveryPath, stateDir, 'utf8');
  return discoveryPath;
}
