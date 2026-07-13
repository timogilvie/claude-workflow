import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { verifyNativeProviderGateAgreement } from './hok2423-verify-native-provider-gate.ts';

describe('hok2423 native provider gate verifier', () => {
  it('keeps report eligibility aligned with resolver readiness across fixture cases', () => {
    const summary = verifyNativeProviderGateAgreement(new Date('2026-07-12T12:00:00.000Z'));

    assert.equal(summary.passed, true);

    const patchReady = summary.cases.find((entry) => entry.caseId === 'openrouter-patch-ready');
    assert.ok(patchReady);
    assert.deepEqual(
      patchReady.phaseChecks.map((entry) => [entry.requiredPhase, entry.resolverReady]),
      [
        ['read-only', true],
        ['patch', true],
        ['workflow', false],
      ],
    );

    const stale = summary.cases.find((entry) => entry.caseId === 'stale-artifact');
    assert.ok(stale);
    assert.equal(stale.reportState, 'stale');
    assert.equal(stale.certificationModeStatus, 'ready');
    assert.ok(stale.phaseChecks.every((entry) => entry.matches));

    const wrongIdentity = summary.cases.find((entry) => entry.caseId === 'wrong-identity-artifact');
    assert.ok(wrongIdentity);
    assert.equal(wrongIdentity.reportState, 'uncertified');
    assert.deepEqual(wrongIdentity.reportEligibleStages, []);
  });
});
