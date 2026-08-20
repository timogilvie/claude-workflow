import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  disableSubmission,
  enableSubmission,
  getContributionStatus,
  getStatusDisplay,
  getContributionConsentStatus,
  getConsentState,
  getSubmissionStatus,
  isHokusaiContributionsEnabled,
  isConsentValid,
  loadUserConfig,
  recordConsent,
  saveUserConfig,
} from './hokusai-consent.ts';
import { LEGACY_UNSCOPED_ENDPOINT } from './hokusai-local-config.ts';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeTempRepo(config: Record<string, unknown> = {}): string {
  const repoDir = makeTempDir('hokusai-consent-repo-');
  writeFileSync(join(repoDir, '.wavemill-config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  return repoDir;
}

function captureOutput(): { stream: Writable; text: () => string } {
  let buffer = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      callback();
    },
  });

  return {
    stream,
    text: () => buffer,
  };
}

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('hokusai-consent', () => {
  describe('loadUserConfig / saveUserConfig', () => {
    it('reads existing config correctly', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      saveUserConfig({ hokusai: { enabled: true, consentVersion: '1.0' }, other: 1 }, configDir);

      assert.deepEqual(loadUserConfig(configDir), {
        hokusai: { enabled: true, consentVersion: '1.0' },
        other: 1,
      });
    });

    it('returns empty object when file is missing', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      assert.deepEqual(loadUserConfig(configDir), {});
    });

    it('returns empty object when file is corrupt JSON and logs a warning', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.json'), '{ nope', 'utf-8');

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (message?: unknown) => {
        warnings.push(String(message));
      };

      try {
        assert.deepEqual(loadUserConfig(configDir), {});
      } finally {
        console.warn = originalWarn;
      }

      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /Failed to parse user config/);
    });

    it('creates directory with 0700 and file with 0600 on save', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      saveUserConfig({ hokusai: { enabled: true } }, configDir);

      const dirMode = statSync(configDir).mode & 0o777;
      const fileMode = statSync(join(configDir, 'config.json')).mode & 0o777;

      assert.equal(dirMode, 0o700);
      assert.equal(fileMode, 0o600);
    });

    it('preserves existing non-hokusai keys on save', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      saveUserConfig({
        linear: { token: 'keep-me' },
        hokusai: { enabled: false },
      }, configDir);

      recordConsent('1.0', configDir);
      const config = loadUserConfig(configDir);

      assert.deepEqual(config.linear, { token: 'keep-me' });
      assert.equal(config.hokusai?.consentVersion, '1.0');
    });

    it('writes valid JSON atomically', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      saveUserConfig({ hokusai: { enabled: true, consentVersion: '1.0' } }, configDir);

      const parsed = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf-8')) as {
        hokusai: { enabled: boolean; consentVersion: string };
      };

      assert.equal(parsed.hokusai.enabled, true);
      assert.equal(parsed.hokusai.consentVersion, '1.0');
    });
  });

  describe('isConsentValid', () => {
    it('returns false when no consent exists', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      assert.equal(isConsentValid('1.0', configDir), false);
    });

    it('returns false when version mismatch', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      saveUserConfig({ hokusai: { consentedAt: '2026-04-14T12:00:00.000Z', consentVersion: '0.9' } }, configDir);
      assert.equal(isConsentValid('1.0', configDir), false);
    });

    it('returns true when version matches and consentedAt is set', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      saveUserConfig({ hokusai: { consentedAt: '2026-04-14T12:00:00.000Z', consentVersion: '1.0' } }, configDir);
      assert.equal(isConsentValid('1.0', configDir), true);
    });

    it('returns false when consentedAt is null but version matches', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      saveUserConfig({ hokusai: { consentedAt: null, consentVersion: '1.0' } }, configDir);
      assert.equal(isConsentValid('1.0', configDir), false);
    });
  });

  describe('enableSubmission', () => {
    it('records consent when user accepts', async () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      const repoDir = makeTempRepo({ hokusai: { dataSubmission: { consentVersion: '1.0' } } });
      const output = captureOutput();

      const enabled = await enableSubmission({
        configDir,
        repoDir,
        input: Readable.from(['y\n']),
        output: output.stream,
      });

      const state = getConsentState(configDir);
      assert.equal(enabled, true);
      assert.equal(state.enabled, true);
      assert.equal(state.consentVersion, '1.0');
      assert.ok(state.consentedAt);
      assert.match(output.text(), /Hokusai data submission is strictly opt-in/);
    });

    it('does not record when user declines', async () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      const repoDir = makeTempRepo({ hokusai: { dataSubmission: { consentVersion: '1.0' } } });

      const enabled = await enableSubmission({
        configDir,
        repoDir,
        input: Readable.from(['n\n']),
        output: captureOutput().stream,
      });

      const state = getConsentState(configDir);
      assert.equal(enabled, false);
      assert.equal(state.enabled, false);
      assert.equal(state.consentVersion, null);
      assert.equal(state.consentedAt, null);
    });

    it('accepts yes case-insensitively', async () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      const repoDir = makeTempRepo({ hokusai: { dataSubmission: { consentVersion: '1.0' } } });

      const enabled = await enableSubmission({
        configDir,
        repoDir,
        input: Readable.from(['YES\n']),
        output: captureOutput().stream,
      });

      assert.equal(enabled, true);
      assert.equal(getConsentState(configDir).enabled, true);
    });

    it('treats empty input as decline', async () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      const repoDir = makeTempRepo({ hokusai: { dataSubmission: { consentVersion: '1.0' } } });

      const enabled = await enableSubmission({
        configDir,
        repoDir,
        input: Readable.from(['\n']),
        output: captureOutput().stream,
      });

      assert.equal(enabled, false);
      assert.equal(getConsentState(configDir).enabled, false);
    });

    it('skips the prompt when consent is already valid', async () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      const repoDir = makeTempRepo({ hokusai: { dataSubmission: { consentVersion: '1.0' } } });
      saveUserConfig({
        hokusai: {
          enabled: false,
          consentedAt: '2026-04-14T12:00:00.000Z',
          consentVersion: '1.0',
        },
      }, configDir);

      const output = captureOutput();
      const enabled = await enableSubmission({
        configDir,
        repoDir,
        input: Readable.from(['n\n']),
        output: output.stream,
      });

      assert.equal(enabled, true);
      assert.equal(getConsentState(configDir).enabled, true);
      assert.equal(output.text(), '');
    });

    it('re-prompts when consent version does not match', async () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      const repoDir = makeTempRepo({ hokusai: { dataSubmission: { consentVersion: '2.0' } } });
      saveUserConfig({
        hokusai: {
          enabled: true,
          consentedAt: '2026-04-14T12:00:00.000Z',
          consentVersion: '1.0',
        },
      }, configDir);

      const enabled = await enableSubmission({
        configDir,
        repoDir,
        input: Readable.from(['y\n']),
        output: captureOutput().stream,
      });

      const state = getConsentState(configDir);
      assert.equal(enabled, true);
      assert.equal(state.consentVersion, '2.0');
      assert.ok(state.consentedAt);
    });
  });

  describe('disableSubmission', () => {
    it('sets enabled to false and preserves consent state', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      saveUserConfig({
        hokusai: {
          enabled: true,
          consentedAt: '2026-04-14T12:00:00.000Z',
          consentVersion: '1.0',
        },
      }, configDir);

      disableSubmission(configDir);

      assert.deepEqual(getConsentState(configDir), {
        enabled: false,
        consentedAt: '2026-04-14T12:00:00.000Z',
        consentVersion: '1.0',
      });
    });

    it('creates a file when no config exists', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      disableSubmission(configDir);

      const config = loadUserConfig(configDir);
      assert.equal(config.hokusai?.enabled, false);
    });
  });

  describe('getConsentState / getSubmissionStatus', () => {
    it('returns defaults when no config exists', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      assert.deepEqual(getConsentState(configDir), {
        enabled: false,
        consentedAt: null,
        consentVersion: null,
      });
    });

    it('returns stored state when config exists', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      saveUserConfig({
        hokusai: {
          enabled: true,
          consentedAt: '2026-04-14T12:00:00.000Z',
          consentVersion: '1.0',
        },
      }, configDir);

      assert.deepEqual(getConsentState(configDir), {
        enabled: true,
        consentedAt: '2026-04-14T12:00:00.000Z',
        consentVersion: '1.0',
      });
    });

    it('computes submissionAllowed from enabled plus valid consent', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      const repoDir = makeTempRepo({ hokusai: { dataSubmission: { consentVersion: '1.0' } } });
      saveUserConfig({
        hokusai: {
          enabled: true,
          consentedAt: '2026-04-14T12:00:00.000Z',
          consentVersion: '1.0',
        },
      }, configDir);

      const status = getSubmissionStatus({ configDir, repoDir });
      assert.equal(status.consentValid, true);
      assert.equal(status.submissionAllowed, true);
    });

    it('reports an unconfigured endpoint cleanly when none is set', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      const repoDir = makeTempRepo({ hokusai: { dataSubmission: { consentVersion: '1.0' } } });

      const status = getSubmissionStatus({ configDir, repoDir });
      assert.equal(status.endpoint, null);
      assert.match(getStatusDisplay({ configDir, repoDir }), /Endpoint: not configured/);
    });

    it('requires contributions.enabled for queue operations', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      const repoDir = makeTempRepo({
        hokusai: {
          dataSubmission: { consentVersion: '1.0' },
          contributions: { enabled: true },
        },
      });
      saveUserConfig({
        hokusai: {
          enabled: true,
          consentedAt: '2026-04-14T12:00:00.000Z',
          consentVersion: '1.0',
        },
      }, configDir);

      const status = getContributionConsentStatus({ configDir, repoDir });
      assert.deepEqual(status, {
        consentValid: true,
        contributionsEnabled: true,
        submissionAllowed: true,
      });
      assert.equal(isHokusaiContributionsEnabled({ configDir, repoDir }), true);
    });

    it('disables queue operations when contributions.enabled is false', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      const repoDir = makeTempRepo({
        hokusai: {
          dataSubmission: { consentVersion: '1.0' },
          contributions: { enabled: false },
        },
      });
      saveUserConfig({
        hokusai: {
          enabled: true,
          consentedAt: '2026-04-14T12:00:00.000Z',
          consentVersion: '1.0',
        },
      }, configDir);

      const status = getContributionConsentStatus({ configDir, repoDir });
      assert.deepEqual(status, {
        consentValid: true,
        contributionsEnabled: false,
        submissionAllowed: false,
      });
      assert.equal(isHokusaiContributionsEnabled({ configDir, repoDir }), false);
    });
  });

  describe('getContributionStatus', () => {
    function makeEnabledConsent(configDir: string): void {
      saveUserConfig({
        hokusai: {
          enabled: true,
          consentedAt: '2026-04-14T12:00:00.000Z',
          consentVersion: '1.0',
        },
      }, configDir);
    }

    it('returns disabled mode when contributions are off', () => {
      const configDir = makeTempDir('hokusai-contrib-status-');
      const repoDir = makeTempRepo({
        hokusai: {
          dataSubmission: { consentVersion: '1.0' },
          contributions: { enabled: false },
        },
      });
      makeEnabledConsent(configDir);

      const s = getContributionStatus({ configDir, repoDir });
      assert.equal(s.queue, 'disabled');
      assert.equal(s.mode, 'disabled');
    });

    it('returns export-only mode when contributions are enabled but endpoint is missing', () => {
      const configDir = makeTempDir('hokusai-contrib-status-');
      const repoDir = makeTempRepo({
        hokusai: {
          dataSubmission: { consentVersion: '1.0' },
          contributions: { enabled: true, exportPath: '.wavemill/hokusai/contributions.jsonl' },
        },
      });
      makeEnabledConsent(configDir);

      const s = getContributionStatus({ configDir, repoDir });
      assert.equal(s.queue, 'enabled');
      assert.equal(s.uploadEndpoint, 'missing');
      assert.equal(s.mode, 'export-only');
    });

    it('returns uploading mode when contributions are enabled and endpoint is set', () => {
      const configDir = makeTempDir('hokusai-contrib-status-');
      const repoDir = makeTempRepo({
        hokusai: {
          dataSubmission: { consentVersion: '1.0' },
          contributions: {
            enabled: true,
            endpoint: 'https://api.hokus.ai/api/v1/contributions',
            exportPath: '.wavemill/hokusai/contributions.jsonl',
          },
        },
      });
      makeEnabledConsent(configDir);

      const s = getContributionStatus({ configDir, repoDir });
      assert.equal(s.queue, 'enabled');
      assert.equal(s.uploadEndpoint, 'configured');
      assert.equal(s.mode, 'uploading');
      assert.equal(s.endpointLooksUnscoped, true);
      assert.equal(s.endpoint, LEGACY_UNSCOPED_ENDPOINT);
      assert.match(s.warning ?? '', /legacy unscoped path/);
      assert.match(s.warning ?? '', /wavemill hokusai migrate/);
    });

    it('returns disabled mode when consent is not valid', () => {
      const configDir = makeTempDir('hokusai-contrib-status-');
      const repoDir = makeTempRepo({
        hokusai: {
          dataSubmission: { consentVersion: '1.0' },
          contributions: { enabled: true, endpoint: 'https://example.com' },
        },
      });
      // No consent saved

      const s = getContributionStatus({ configDir, repoDir });
      assert.equal(s.consent, 'disabled');
      assert.equal(s.mode, 'disabled');
    });

    it('surfaces dead-letter depth and requeue guidance', () => {
      const configDir = makeTempDir('hokusai-contrib-status-');
      const repoDir = makeTempRepo({
        hokusai: {
          dataSubmission: { consentVersion: '1.0' },
          contributions: { enabled: true, endpoint: 'https://example.com/contributions' },
        },
      });
      makeEnabledConsent(configDir);
      const queueDir = join(repoDir, '.wavemill', 'hokusai', 'queue');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'dead-letter.jsonl'), `${JSON.stringify({ entry: { entryId: 'a' } })}\n`, 'utf-8');

      const s = getContributionStatus({ configDir, repoDir });
      assert.equal(s.deadLetterCount, 1);
      assert.match(s.warning ?? '', /1 dead-lettered row will not be retried/);
      assert.match(s.warning ?? '', /hokusai-manage requeue --dead-letter --dry-run/);
    });
  });

  describe('getStatusDisplay with contribution facets', () => {
    it('includes contribution queue and mode lines', () => {
      const configDir = makeTempDir('hokusai-status-display-');
      const repoDir = makeTempRepo({
        hokusai: {
          dataSubmission: { consentVersion: '1.0' },
          contributions: { enabled: true },
        },
      });
      saveUserConfig({
        hokusai: {
          enabled: true,
          consentedAt: '2026-04-14T12:00:00.000Z',
          consentVersion: '1.0',
        },
      }, configDir);

      const display = getStatusDisplay({ configDir, repoDir });
      assert.match(display, /Consent: enabled/);
      assert.match(display, /Contribution queue: enabled/);
      assert.match(display, /Upload endpoint: missing/);
      assert.match(display, /Mode: export-only/);
    });

    it('shows uploading mode when endpoint is configured', () => {
      const configDir = makeTempDir('hokusai-status-display-');
      const repoDir = makeTempRepo({
        hokusai: {
          dataSubmission: { consentVersion: '1.0' },
          contributions: { enabled: true, endpoint: 'https://api.hokus.ai/api/v1/contributions' },
        },
      });
      saveUserConfig({
        hokusai: {
          enabled: true,
          consentedAt: '2026-04-14T12:00:00.000Z',
          consentVersion: '1.0',
        },
      }, configDir);

      const display = getStatusDisplay({ configDir, repoDir });
      assert.match(display, /Consent: enabled/);
      assert.match(display, /Upload endpoint: configured/);
      assert.match(display, /Mode: uploading/);
      assert.match(display, /^Warning: .*legacy unscoped path/);
      assert.match(display, /wavemill hokusai migrate/);
    });
  });

  describe('blockers', () => {
    it('returns empty blockers when submission is allowed', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      const repoDir = makeTempRepo({
        hokusai: { contributions: { enabled: true } },
      });

      saveUserConfig({
        hokusai: {
          enabled: true,
          consentedAt: '2026-04-14T12:00:00.000Z',
          consentVersion: '1.0',
        },
      }, configDir);

      const status = getContributionConsentStatus({ configDir, repoDir });
      assert.equal(status.submissionAllowed, true);
      assert.deepEqual(status.blockers, []);
    });

    it('includes blocker when user hokusai.enabled is false', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      const repoDir = makeTempRepo({
        hokusai: { contributions: { enabled: true } },
      });

      saveUserConfig({ hokusai: { enabled: false } }, configDir);

      const status = getContributionConsentStatus({ configDir, repoDir });
      assert.equal(status.submissionAllowed, false);
      assert.equal(status.blockers.length, 1);
      assert.equal(status.blockers[0]!.setting, 'hokusai.enabled');
      assert.equal(status.blockers[0]!.value, 'false');
    });

    it('includes blocker when contributions.enabled is false', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      const repoDir = makeTempRepo({
        hokusai: { contributions: { enabled: false } },
      });

      saveUserConfig({
        hokusai: {
          enabled: true,
          consentedAt: '2026-04-14T12:00:00.000Z',
          consentVersion: '1.0',
        },
      }, configDir);

      const status = getContributionConsentStatus({ configDir, repoDir });
      assert.equal(status.submissionAllowed, false);
      assert.equal(status.blockers.length, 1);
      assert.equal(status.blockers[0]!.setting, 'hokusai.contributions.enabled');
      assert.equal(status.blockers[0]!.store, 'repo-config');
    });
  });

  describe('conflict warnings', () => {
    it('warns when repo config is on but user config is off', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      const repoDir = makeTempRepo({
        hokusai: { dataSubmission: { enabled: true }, contributions: { enabled: true } },
      });

      saveUserConfig({ hokusai: { enabled: false } }, configDir);

      const contrib = getContributionStatus({ configDir, repoDir });
      assert(contrib.warning);
      assert.match(contrib.warning, /Configuration conflict/);
      assert.match(contrib.warning, /hokusai.dataSubmission.enabled=true/);
    });

    it('warns when consent is valid but submission trigger is off', () => {
      const configDir = makeTempDir('hokusai-consent-config-');
      const repoDir = makeTempRepo({
        hokusai: { dataSubmission: { enabled: false }, contributions: { enabled: true } },
      });

      saveUserConfig({
        hokusai: {
          enabled: true,
          consentedAt: '2026-04-14T12:00:00.000Z',
          consentVersion: '1.0',
        },
      }, configDir);

      const contrib = getContributionStatus({ configDir, repoDir });
      assert(contrib.warning);
      assert.match(contrib.warning, /Configuration conflict/);
      assert.match(contrib.warning, /submission trigger is off/);
    });
  });
});
