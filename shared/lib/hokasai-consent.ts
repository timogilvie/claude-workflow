/**
 * Hokasai data submission consent management.
 *
 * Handles:
 * - User-level consent state (stored in ~/.wavemill/config.json)
 * - Consent validation against repo-level consent version requirements
 * - Interactive consent prompting with disclosure text
 * - Recording and revoking consent with timestamps
 *
 * @module hokasai-consent
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { confirm } from './cli-prompt.ts';
import { loadWavemillConfig } from './config.ts';
import { errorMessage } from './error-utils.ts';

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

export interface UserDataSubmissionConfig {
  enabled?: boolean;
  consentedAt?: string | null;
  consentVersion?: string;
  apiKey?: string | null;
}

export interface UserHokusaiConfig {
  dataSubmission?: UserDataSubmissionConfig;
}

export interface UserConfig {
  hokusai?: UserHokusaiConfig;
  [key: string]: unknown; // preserve other user config
}

// ────────────────────────────────────────────────────────────────
// User Config I/O
// ────────────────────────────────────────────────────────────────

/**
 * Load user-level config from ~/.wavemill/config.json
 *
 * @param configDir - Directory containing config.json (default: ~/.wavemill)
 * @returns Parsed config object, or {} if file doesn't exist or is invalid
 */
export async function loadUserConfig(configDir?: string): Promise<UserConfig> {
  const dir = configDir || resolve(homedir(), '.wavemill');
  const configPath = resolve(dir, 'config.json');

  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content) as UserConfig;
  } catch (err) {
    // Treat invalid JSON or read errors as missing config
    console.warn(
      `Warning: Failed to load user config from ${configPath}: ${errorMessage(err)}`
    );
    return {};
  }
}

/**
 * Save user-level config to ~/.wavemill/config.json with atomic writes
 *
 * Uses temp file + rename pattern to prevent corruption from concurrent writes.
 * Creates ~/.wavemill/ directory if needed.
 *
 * @param config - Config object to save
 * @param configDir - Directory to write to (default: ~/.wavemill)
 * @throws On filesystem errors after atomic write attempt
 */
