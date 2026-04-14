/**
 * Unit tests for hokasai-consent module
 *
 * Tests cover consent validation logic and core functionality.
 *
 * @module hokasai-consent.test
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isConsentValid, UserConfig } from './hokasai-consent.ts';

/**
 * Test suite for hokasai-consent module
 */
describe('hokasai-consent', () => {
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
});
