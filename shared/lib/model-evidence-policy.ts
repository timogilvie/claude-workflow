import type { EvalRecord, RoutingRole } from './eval-schema.ts';
import {
  DEFAULT_MODEL_REGISTRY,
  resolveModelIdentity,
  type ModelRegistry,
} from './model-registry.ts';

export type EvidenceUse =
  | 'router_history'
  | 'training_export'
  | 'challenge_coverage'
  | 'challenge_performance'
  | 'router_benchmark'
  | 'launch_priority_persistence'
  | 'hokusai_contribution'
  | 'hokusai_audit';

export type EvidenceHoldReason =
  | 'provisional_model_identity'
  | 'provisional_candidate_decision'
  | 'legacy_missing_attribution'
  | 'registry_provisional_fallback'
  | 'provisional-observation-only';

export interface EvidenceDecision {
  eligible: boolean;
  reasons: EvidenceHoldReason[];
  affectedRoles: RoutingRole[];
}

export interface ExecutedModelRef {
  role: RoutingRole;
  modelId: string;
  path: string;
}

export interface CandidateModelRef {
  modelId: string;
  path: string;
}

const DECISION_TRAINING_USES = new Set<EvidenceUse>([
  'training_export',
  'hokusai_contribution',
  'router_benchmark',
]);

const STRICT_FALLBACK_USES = new Set<EvidenceUse>([
  'training_export',
  'hokusai_contribution',
  'hokusai_audit',
  'launch_priority_persistence',
]);

function addRef(refs: ExecutedModelRef[], role: RoutingRole, modelId: unknown, path: string): void {
  if (typeof modelId !== 'string' || modelId.trim().length === 0) return;
  refs.push({ role, modelId: modelId.trim(), path });
}

function roleFromStage(stage: string): RoutingRole | null {
  const normalized = stage.toLowerCase();
  if (normalized === 'planner' || normalized === 'planning' || normalized === 'expansion') return 'planner';
  if (normalized === 'coder' || normalized === 'coding' || normalized === 'implementation') return 'coder';
  if (normalized === 'reviewer' || normalized === 'review') return 'reviewer';
  return null;
}

export function extractExecutedModelRefs(record: EvalRecord): ExecutedModelRef[] {
  const refs: ExecutedModelRef[] = [];
  for (const role of ['planner', 'coder', 'reviewer'] as const) {
    addRef(refs, role, record.routing?.[role]?.resolvedModelId, `routing.${role}.resolvedModelId`);
  }
  addRef(refs, 'planner', record.executedPlanning?.model, 'executedPlanning.model');
  addRef(refs, 'planner', record.planningExecutionOutcome?.model, 'planningExecutionOutcome.model');
  addRef(refs, 'coder', record.attempted_model, 'attempted_model');
  for (const [stage, descriptor] of Object.entries(record.taskDescriptor?.stages ?? {})) {
    const role = roleFromStage(stage);
    if (role) addRef(refs, role, descriptor.model, `taskDescriptor.stages.${stage}.model`);
  }
  return refs;
}

export function extractCandidateModelRefs(record: EvalRecord): CandidateModelRef[] {
  const refs: CandidateModelRef[] = [];
  record.routingDecision?.candidates?.forEach((candidate, index) => {
    if (typeof candidate.modelId === 'string' && candidate.modelId.trim().length > 0) {
      refs.push({ modelId: candidate.modelId.trim(), path: `routingDecision.candidates.${index}.modelId` });
    }
  });
  record.taskDescriptor?.constraints?.models_available?.forEach((modelId, index) => {
    if (typeof modelId === 'string' && modelId.trim().length > 0) {
      refs.push({ modelId: modelId.trim(), path: `taskDescriptor.constraints.models_available.${index}` });
    }
  });
  return refs;
}

export function isProvisionalModelId(
  modelId: string,
  registry: ModelRegistry = DEFAULT_MODEL_REGISTRY,
): boolean {
  const identity = resolveModelIdentity(registry, modelId);
  return identity.status === 'provisional' || identity.evidencePolicy === 'held';
}

