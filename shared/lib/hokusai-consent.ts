import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { getHokusaiSubmissionConfig } from './config.ts';
import { errorMessage } from './error-utils.ts';

export const CURRENT_CONSENT_VERSION = '1.0';
export const DEFAULT_HOKUSAI_ENDPOINT = 'https://api.hokusai.dev/v1/submit';

export const CONSENT_TEXT = `Hokusai data submission is strictly opt-in.

If enabled, Wavemill may submit anonymized workflow outcome data to Hokusai, including:
- task descriptors such as issue type and complexity estimates
- model selections for planner, coder, and reviewer stages
- cost and timing metrics
- success outcomes such as pass/fail and intervention counts

Wavemill does NOT submit:
- source code or file contents
- raw repository names after redaction
- commit messages or PR descriptions
- API keys or other secrets

Participating earns token rewards that offset Hokusai routing costs.

You can disable data submission at any time with:
  wavemill hokusai disable`;

export interface HokusaiUserConfig {
  hokusai?: {
    enabled?: boolean;
    consentedAt?: string | null;
    consentVersion?: string | null;
    apiKey?: string | null;
  };
  [key: string]: unknown;
}

export interface ConsentState {
  enabled: boolean;
  consentedAt: string | null;
  consentVersion: string | null;
}

export interface SubmissionStatus extends ConsentState {
  currentVersion: string;
  endpoint: string;
  consentValid: boolean;
  submissionAllowed: boolean;
}

export interface EnableSubmissionOptions {
  configDir?: string;
  repoDir?: string;
  skipPrompt?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

function resolveConfigDir(configDir?: string): string {
  return configDir ?? join(homedir(), '.wavemill');
}

function resolveUserConfigPath(configDir?: string): string {
  return join(resolveConfigDir(configDir), 'config.json');
}

function resolveCurrentConsentVersion(repoDir?: string): string {
  return getHokusaiSubmissionConfig(repoDir).consentVersion || CURRENT_CONSENT_VERSION;
}

function resolveEndpoint(repoDir?: string): string {
  return getHokusaiSubmissionConfig(repoDir).endpoint || DEFAULT_HOKUSAI_ENDPOINT;
}

function updateUserConfig(
  mutator: (config: HokusaiUserConfig) => void,
  configDir?: string,
): HokusaiUserConfig {
  const config = loadUserConfig(configDir);
  mutator(config);
  saveUserConfig(config, configDir);
  return config;
}

export function loadUserConfig(configDir?: string): HokusaiUserConfig {
  const configPath = resolveUserConfigPath(configDir);
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as HokusaiUserConfig;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.warn(
      `Failed to parse user config at ${configPath}; ignoring it: ${errorMessage(error)}`,
    );
    return {};
  }
}

export function saveUserConfig(config: HokusaiUserConfig, configDir?: string): void {
  const targetDir = resolveConfigDir(configDir);
  const configPath = resolveUserConfigPath(configDir);
  const tempPath = `${configPath}.tmp-${process.pid}`;

  mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, configPath);
}

export function getConsentState(configDir?: string): ConsentState {
  const hokusai = loadUserConfig(configDir).hokusai;
  return {
    enabled: hokusai?.enabled === true,
    consentedAt: hokusai?.consentedAt ?? null,
    consentVersion: hokusai?.consentVersion ?? null,
  };
}

export function isConsentValid(currentVersion: string, configDir?: string): boolean {
  const state = getConsentState(configDir);
  return Boolean(state.consentedAt && state.consentVersion === currentVersion);
}

export async function promptConsent(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean> {
  output.write(`${CONSENT_TEXT}\n\n`);
  const rl = createInterface({ input, output });

  try {
    const answer = await rl.question('Enable Hokusai data submission? [y/N] ');
    const normalized = answer.trim().toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

export function recordConsent(version: string, configDir?: string): void {
  updateUserConfig((config) => {
    config.hokusai = {
      ...(config.hokusai || {}),
      consentedAt: new Date().toISOString(),
      consentVersion: version,
    };
  }, configDir);
}

export async function enableSubmission(options: EnableSubmissionOptions = {}): Promise<boolean> {
  const {
    configDir,
    repoDir,
    skipPrompt = false,
    input = process.stdin,
    output = process.stdout,
  } = options;

  const currentVersion = resolveCurrentConsentVersion(repoDir);
  const alreadyValid = isConsentValid(currentVersion, configDir);

  if (!alreadyValid && !skipPrompt) {
    const accepted = await promptConsent(input, output);
    if (!accepted) {
      updateUserConfig((config) => {
        config.hokusai = {
          ...(config.hokusai || {}),
          enabled: false,
        };
      }, configDir);
      return false;
    }
  }

  updateUserConfig((config) => {
    const hokusai = {
      ...(config.hokusai || {}),
      enabled: true,
    };

    if (!alreadyValid) {
      hokusai.consentedAt = new Date().toISOString();
      hokusai.consentVersion = currentVersion;
    }

    config.hokusai = hokusai;
  }, configDir);

  return true;
}

export function disableSubmission(configDir?: string): void {
  updateUserConfig((config) => {
    config.hokusai = {
      ...(config.hokusai || {}),
      enabled: false,
    };
  }, configDir);
}

export function getSubmissionStatus(options: { configDir?: string; repoDir?: string } = {}): SubmissionStatus {
  const state = getConsentState(options.configDir);
  const currentVersion = resolveCurrentConsentVersion(options.repoDir);
  const endpoint = resolveEndpoint(options.repoDir);
  const consentValid = isConsentValid(currentVersion, options.configDir);

  return {
    ...state,
    currentVersion,
    endpoint,
    consentValid,
    submissionAllowed: state.enabled && consentValid,
  };
}

export function getStatusDisplay(options: { configDir?: string; repoDir?: string } = {}): string {
  const status = getSubmissionStatus(options);
  const lines = [
    `Hokusai data submission: ${status.enabled ? 'enabled' : 'disabled'}`,
    `Submission allowed: ${status.submissionAllowed ? 'yes' : 'no'}`,
    `Consent valid: ${status.consentValid ? 'yes' : 'no'}`,
    `Consent version: ${status.consentVersion ?? 'none'} (current: ${status.currentVersion})`,
    `Consented at: ${status.consentedAt ?? 'never'}`,
    `Endpoint: ${status.endpoint}`,
  ];

  if (!status.submissionAllowed) {
    lines.push('Run `wavemill hokusai enable` to opt in, or `wavemill hokusai disable` to stay opted out.');
  }

  return lines.join('\n');
}
