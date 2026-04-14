/**
 * Unit tests for hokusai-consent module
 *
 * Tests cover consent validation logic and core functionality.
 *
 * @module hokusai-consent.test
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  isConsentValid,
  UserConfig,
  recordConsent,
  revokeConsent,
  loadUserConfig,
  saveUserConfig,
} from './hokusai-consent.ts';

/**
 * Test suite for hokusai-consent module
 */
describe('hokusai-consent', () => {
  // ────────────────────────────────────────────────────────────────
  // Consent Validation Tests
  // ────────────────────────────────────────────────────────────────

  describe('isConsentValid', () => {
    it('returns false for default fresh install (no consent)', () => {
      const config: UserConfig = {};
      assert.equal(isConsentValid(config, '1.0'), false);
    });

    it('returns false when enabled but consentedAt is missing', () => {
      const config: UserConfig = {
        hokusai: {
          dataSubmission: {
            enabled: true,
            // missing consentedAt
          },
        },
      };
      assert.equal(isConsentValid(config, '1.0'), false);
    });

    it('returns false when consent version does not match requirement', () => {
      const config: UserConfig = {
        hokusai: {
          dataSubmission: {
            enabled: true,
            consentedAt: '2026-01-15T10:00:00Z',
            consentVersion: '1.0',
          },
        },
      };
      // Repo requires version 2.0, but user consented to 1.0
      assert.equal(isConsentValid(config, '2.0'), false);
    });

    it('returns false when submission is explicitly disabled', () => {
      const config: UserConfig = {
        hokusai: {
          dataSubmission: {
            enabled: false,
            consentedAt: '2026-01-15T10:00:00Z',
            consentVersion: '1.0',
          },
        },
      };
      assert.equal(isConsentValid(config, '1.0'), false);
    });

    it('returns true when all conditions are satisfied', () => {
      const config: UserConfig = {
        hokusai: {
          dataSubmission: {
            enabled: true,
            consentedAt: '2026-01-15T10:00:00Z',
            consentVersion: '1.0',
          },
        },
      };
      assert.equal(isConsentValid(config, '1.0'), true);
    });

    it('uses default consent version "1.0" when not specified', () => {
      const config: UserConfig = {
        hokusai: {
          dataSubmission: {
            enabled: true,
            consentedAt: '2026-01-15T10:00:00Z',
            consentVersion: '1.0',
          },
        },
      };
      // When repo version not specified, defaults to '1.0'
      assert.equal(isConsentValid(config), true);
    });

    it('handles missing hokusai section', () => {
      const config: UserConfig = {};
      assert.equal(isConsentValid(config, '1.0'), false);
    });

    it('handles missing dataSubmission section', () => {
      const config: UserConfig = {
        hokusai: {},
      };
      assert.equal(isConsentValid(config, '1.0'), false);
    });

    it('handles null consentedAt', () => {
      const config: UserConfig = {
        hokusai: {
          dataSubmission: {
            enabled: true,
            consentedAt: null,
            consentVersion: '1.0',
          },
        },
      };
      assert.equal(isConsentValid(config, '1.0'), false);
    });

    it('handles partially populated dataSubmission', () => {
      const config: UserConfig = {
        hokusai: {
          dataSubmission: {
            enabled: true,
            // missing consentedAt and consentVersion
          },
        },
      };
      assert.equal(isConsentValid(config, '1.0'), false);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Consent Recording & Revocation Tests
  // ────────────────────────────────────────────────────────────────

  describe('recordConsent', () => {
    let testConfigDir: string;

    beforeEach(() => {
      // Create temp directory for test config
      testConfigDir = resolve(tmpdir(), `wavemill-test-${Date.now()}`);
      mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
      // Clean up test directory
      if (existsSync(testConfigDir)) {
        rmSync(testConfigDir, { recursive: true });
      }
    });

    it('creates valid consent state with timestamp and version', async () => {
      await recordConsent('1.0', testConfigDir);

      const config = await loadUserConfig(testConfigDir);
      const submission = config.hokusai?.dataSubmission;

      assert.ok(submission, 'dataSubmission section should exist');
      assert.equal(submission.enabled, true);
      assert.equal(submission.consentVersion, '1.0');
      assert.ok(submission.consentedAt, 'consentedAt should be set');

      // Verify timestamp is valid ISO 8601
      const timestamp = new Date(submission.consentedAt!);
      assert.ok(!isNaN(timestamp.getTime()), 'consentedAt should be valid ISO 8601');
    });
  });

  describe('revokeConsent', () => {
    let testConfigDir: string;

    beforeEach(() => {
      testConfigDir = resolve(tmpdir(), `wavemill-test-${Date.now()}`);
      mkdirSync(testConfigDir, { recursive: true });
    });

    afterEach(() => {
      if (existsSync(testConfigDir)) {
        rmSync(testConfigDir, { recursive: true });
      }
    });

    it('invalidates consent by setting enabled=false and consentedAt=null', async () => {
      // First record consent
      await recordConsent('1.0', testConfigDir);

      // Then revoke it
      await revokeConsent(testConfigDir);

      const config = await loadUserConfig(testConfigDir);
      const submission = config.hokusai?.dataSubmission;

      assert.ok(submission, 'dataSubmission section should exist');
      assert.equal(submission.enabled, false);
      assert.equal(submission.consentedAt, null);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Config I/O Tests
  // ────────────────────────────────────────────────────────────────

  describe('loadUserConfig', () => {
    let testConfigDir: string;

    beforeEach(() => {
      testConfigDir = resolve(tmpdir(), `wavemill-test-${Date.now()}`);
    });

    afterEach(() => {
      if (existsSync(testConfigDir)) {
        rmSync(testConfigDir, { recursive: true });
      }
    });

    it('returns empty object when config directory does not exist', async () => {
      const config = await loadUserConfig(testConfigDir);
      assert.deepEqual(config, {});
    });

    it('returns empty object when config.json does not exist', async () => {
      mkdirSync(testConfigDir, { recursive: true });
      const config = await loadUserConfig(testConfigDir);
      assert.deepEqual(config, {});
    });

    it('handles corrupt JSON gracefully by returning empty object', async () => {
      mkdirSync(testConfigDir, { recursive: true });
      const configPath = resolve(testConfigDir, 'config.json');
      writeFileSync(configPath, 'not valid json {', 'utf-8');

      const config = await loadUserConfig(testConfigDir);
      assert.deepEqual(config, {});
    });
  });

  describe('saveUserConfig', () => {
    let testConfigDir: string;

    beforeEach(() => {
      testConfigDir = resolve(tmpdir(), `wavemill-test-${Date.now()}`);
    });

    afterEach(() => {
      if (existsSync(testConfigDir)) {
        rmSync(testConfigDir, { recursive: true });
      }
    });

    it('preserves non-hokusai keys in existing config', async () => {
      // Create initial config with non-hokusai data
      const initialConfig: UserConfig = {
        hokusai: { dataSubmission: { enabled: false } },
        someOtherKey: 'preserve this',
        anotherKey: { nested: 'value' },
      };
      await saveUserConfig(initialConfig, testConfigDir);

      // Update hokusai section
      await recordConsent('1.0', testConfigDir);

      // Load and verify
      const config = await loadUserConfig(testConfigDir);
      assert.equal(config.someOtherKey, 'preserve this');
      assert.deepEqual(config.anotherKey, { nested: 'value' });
      assert.equal(config.hokusai?.dataSubmission?.enabled, true);
    });

    it('uses atomic write pattern (temp file + rename)', async () => {
      const config: UserConfig = { hokusai: { dataSubmission: { enabled: true } } };

      // Save should succeed without throwing
      await saveUserConfig(config, testConfigDir);

      // Verify file was written
      const configPath = resolve(testConfigDir, 'config.json');
      assert.ok(existsSync(configPath), 'config.json should exist');

      // Verify no temp files left behind in testConfigDir
      const files = require('node:fs').readdirSync(testConfigDir);
      assert.deepEqual(files, ['config.json'], 'no temp files should remain');
    });
  });
});
