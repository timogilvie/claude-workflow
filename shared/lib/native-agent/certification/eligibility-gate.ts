import type { NativeProviderName } from '../../config.ts';
import { getModel, type ModelRegistry, type ReadOnlyNativeCapability } from '../../model-registry.ts';
import {
  resolveEffectiveModel,
  type EffectiveModelExclusion,
  type EffectiveModelReasonCode,
} from '../../effective-models.ts';
import type {
  CertificationPhase,
  NativeCertificationArtifact,
} from './schema.ts';

export type NativeGateRejectReason =
  | 'missing_api_key'
  | 'unregistered_model'
  | 'missing_artifact'
  | 'malformed_artifact'
  | 'stale_artifact'
  | 'wrong_suite'
  | 'insufficient_phase';

export type NativeGateMode = 'task' | 'certification';

export interface NativeGateInput {
  modelId: string;
  mode: NativeGateMode;
  requiredPhase?: CertificationPhase;
  registry: ModelRegistry;
  repoDir?: string;
  apiKeyPresent: boolean;
  apiKeyEnv: string;
  now?: Date;
}

export interface NativeGateReady {
  ok: true;
  modelId: string;
  nativeProvider: NativeProviderName;
  storagePath?: string;
  artifact?: NativeCertificationArtifact;
  certified: boolean;
}

export interface NativeGateReject {
  ok: false;
  modelId: string;
  reason: NativeGateRejectReason;
  message: string;
  apiKeyEnv?: string;
  nativeCapability?: ReadOnlyNativeCapability | 'unregistered';
  requiredPhase?: CertificationPhase;
  foundPhase?: CertificationPhase;
  requiredSuiteVersion?: string;
  foundSuiteVersion?: string;
  certifiedAt?: string;
  artifactPath?: string;
  artifactScope?: 'global' | 'legacy-repo';
}

export type NativeGateDecision = NativeGateReady | NativeGateReject;

export function evaluateNativeProviderGate(input: NativeGateInput): NativeGateDecision {
  if (!input.apiKeyPresent) {
    return rejectDecision({
      modelId: input.modelId,
      reason: 'missing_api_key',
      apiKeyEnv: input.apiKeyEnv,
    });
  }

  const nativeCapability = getModel(input.registry, input.modelId)?.nativeCapability;
  const nativeProvider = nativeCapability?.nativeProvider;
  const capability = nativeCapability?.readOnlyNative ?? 'unregistered';

  if (input.mode === 'certification') {
    if (!input.apiKeyPresent) {
      return rejectDecision({
        modelId: input.modelId,
        reason: 'missing_api_key',
        apiKeyEnv: input.apiKeyEnv,
      });
    }
    if (!nativeProvider) {
      return rejectDecision({
        modelId: input.modelId,
        reason: 'unregistered_model',
        nativeCapability: capability,
      });
    }
    return {
      ok: true,
      modelId: input.modelId,
      nativeProvider,
      certified: false,
    };
  }

  if (!input.requiredPhase) {
    throw new Error('evaluateNativeProviderGate: requiredPhase is required in task mode');
  }

  const projection = resolveEffectiveModel({
    modelId: input.modelId,
    stage: stageForRequiredPhase(input.requiredPhase),
    registry: input.registry,
    repoDir: input.repoDir,
    now: input.now,
    apiKeyPresent: input.apiKeyPresent,
    apiKeyEnv: input.apiKeyEnv,
    checkRuntime: false,
  });

  if (!projection.usable) {
    const exclusion = selectGateExclusion(projection.exclusions);
    return rejectDecision({
      modelId: input.modelId,
      reason: mapProjectionReason(exclusion?.code ?? 'missing-artifact'),
      nativeCapability: exclusion?.nativeCapability ?? capability,
      requiredPhase: input.requiredPhase,
      foundPhase: exclusion?.foundPhase,
      requiredSuiteVersion: exclusion?.requiredSuiteVersion ?? projection.artifact.requiredSuiteVersion,
      foundSuiteVersion: exclusion?.foundSuiteVersion,
      certifiedAt: exclusion?.certifiedAt,
      artifactPath: exclusion?.artifactPath ?? projection.artifact.path,
      artifactScope: exclusion?.artifactScope,
      apiKeyEnv: exclusion?.apiKeyEnv,
    });
  }

  if (!nativeProvider) {
    return rejectDecision({
      modelId: input.modelId,
      reason: 'unregistered_model',
      nativeCapability: capability,
    });
  }
  return {
    ok: true,
    modelId: input.modelId,
    nativeProvider,
    storagePath: projection.artifact.path,
    artifact: projection.artifact.artifact,
    certified: true,
  };
}

function stageForRequiredPhase(phase: CertificationPhase): 'planning' | 'coding' | 'review' {
  if (phase === 'workflow') return 'planning';
  if (phase === 'patch') return 'coding';
  return 'review';
}

function selectGateExclusion(exclusions: readonly EffectiveModelExclusion[]): EffectiveModelExclusion | undefined {
  const priority: EffectiveModelReasonCode[] = [
    'missing-api-key',
    'no-native-capability',
    'missing-certification-metadata',
    'missing-artifact',
    'malformed-artifact',
    'wrong-identity',
    'wrong-suite',
    'stale-artifact',
    'insufficient-phase',
    'scenario-failure',
  ];
  return priority.map((code) => exclusions.find((exclusion) => exclusion.code === code)).find(Boolean)
    ?? exclusions[0];
}

function mapProjectionReason(reason: EffectiveModelReasonCode): NativeGateRejectReason {
  switch (reason) {
    case 'missing-api-key':
      return 'missing_api_key';
    case 'invalid-model-id':
    case 'unknown-model':
    case 'no-native-capability':
    case 'native-unsupported':
    case 'provider-mismatch':
      return 'unregistered_model';
    case 'missing-artifact':
    case 'wrong-identity':
    case 'missing-certification-metadata':
      return 'missing_artifact';
    case 'malformed-artifact':
      return 'malformed_artifact';
    case 'wrong-suite':
      return 'wrong_suite';
    case 'stale-artifact':
      return 'stale_artifact';
    case 'insufficient-phase':
    case 'scenario-failure':
    default:
      return 'insufficient_phase';
  }
}

function rejectDecision(input: Omit<NativeGateReject, 'ok' | 'message'>): NativeGateReject {
  return {
    ok: false,
    ...input,
    message: formatRejectMessage(input),
  };
}

function formatRejectMessage(input: Omit<NativeGateReject, 'ok' | 'message'>): string {
  const parts = [
    `reason=${input.reason}`,
    `modelId=${input.modelId}`,
  ];

  if (input.apiKeyEnv) parts.push(`apiKeyEnv=${input.apiKeyEnv}`);
  if (input.nativeCapability) parts.push(`nativeCapability=${input.nativeCapability}`);
  if (input.requiredPhase) parts.push(`requiredPhase=${input.requiredPhase}`);
  if (input.foundPhase) parts.push(`foundPhase=${input.foundPhase}`);
  if (input.requiredSuiteVersion) parts.push(`requiredSuiteVersion=${input.requiredSuiteVersion}`);
  if (input.foundSuiteVersion) parts.push(`foundSuiteVersion=${input.foundSuiteVersion}`);
  if (input.certifiedAt) parts.push(`certifiedAt=${input.certifiedAt}`);
  if (input.artifactPath) parts.push(`artifactPath=${input.artifactPath}`);
  if (input.artifactScope) parts.push(`artifactScope=${input.artifactScope}`);

  return parts.join('; ');
}