function emptyDecision(): EvidenceDecision {
  return { eligible: true, reasons: [], affectedRoles: [] };
}

function makeDecision(reasons: Set<EvidenceHoldReason>, roles: Set<RoutingRole>): EvidenceDecision {
  return {
    eligible: reasons.size === 0,
    reasons: [...reasons].sort(),
    affectedRoles: [...roles].sort(),
  };
}

function addExecutedRegistryFallback(
  record: EvalRecord,
  registry: ModelRegistry,
  reasons: Set<EvidenceHoldReason>,
  affectedRoles: Set<RoutingRole>,
  reason: EvidenceHoldReason,
): void {
  for (const ref of extractExecutedModelRefs(record)) {
    if (isProvisionalModelId(ref.modelId, registry)) {
      reasons.add(reason);
      affectedRoles.add(ref.role);
    }
  }
}

function addCandidateRegistryFallback(
  record: EvalRecord,
  registry: ModelRegistry,
  reasons: Set<EvidenceHoldReason>,
): void {
  for (const ref of extractCandidateModelRefs(record)) {
    if (isProvisionalModelId(ref.modelId, registry)) {
      reasons.add('provisional_candidate_decision');
    }
  }
}

export function evaluateEvidenceEligibility(
  record: EvalRecord,
  use: EvidenceUse,
  opts: { registry?: ModelRegistry; strict?: boolean } = {},
): EvidenceDecision {
  const reasons = new Set<EvidenceHoldReason>();
  const affectedRoles = new Set<RoutingRole>();
  const attribution = record.modelIdentityAttribution;
  const registry = opts.registry ?? DEFAULT_MODEL_REGISTRY;
  const shouldFallback = opts.strict === true || STRICT_FALLBACK_USES.has(use);
  const executedFallbackReason: EvidenceHoldReason = use === 'launch_priority_persistence'
    ? 'provisional-observation-only'
    : 'registry_provisional_fallback';
  const attributedExecutedReason: EvidenceHoldReason = use === 'launch_priority_persistence'
    ? 'provisional-observation-only'
    : 'provisional_model_identity';

  if (attribution) {
    for (const role of attribution.provisionalRoles) {
      reasons.add(attributedExecutedReason);
      affectedRoles.add(role);
    }
    if (
      attribution.candidateOnlyProvisional.length > 0
      && DECISION_TRAINING_USES.has(use)
    ) {
      reasons.add('provisional_candidate_decision');
    }
    if (shouldFallback) {
      addExecutedRegistryFallback(record, registry, reasons, affectedRoles, executedFallbackReason);
      if (DECISION_TRAINING_USES.has(use)) {
        addCandidateRegistryFallback(record, registry, reasons);
      }
    }
    return makeDecision(reasons, affectedRoles);
  }

  if (!shouldFallback) {
    return emptyDecision();
  }

  addExecutedRegistryFallback(record, registry, reasons, affectedRoles, executedFallbackReason);
  if (DECISION_TRAINING_USES.has(use)) {
    addCandidateRegistryFallback(record, registry, reasons);
  }
  return makeDecision(reasons, affectedRoles);
}

export function partitionEvidence<T extends EvalRecord>(
  records: T[],
  use: EvidenceUse,
  opts: { registry?: ModelRegistry; strict?: boolean } = {},
): {
  eligible: T[];
  excluded: Array<{ record: T; decision: EvidenceDecision }>;
  reasonCounts: Record<string, number>;
} {
  const eligible: T[] = [];
  const excluded: Array<{ record: T; decision: EvidenceDecision }> = [];
  const reasonCounts: Record<string, number> = {};

  for (const record of records) {
    const decision = evaluateEvidenceEligibility(record, use, opts);
    if (decision.eligible) {
      eligible.push(record);
      continue;
    }
    excluded.push({ record, decision });
    for (const reason of decision.reasons) {
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
  }

  return { eligible, excluded, reasonCounts };
}

export function formatEvidenceExclusionSummary(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ');
}
