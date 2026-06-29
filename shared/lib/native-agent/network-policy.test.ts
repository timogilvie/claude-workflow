import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_NETWORK_POLICY,
  enforceNetworkPolicy,
  evaluateNetworkPolicy,
  type NetworkPolicy,
} from './network-policy.ts';

describe('evaluateNetworkPolicy', () => {
  it('allows exact-host matches case-insensitively', () => {
    const policy: NetworkPolicy = {
      review: {
        github_create_pr: { kind: 'allowlist', hosts: ['api.github.com'] },
      },
    };

    assert.deepEqual(
      evaluateNetworkPolicy({
        policy,
        phase: 'review',
        tool: 'github_create_pr',
        target: 'https://API.GitHub.com/repos/acme/widgets',
      }),
      { decision: 'allow', matchedRule: 'allowlist:api.github.com' },
    );
  });

  it('denies mismatched hosts and invalid allowlist targets', () => {
    const policy: NetworkPolicy = {
      review: {
        github_create_pr: { kind: 'allowlist', hosts: ['api.github.com'] },
      },
    };

    assert.deepEqual(
      evaluateNetworkPolicy({
        policy,
        phase: 'review',
        tool: 'github_create_pr',
        target: 'https://uploads.github.com/repos/acme/widgets',
      }),
      { decision: 'deny', reason: 'not_allowed', matchedRule: 'allowlist:api.github.com' },
    );
    assert.deepEqual(
      evaluateNetworkPolicy({
        policy,
        phase: 'review',
        tool: 'github_create_pr',
        target: 'api.github.com',
      }),
      { decision: 'deny', reason: 'invalid_target', matchedRule: 'allowlist:api.github.com' },
    );
  });

  it('defaults to deny on missing phase or tool without mutating the policy', () => {
    const policy: NetworkPolicy = {
      review: {
        github_create_pr: { kind: 'allowlist', hosts: ['api.github.com'] },
      },
    };
    const snapshot = JSON.stringify(policy);

    assert.deepEqual(
      evaluateNetworkPolicy({
        policy,
        phase: 'coding',
        tool: 'github_create_pr',
        target: 'https://api.github.com',
      }),
      { decision: 'deny', reason: 'missing_policy' },
    );
    assert.deepEqual(
      evaluateNetworkPolicy({
        policy,
        phase: 'review',
        tool: 'github_add_label',
        target: 'https://api.github.com',
      }),
      { decision: 'deny', reason: 'missing_policy' },
    );
    assert.equal(JSON.stringify(policy), snapshot);
  });

  it('supports allow and deny rules for opaque command targets', () => {
    assert.deepEqual(
      evaluateNetworkPolicy({
        policy: {
          planning: {
            route_task: { kind: 'allow' },
          },
        },
        phase: 'planning',
        tool: 'route_task',
        target: 'command:route_task',
      }),
      { decision: 'allow', matchedRule: 'allow' },
    );
    assert.deepEqual(
      evaluateNetworkPolicy({
        policy: {
          planning: {
            route_task: { kind: 'deny' },
          },
        },
        phase: 'planning',
        tool: 'route_task',
        target: 'command:route_task',
      }),
      { decision: 'deny', reason: 'not_allowed', matchedRule: 'deny' },
    );
  });
});

describe('enforceNetworkPolicy', () => {
  it('redacts secrets in denied diagnostics while preserving safe target context', () => {
    const denied = enforceNetworkPolicy({
      policy: {
        review: {
          github_create_pr: { kind: 'allowlist', hosts: ['api.github.com'] },
        },
      },
      phase: 'review',
      tool: 'github_create_pr',
      target: 'https://ghp_123456789012345678901234567890123456@uploads.github.com/repos/acme/widgets',
    });

    assert.equal(denied.kind, 'deny');
    if (denied.kind !== 'deny') {
      return;
    }
    assert.equal(denied.error, 'policy_denied');
    assert.equal(denied.diagnostics.category, 'network');
    assert.equal(denied.diagnostics.target.includes('ghp_123456789012345678901234567890123456'), false);
    assert.equal(denied.diagnostics.target.includes('uploads.github.com'), true);
  });

  it('uses the default policy and distinguishes missing-policy from allow/deny', () => {
    assert.deepEqual(
      enforceNetworkPolicy({
        phase: 'review',
        tool: 'github_add_label',
        target: 'https://api.github.com/repos/acme/widgets',
      }),
      { kind: 'allow' },
    );

    const denied = enforceNetworkPolicy({
      policy: {},
      phase: 'review',
      tool: 'github_add_label',
      target: 'https://api.github.com/repos/acme/widgets',
    });
    assert.equal(denied.kind, 'deny');
    if (denied.kind !== 'deny') {
      return;
    }
    assert.equal(denied.diagnostics.reason, 'missing_policy');
  });

  it('never allows invalid URL targets on allowlist rules', () => {
    const denied = enforceNetworkPolicy({
      policy: {
        planning: {
          linear_get_issue: { kind: 'allowlist', hosts: ['api.linear.app'] },
        },
      },
      phase: 'planning',
      tool: 'linear_get_issue',
      target: 'command:linear_get_issue',
    });

    assert.equal(denied.kind, 'deny');
    if (denied.kind !== 'deny') {
      return;
    }
    assert.equal(denied.diagnostics.reason, 'invalid_target');
  });
});

describe('DEFAULT_NETWORK_POLICY', () => {
  it('denies coding-phase network access for network-capable tools by default', () => {
    const denied = enforceNetworkPolicy({
      policy: DEFAULT_NETWORK_POLICY,
      phase: 'coding',
      tool: 'linear_comment',
      target: 'https://api.linear.app',
    });

    assert.equal(denied.kind, 'deny');
    if (denied.kind !== 'deny') {
      return;
    }
    assert.equal(denied.diagnostics.reason, 'not_allowed');
  });
});
