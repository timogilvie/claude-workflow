import type { NativeProviderName } from '../../config.ts';
import { getModel, type ModelRegistry, type ReadOnlyNativeCapability } from '../../model-registry.ts';
import {
  buildGlobalCertificationPath,
  checkGlobalCertificationEligibility,
} from './loader.ts';
import { resolveCertificationSubject } from './identity.ts';
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
  | 'identity_reidentified'
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
  certificationRoot?: string;
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
  subject?: unknown;
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

  if (!nativeProvider) {
    return rejectDecision({
      modelId: input.modelId,
      reason: 'unregistered_model',
      nativeCapability: capability,
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

  const requiredSuiteVersion = nativeCapability?.certification?.certificationSuiteVersion?.trim();
  if (!requiredSuiteVersion) {
    return rejectDecision({
      modelId: input.modelId,
      reason: 'wrong_suite',
      nativeCapability: capability,
    });
  }

  const subject = resolveCertificationSubject({
    provider: nativeProvider,
    model: input.modelId,
    registry: input.registry,
  });
  const artifactPath = buildGlobalCertificationPath(
    subject.storageIdentity.provider,
    subject.storageIdentity.model,
    requiredSuiteVersion,
    { root: input.certificationRoot },
  );
  const eligibility = checkGlobalCertificationEligibility(
    subject.storageIdentity.provider,
    subject.storageIdentity.model,
    requiredSuiteVersion,
    input.requiredPhase,
    input.now,
    { root: input.certificationRoot },
    subject.subject,
  );

  if (!eligibility.eligible) {
    const artifact = eligibility.artifact;
    return rejectDecision({
      modelId: input.modelId,
      reason: mapEligibilityReason(eligibility.reason),
      nativeCapability: capability,
      requiredPhase: input.requiredPhase,
      foundPhase: artifact?.phase,
      requiredSuiteVersion,
      foundSuiteVersion: artifact?.suiteVersion,
      certifiedAt: artifact?.certifiedAt,
      artifactPath: eligibility.artifactPath ?? artifactPath,
      artifactScope: eligibility.storageScope,
      subject: eligibility.reason === 'identity-reidentified' ? subject.subject : undefined,
    });
  }

  return {
    ok: true,
    modelId: input.modelId,
    nativeProvider,
    storagePath: eligibility.artifactPath ?? artifactPath,
    artifact: eligibility.artifact,
    certified: true,
  };
}

function mapEligibilityReason(reason: 'missing' | 'malformed' | 'identity-reidentified' | 'wrong-version' | 'stale' | 'phase-insufficient' | 'scenario-failure'): NativeGateRejectReason {
  switch (reason) {
    case 'missing':
      return 'missing_artifact';
    case 'malformed':
      return 'malformed_artifact';
    case 'wrong-version':
      return 'wrong_suite';
    case 'identity-reidentified':
      return 'identity_reidentified';
    case 'stale':
      return 'stale_artifact';
    case 'phase-insufficient':
    case 'scenario-failure':
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
  if (input.subject) parts.push('subject=current-registry');

  return parts.join('; ');
}
