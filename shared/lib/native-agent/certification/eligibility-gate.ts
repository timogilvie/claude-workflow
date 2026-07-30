import type { NativeProviderName } from '../../config.ts';
import type { ModelRegistry, ReadOnlyNativeCapability } from '../../model-registry.ts';
import { projectEffectiveModel, type EffectiveModelReasonCode } from '../../effective-models.ts';
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

  const projection = projectEffectiveModel({
    modelId: input.modelId,
    stage: phaseToStage(input.requiredPhase ?? 'read-only'),
    useCase: input.mode === 'certification' ? 'certification' : 'provider-gate',
    registry: input.registry,
    repoDir: input.repoDir,
    now: input.now,
    apiKeyPresent: input.apiKeyPresent,
    apiKeyEnv: input.apiKeyEnv,
    requireNative: true,
    requireCertification: input.mode !== 'certification',
  });

  const nativeProvider = projection.identity.nativeProvider;
  if (!nativeProvider) {
    return rejectDecision({
      modelId: input.modelId,
      reason: 'unregistered_model',
      nativeCapability: projection.registry.nativeCapability ?? 'unregistered',
    });
  }

  if (input.mode === 'certification') {
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

  if (!input.repoDir) {
    throw new Error('evaluateNativeProviderGate: repoDir is required in task mode');
  }

  if (!projection.eligible) {
    const artifact = projection.certification.artifact;
    return rejectDecision({
      modelId: input.modelId,
      reason: mapProjectionReason(projection.primaryReason),
      nativeCapability: projection.registry.nativeCapability ?? 'unregistered',
      requiredPhase: input.requiredPhase,
      foundPhase: projection.certification.certifiedPhase,
      requiredSuiteVersion: projection.certification.requiredSuiteVersion,
      foundSuiteVersion: projection.certification.foundSuiteVersion,
      certifiedAt: projection.certification.certifiedAt,
      artifactPath: projection.certification.artifactPath,
      artifactScope: projection.certification.artifactScope,
    });
  }

  return {
    ok: true,
    modelId: input.modelId,
    nativeProvider,
    storagePath: projection.certification.artifactPath,
    artifact: projection.certification.artifact,
    certified: true,
  };
}

function phaseToStage(phase: CertificationPhase): 'planner' | 'coder' | 'reviewer' {
  if (phase === 'workflow') return 'planner';
  if (phase === 'patch') return 'coder';
  return 'reviewer';
}

function mapProjectionReason(reason: EffectiveModelReasonCode | undefined): NativeGateRejectReason {
  switch (reason) {
    case 'missing_api_key':
    case 'provider_disabled':
    case 'provider_stage_disabled':
    case 'provider_model_not_allowed':
    case 'direct_agents_disabled':
      return 'missing_api_key';
    case 'missing_artifact':
      return 'missing_artifact';
    case 'malformed_artifact':
      return 'malformed_artifact';
    case 'wrong_identity':
      return 'missing_artifact';
    case 'wrong_suite':
      return 'wrong_suite';
    case 'stale_artifact':
      return 'stale_artifact';
    case 'insufficient_phase':
    case 'scenario_failure':
      return 'insufficient_phase';
    case 'unregistered_model':
    case 'no_native_capability':
      return 'unregistered_model';
    default:
      return 'missing_artifact';
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