export async function saveUserConfig(config: UserConfig, configDir?: string): Promise<void> {
  const dir = configDir || resolve(homedir(), '.wavemill');

  // Create directory if needed
  mkdirSync(dir, { recursive: true });

  const configPath = resolve(dir, 'config.json');
  const tmpPath = resolve(tmpdir(), `wavemill-config-${randomBytes(8).toString('hex')}.json`);

  try {
    // Write to temp file first
    writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf-8');

    // Atomic rename
    const fs = await import('node:fs/promises');
    await fs.rename(tmpPath, configPath);
  } catch (err) {
    // Clean up temp file on error
    try {
      const fs = await import('node:fs/promises');
      await fs.unlink(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw new Error(`Failed to save user config: ${errorMessage(err)}`);
  }
}

// ────────────────────────────────────────────────────────────────
// Consent Validation
// ────────────────────────────────────────────────────────────────

/**
 * Check if consent is valid for the given repo consent version
 *
 * Consent is valid only when:
 * 1. User has enabled data submission
 * 2. consentedAt timestamp is set
 * 3. consentVersion matches repo requirement
 *
 * @param userConfig - User config from loadUserConfig()
 * @param repoConsentVersion - Required consent version from repo config (default: "1.0")
 * @returns true if consent is valid and current
 */
export function isConsentValid(
  userConfig: UserConfig,
  repoConsentVersion: string = '1.0'
): boolean {
  const submission = userConfig.hokusai?.dataSubmission;

  if (!submission?.enabled) {
    return false;
  }

  if (!submission.consentedAt) {
    return false;
  }

  if (submission.consentVersion !== repoConsentVersion) {
    return false;
  }

  return true;
}

// ────────────────────────────────────────────────────────────────
// Consent Prompting
// ────────────────────────────────────────────────────────────────

/**
 * Display consent disclosure and prompt for y/n confirmation
 *
 * The disclosure explains:
 * - What data is collected
 * - What is NOT collected
 * - The token reward incentive
 * - How to disable at any time
 *
 * @returns true if user confirmed, false if declined or stdin not a TTY
 */
export async function promptConsent(): Promise<boolean> {
  // Check if stdin is a TTY (not piped)
  if (!process.stdin.isTTY) {
    return false;
  }

  console.log('\n' + '='.repeat(72));
  console.log('Hokusai Data Submission Consent');
  console.log('='.repeat(72));

  console.log(`
This project has enabled optional data submission to Hokasai, an AI model
routing service that improves task execution quality over time.

DATA COLLECTED:
  • Task descriptors (type, language, domain, complexity indicators)
  • Model selections you choose or that are suggested to you
  • Cost metrics (API usage, token counts)
  • Outcomes (success/failure, intervention counts)

DATA NOT COLLECTED:
  • Source code or file contents
  • Repository names (anonymized via hashing)
  • Personal or identifying information

INCENTIVE:
  Contributing anonymous training data earns token rewards that can be
  applied to future API usage.

OPT-OUT:
  You can disable data submission at any time with:
    wavemill hokusai disable

For more details, visit: https://hokusai.dev/privacy
`);

  console.log('='.repeat(72) + '\n');

  return confirm('Do you consent to data submission?');
}

// ────────────────────────────────────────────────────────────────
// Consent Recording & Revocation
// ────────────────────────────────────────────────────────────────

/**
 * Record user consent with timestamp and version
 *
 * Sets:
 * - enabled: true
 * - consentedAt: current ISO 8601 timestamp
 * - consentVersion: provided version
 *
 * @param consentVersion - Consent version agreed to (e.g., "1.0")
 * @param configDir - Optional config directory for testing
 */
export async function recordConsent(consentVersion: string, configDir?: string): Promise<void> {
  const config = await loadUserConfig(configDir);

  if (!config.hokasai) {
    config.hokasai = {};
  }
  if (!config.hokasai.dataSubmission) {
    config.hokasai.dataSubmission = {};
  }

  config.hokasai.dataSubmission.enabled = true;
  config.hokasai.dataSubmission.consentedAt = new Date().toISOString();
  config.hokasai.dataSubmission.consentVersion = consentVersion;

  await saveUserConfig(config, configDir);
}

/**
 * Revoke user consent (disable data submission)
 *
 * Sets:
 * - enabled: false
 * - consentedAt: null (cleared)
 *
 * @param configDir - Optional config directory for testing
 */
export async function revokeConsent(configDir?: string): Promise<void> {
  const config = await loadUserConfig(configDir);

  if (!config.hokasai) {
    config.hokasai = {};
  }
  if (!config.hokasai.dataSubmission) {
    config.hokasai.dataSubmission = {};
  }

  config.hokasai.dataSubmission.enabled = false;
  config.hokasai.dataSubmission.consentedAt = null;

  await saveUserConfig(config, configDir);
}

// ────────────────────────────────────────────────────────────────
// Consent Orchestration
// ────────────────────────────────────────────────────────────────

/**
 * Ensure user consent is valid for Hokasai data submission
 *
 * Flow:
 * 1. Load repo config to get required consent version
 * 2. Load user config
 * 3. If submission not enabled, return false (no prompt needed)
 * 4. If consent is valid, return true
 * 5. If consent is stale (version mismatch):
 *    a. Display re-consent prompt
 *    b. If user confirms, record new consent
 *    c. If user declines, revoke consent
 * 6. Return whether consent is now valid
 *
 * Errors during file I/O are caught and logged. Consent is treated as
 * invalid on any error.
 *
 * @param repoDir - Repository directory for config lookup (default: cwd)
 * @param configDir - User config directory for testing (default: ~/.wavemill)
 * @returns true if consent is valid, false otherwise
 */
export async function ensureConsent(
  repoDir?: string,
  configDir?: string
): Promise<boolean> {
  try {
    // Load repo config to get consent version requirement
    const repoConfig = loadWavemillConfig(repoDir);
    const repoConsentVersion = repoConfig.hokasai?.dataSubmission?.consentVersion ?? '1.0';

    // Load user config
    const userConfig = await loadUserConfig(configDir);

    // If submission is not enabled, no prompt needed - return false
    const submission = userConfig.hokasai?.dataSubmission;
    if (!submission?.enabled) {
      return false;
    }

    // If consent is valid, return true
    if (isConsentValid(userConfig, repoConsentVersion)) {
      return true;
    }

    // Consent is stale - prompt for re-consent
    console.log(
      `\nConsent version mismatch. This project requires consent version ${repoConsentVersion}.`
    );

    const userConfirmed = await promptConsent();

    if (userConfirmed) {
      // User accepted - record new consent
      await recordConsent(repoConsentVersion, configDir);
      return true;
    } else {
      // User declined - revoke consent
      await revokeConsent(configDir);
      return false;
    }
  } catch (err) {
    // On any error, treat as invalid consent and log warning
    console.warn(`Hokasai consent check failed: ${errorMessage(err)}`);
    return false;
  }
}

/**
 * Non-interactive consent check (read-only, no prompts)
 *
 * Used by mill workflow to check if submission should proceed.
 * Never displays prompts - only reads config and returns boolean.
 *
 * @param repoDir - Repository directory for config lookup
 * @param configDir - User config directory for testing
 * @returns true if consent is valid and submission should proceed
 */
export async function checkConsentQuiet(
  repoDir?: string,
  configDir?: string
): Promise<boolean> {
  try {
    const repoConfig = loadWavemillConfig(repoDir);
    const repoConsentVersion = repoConfig.hokasai?.dataSubmission?.consentVersion ?? '1.0';
    const userConfig = await loadUserConfig(configDir);
    return isConsentValid(userConfig, repoConsentVersion);
  } catch {
    return false;
  }
}
