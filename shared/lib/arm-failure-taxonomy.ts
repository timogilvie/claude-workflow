export type TerminalFailureKind =
  | 'context-window-exceeded'
  | 'invalid-model-id'
  | 'provider-rate-limited'
  | 'provider-quota-exhausted'
  | 'tool-use-unsupported'
  | 'native-provider-error';

export type ArmFaultClass =
  | 'harness-fault'
  | 'selection-fault'
  | 'provider-fault'
  | 'model-fault'
  | 'unknown-fault';

export type ChallengeArmSide = 'primary' | 'challenger';

export interface ChallengeArmFailure {
  side: ChallengeArmSide;
  model: string;
  stage?: string;
  failureKind?: string;
  faultClass?: ArmFaultClass;
  detail?: string;
}

/**
 * Classify terminal arm failures without feeding them into the quality corpus.
 *
 * Reliability is recorded for every failed arm. Model quality remains limited to
 * real EvalRecords; only future consumers that explicitly opt into
 * qualitySignalEligible should treat provider/model faults as model signal.
 * Harness, selection, and unknown faults are intentionally excluded so routing
 * does not learn to avoid a model because of our configuration or scheduling.
 */
export function classifyArmFault(input: { failureKind?: string | null; detail?: string | null }): ArmFaultClass {
  const failureKind = input.failureKind ?? '';
  const detail = (input.detail ?? '').toLowerCase();

  switch (failureKind) {
    case 'context-window-exceeded':
    case 'invalid-model-id':
      return 'harness-fault';
    case 'tool-use-unsupported':
    case 'varied_model_unresolvable':
      return 'selection-fault';
    case 'provider-rate-limited':
    case 'provider-quota-exhausted':
      return 'provider-fault';
    case 'native-provider-error':
      if (/(finish_reason|malformed|truncated stream|stream ended without|invalid response|unusable result)/.test(detail)) {
        return 'model-fault';
      }
      if (/(5\d\d|server error|overloaded|bad gateway|unavailable|service unavailable|gateway timeout|upstream)/.test(detail)) {
        return 'provider-fault';
      }
      return 'unknown-fault';
    default:
      return 'unknown-fault';
  }
}

export function parseAbortFailureKind(abortReason?: string | null): string | null {
  if (!abortReason) {
    return null;
  }
  const trimmed = abortReason.trim();
  if (trimmed === 'varied_model_unresolvable') {
    return trimmed;
  }
  const match = /^(?:terminal_stage_failure|terminal_launch_failure):(.+)$/.exec(trimmed);
  return match?.[1]?.trim() || null;
}

export function isModelQualitySignal(faultClass: ArmFaultClass): boolean {
  return faultClass === 'model-fault' || faultClass === 'provider-fault';
}

export function faultClassReason(faultClass: ArmFaultClass): string {
  switch (faultClass) {
    case 'harness-fault':
      return 'the harness misconfigured or overfed a capable model';
    case 'selection-fault':
      return 'the model was never eligible for this stage';
    case 'provider-fault':
      return 'the upstream provider failed or throttled the request';
    case 'model-fault':
      return 'the model produced an unusable result';
    case 'unknown-fault':
      return 'the failure could not be attributed confidently';
  }
}

export function describeArmFailure(input: {
  role: ChallengeArmSide;
  model: string;
  stage?: string | null;
  failureKind?: string | null;
  faultClass?: ArmFaultClass | null;
  detail?: string | null;
}): string {
  const role = input.role === 'primary' ? 'Primary' : 'Challenger';
  const stage = input.stage ? ` at ${input.stage}` : '';
  const kind = input.failureKind || 'unknown failure';
  const fault = input.faultClass ? ` (${input.faultClass} - ${faultClassReason(input.faultClass)})` : '';
  return `${role} arm (${input.model || 'unknown'}) failed${stage}: ${kind}${fault}.`;
}
