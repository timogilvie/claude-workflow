import { redactSecrets } from './tools/redaction.ts';
import type { WorkflowPhase, WorkflowToolName } from './workflow-tools/contracts.ts';

export interface NetworkRuleAllow {
  kind: 'allow';
}

export interface NetworkRuleDeny {
  kind: 'deny';
}

export interface NetworkRuleAllowlist {
  kind: 'allowlist';
  hosts: readonly string[];
}

export type NetworkRule = NetworkRuleAllow | NetworkRuleDeny | NetworkRuleAllowlist;

export type NetworkPolicy = Readonly<
  Partial<Record<WorkflowPhase, Partial<Record<WorkflowToolName, NetworkRule>>>>
>;

export type NetworkPolicyDecision =
  | { decision: 'allow'; matchedRule?: string }
  | {
      decision: 'deny';
      reason: 'missing_policy' | 'not_allowed' | 'invalid_target';
      matchedRule?: string;
    };

export interface EvaluateNetworkPolicyInput {
  policy: NetworkPolicy;
  phase: WorkflowPhase;
  tool: WorkflowToolName;
  target: string;
}

export interface NetworkDeniedDiagnostics {
  category: 'network';
  phase: WorkflowPhase;
  tool: WorkflowToolName;
  reason: 'missing_policy' | 'not_allowed' | 'invalid_target';
  target: string;
  matchedRule?: string;
}

export type NetworkEnforcement =
  | { kind: 'allow' }
  | {
      kind: 'deny';
      error: 'policy_denied';
      message: string;
      diagnostics: NetworkDeniedDiagnostics;
    };

export interface EnforceNetworkPolicyInput {
  policy?: NetworkPolicy;
  phase: WorkflowPhase;
  tool: WorkflowToolName;
  target: string;
}

export const DEFAULT_NETWORK_POLICY: NetworkPolicy = {
  planning: {
    linear_get_issue: { kind: 'allowlist', hosts: ['api.linear.app'] },
    linear_comment: { kind: 'allowlist', hosts: ['api.linear.app'] },
    expand_issue: { kind: 'deny' },
    route_task: { kind: 'deny' },
    review_changes: { kind: 'deny' },
  },
  coding: {
    linear_get_issue: { kind: 'deny' },
    linear_comment: { kind: 'deny' },
    expand_issue: { kind: 'deny' },
    route_task: { kind: 'deny' },
    review_changes: { kind: 'deny' },
    github_create_pr: { kind: 'deny' },
    github_add_label: { kind: 'deny' },
  },
  review: {
    linear_get_issue: { kind: 'allowlist', hosts: ['api.linear.app'] },
    linear_comment: { kind: 'allowlist', hosts: ['api.linear.app'] },
    github_create_pr: { kind: 'allowlist', hosts: ['api.github.com'] },
    github_add_label: { kind: 'allowlist', hosts: ['api.github.com'] },
    expand_issue: { kind: 'deny' },
    route_task: { kind: 'deny' },
    review_changes: { kind: 'deny' },
  },
  ready: {
    github_create_pr: { kind: 'allowlist', hosts: ['api.github.com'] },
    github_add_label: { kind: 'allowlist', hosts: ['api.github.com'] },
    linear_get_issue: { kind: 'deny' },
    linear_comment: { kind: 'deny' },
    expand_issue: { kind: 'deny' },
    route_task: { kind: 'deny' },
    review_changes: { kind: 'deny' },
  },
};

export function evaluateNetworkPolicy(input: EvaluateNetworkPolicyInput): NetworkPolicyDecision {
  const phasePolicy = input.policy[input.phase];
  const rule = phasePolicy?.[input.tool];
  if (!rule) {
    return { decision: 'deny', reason: 'missing_policy' };
  }

  const matchedRule = describeRule(rule);
  if (rule.kind === 'deny') {
    return { decision: 'deny', reason: 'not_allowed', matchedRule };
  }
  if (rule.kind === 'allow') {
    return { decision: 'allow', matchedRule };
  }

  const hostname = extractHostname(input.target);
  if (!hostname) {
    return { decision: 'deny', reason: 'invalid_target', matchedRule };
  }

  return rule.hosts.some((host) => host.toLowerCase() === hostname)
    ? { decision: 'allow', matchedRule }
    : { decision: 'deny', reason: 'not_allowed', matchedRule };
}

export function enforceNetworkPolicy(input: EnforceNetworkPolicyInput): NetworkEnforcement {
  const decision = evaluateNetworkPolicy({
    policy: input.policy ?? DEFAULT_NETWORK_POLICY,
    phase: input.phase,
    tool: input.tool,
    target: input.target,
  });
  if (decision.decision === 'allow') {
    return { kind: 'allow' };
  }

  const target = redactSecrets(input.target).text;
  const message = redactSecrets(
    `Network access denied for ${input.tool} in ${input.phase} phase: ${decision.reason}`,
  ).text;

  return {
    kind: 'deny',
    error: 'policy_denied',
    message,
    diagnostics: {
      category: 'network',
      phase: input.phase,
      tool: input.tool,
      reason: decision.reason,
      target,
      ...(decision.matchedRule ? { matchedRule: decision.matchedRule } : {}),
    },
  };
}

function describeRule(rule: NetworkRule): string {
  if (rule.kind !== 'allowlist') {
    return rule.kind;
  }
  return `allowlist:${rule.hosts.map((host) => host.toLowerCase()).join(',')}`;
}

function extractHostname(target: string): string | null {
  try {
    const parsed = new URL(target);
    const hostname = parsed.hostname.trim().toLowerCase();
    return hostname === '' ? null : hostname;
  } catch {
    return null;
  }
}
