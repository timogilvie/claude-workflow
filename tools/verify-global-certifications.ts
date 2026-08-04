#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  checkGlobalCertificationEligibility,
  resolveCertificationStorageIdentity,
  type CertificationPhase,
} from '../shared/lib/native-agent/certification/index.ts';
import { getEffectiveRegistry, type SupportedModelStage } from '../shared/lib/model-registry.ts';

const STAGE_ORDER: readonly SupportedModelStage[] = ['planning', 'coding', 'review'];
const DEFAULT_REQUIRED_PHASE: Record<SupportedModelStage, CertificationPhase> = {
  expansion: 'read-only',
  review: 'read-only',
  coding: 'patch',
  planning: 'workflow',
};

runTool({
  name: 'verify-global-certifications',
  description: 'Verify global native-agent certification artifacts for challenge-eligible registry models.',
  options: {
    repo: { type: 'string', description: 'Repository directory for effective registry. Defaults to cwd.' },
    json: { type: 'boolean', description: 'Emit machine-readable JSON.' },
  },
  examples: [
    'npx tsx tools/verify-global-certifications.ts',
    'npx tsx tools/verify-global-certifications.ts --json',
  ],
  async run({ args }) {
    const repoDir = (args.repo as string | undefined) || process.cwd();
    const registry = getEffectiveRegistry(repoDir);
    const rows = Object.entries(registry.models)
      .filter(([, capabilities]) =>
        capabilities.nativeCapability?.readOnlyNative === 'certified'
        && capabilities.supportedModel?.launchEligible === true
        && capabilities.supportedModel.lifecycle !== 'deprecated')
      .map(([modelId, capabilities]) => {
        const nativeCapability = capabilities.nativeCapability!;
        const supported = capabilities.supportedModel!;
        const requiredPhase = requiredPhaseForStages(supported.stages ?? []);
        const suiteVersion = supported.certificationSuiteVersion
          ?? nativeCapability.certification?.certificationSuiteVersion
          ?? 'v2';
        const identity = resolveCertificationStorageIdentity(nativeCapability.nativeProvider, modelId);
        const eligibility = checkGlobalCertificationEligibility(
          nativeCapability.nativeProvider,
          modelId,
          suiteVersion,
          requiredPhase,
        );
        return {
          provider: identity.provider,
          model: identity.model,
          registryModel: modelId,
          requiredPhase,
          suiteVersion,
          ready: eligibility.eligible,
          reason: eligibility.eligible ? 'eligible' : eligibility.reason,
          artifactPath: eligibility.artifactPath,
        };
      });

    if (args.json === true) {
      console.log(JSON.stringify({ models: rows }, null, 2));
    } else {
      for (const row of rows) {
        console.log(`${row.ready ? 'ready-for-challenge' : row.reason} ${row.provider}/${row.model} registry=${row.registryModel} phase=${row.requiredPhase} suite=${row.suiteVersion}`);
      }
    }

    process.exit(rows.every((row) => row.ready) ? 0 : 1);
  },
});

function requiredPhaseForStages(stages: readonly SupportedModelStage[]): CertificationPhase {
  for (const stage of STAGE_ORDER) {
    if (stages.includes(stage)) {
      return DEFAULT_REQUIRED_PHASE[stage];
    }
  }
  return 'read-only';
}
