import { getNativePatchCodingConfig, type ResolvedNativePatchCodingConfig } from '../config.ts';
import {
  loadPatchCodingCertification,
  PATCH_CODING_SMOKE_SUITE_REVISION,
  type PatchCodingCertification,
  type PatchCodingCertificationReason,
  type PatchCodingCertificationStatus,
} from './coding-certification.ts';

export type PatchCodingGateReason = 'enabled' | 'config_disabled' | PatchCodingCertificationReason;

export type PatchCodingGateResult =
  | { enabled: true; reason: 'enabled'; certification: PatchCodingCertification }
  | { enabled: false; reason: Exclude<PatchCodingGateReason, 'enabled'>; certification?: PatchCodingCertification };

export interface EvaluatePatchCodingGateInput {
  config: ResolvedNativePatchCodingConfig;
  certification: PatchCodingCertificationStatus;
  currentSmokeSuiteRevision?: string;
}

export function evaluatePatchCodingGate(input: EvaluatePatchCodingGateInput): PatchCodingGateResult {
  if (input.config.enabled !== true) {
    return { enabled: false, reason: 'config_disabled' };
  }

  if (!input.certification.valid) {
    return {
      enabled: false,
      reason: input.certification.reason,
      certification: input.certification.record,
    };
  }

  if (input.certification.record.smokeSuiteRevision !== (input.currentSmokeSuiteRevision ?? PATCH_CODING_SMOKE_SUITE_REVISION)) {
    return {
      enabled: false,
      reason: 'revision_mismatch',
      certification: input.certification.record,
    };
  }

  return {
    enabled: true,
    reason: 'enabled',
    certification: input.certification.record,
  };
}

export function isPatchCodingEnabled(repoDir: string = process.cwd()): PatchCodingGateResult {
  const config = getNativePatchCodingConfig(repoDir);
  if (config.enabled !== true) {
    return { enabled: false, reason: 'config_disabled' };
  }

  const certification = loadPatchCodingCertification(repoDir, PATCH_CODING_SMOKE_SUITE_REVISION);
  return evaluatePatchCodingGate({
    config,
    certification,
    currentSmokeSuiteRevision: PATCH_CODING_SMOKE_SUITE_REVISION,
  });
}
