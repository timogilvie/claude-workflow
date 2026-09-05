#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  CERTIFICATION_TTL_DAYS,
  DEFAULT_CERTIFICATION_SUITE_VERSION,
  evaluateEligibility,
  evaluateLiveCodingCanaryEligibility,
  loadGlobalCertification,
  resolveCertificationSubject,
  type CertificationPhase,
  type LiveCodingCanaryIneligibilityReason,
  type LiveCodingCanaryStatus,
} from '../shared/lib/native-agent/certification/index.ts';
import { getEffectiveRegistry, type ModelRegistry } from '../shared/lib/model-registry.ts';

export interface CertificationInspection {
  provider: string;
  model: string;
  suiteVersion: string;
  artifactPath?: string;
  found: boolean;
  eligible: boolean;
  reason?: string;
  phase?: string;
  certifiedAt?: string;
  expiresAt?: string;
  scenarios: Array<{ scenarioId: string; passed: boolean; failureMessage?: string }>;
  knownLimitations: string[];
  subject?: unknown;
  /**
   * Live coding canary readiness (HOK-2943). Populated whenever the artifact
   * was found; `eligible` here is the coding-specific prerequisite that must
   * hold in addition to the deterministic eligibility above.
   */
  liveCanary?: {
    eligible: boolean;
    status?: LiveCodingCanaryStatus;
    isLive?: boolean;
    ranAt?: string;
    expiresAt?: string;
    reason?: LiveCodingCanaryIneligibilityReason;
    failureReason?: string;
  };
  /** True only when deterministic eligibility for `patch` AND the live canary both hold. */
  codingEligible?: boolean;
}

export function inspectGlobalCertification(opts: {
  provider: string;
  model: string;
  suiteVersion: string;
  requiredPhase: CertificationPhase;
  now?: Date;
  registry?: ModelRegistry;
  repoDir?: string;
}): CertificationInspection {
  const registry = opts.registry ?? getEffectiveRegistry(opts.repoDir);
  const resolved = resolveCertificationSubject({
    provider: opts.provider,
    model: opts.model,
    registry,
  });
  const loaded = loadGlobalCertification(
    resolved.storageIdentity.provider,
    resolved.storageIdentity.model,
    opts.suiteVersion,
  );
  if (!loaded.ok) {
    return {
      provider: resolved.storageIdentity.provider,
      model: resolved.storageIdentity.model,
      suiteVersion: opts.suiteVersion,
      artifactPath: loaded.path,
      found: false,
      eligible: false,
      reason: loaded.reason,
      scenarios: [],
      knownLimitations: [],
    };
  }

  const eligibility = evaluateEligibility(
    loaded.artifact,
    opts.suiteVersion,
    opts.requiredPhase,
    opts.now,
    resolved.subject,
  );
  const canaryEligibility = evaluateLiveCodingCanaryEligibility(
    loaded.artifact,
    opts.suiteVersion,
    opts.now ?? new Date(),
    resolved.subject,
  );
  const canary = 'liveCanary' in loaded.artifact ? loaded.artifact.liveCanary : undefined;
  const expiresAt = loaded.artifact.expiresAt
    ?? new Date(Date.parse(loaded.artifact.certifiedAt) + CERTIFICATION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return {
    provider: loaded.artifact.provider,
    model: loaded.artifact.model,
    suiteVersion: loaded.artifact.suiteVersion,
    artifactPath: loaded.path,
    found: true,
    eligible: eligibility.eligible,
    ...(!eligibility.eligible ? { reason: eligibility.reason } : {}),
    phase: loaded.artifact.phase,
    certifiedAt: loaded.artifact.certifiedAt,
    expiresAt,
    scenarios: loaded.artifact.scenarios.map(s => ({
      scenarioId: s.scenarioId,
      passed: s.passed,
      ...(s.failureMessage ? { failureMessage: s.failureMessage } : {}),
    })),
    knownLimitations: loaded.artifact.knownLimitations ?? [],
    subject: 'subject' in loaded.artifact ? loaded.artifact.subject : undefined,
    liveCanary: {
      eligible: canaryEligibility.eligible,
      ...(canary
        ? {
          status: canary.status,
          isLive: canary.isLive,
          ranAt: canary.ranAt,
          ...(canary.expiresAt ? { expiresAt: canary.expiresAt } : {}),
          ...(canary.reason ? { failureReason: canary.reason } : {}),
        }
        : {}),
      ...(canaryEligibility.eligible ? {} : { reason: canaryEligibility.reason }),
    },
    codingEligible: eligibility.eligible
      && evaluateEligibility(loaded.artifact, opts.suiteVersion, 'patch', opts.now, resolved.subject).eligible
      && canaryEligibility.eligible,
  };
}

export function runInspectCommand(argv = process.argv.slice(2)): Promise<void> {
  return runTool({
    name: 'native-agent-certifications inspect',
    description: 'Inspect one global native-agent certification artifact.',
    options: {
      provider: { type: 'string', description: 'Provider or canonical storage provider.' },
      model: { type: 'string', description: 'Model alias, OpenRouter ID, or canonical storage model.' },
      suite: { type: 'string', description: 'Required suite version.', default: DEFAULT_CERTIFICATION_SUITE_VERSION },
      phase: { type: 'string', description: 'Required phase for eligibility.', default: 'patch' },
      json: { type: 'boolean', description: 'Emit machine-readable JSON.' },
    },
    examples: [
      'wavemill native-agent certifications inspect --provider openrouter --model qwen-3-coder',
      'wavemill native-agent certifications inspect --provider qwen --model qwen3-coder --phase workflow --json',
    ],
    async run({ args }) {
      const provider = args.provider as string | undefined;
      const model = args.model as string | undefined;
      if (!provider || !model) {
        console.error('Error: --provider and --model are required');
        process.exit(2);
      }
      const inspection = inspectGlobalCertification({
        provider,
        model,
        suiteVersion: (args.suite as string | undefined) ?? DEFAULT_CERTIFICATION_SUITE_VERSION,
        requiredPhase: ((args.phase as string | undefined) ?? 'patch') as CertificationPhase,
      });
      if (args.json === true) {
        console.log(JSON.stringify(inspection, null, 2));
        return;
      }
      console.log(`Provider: ${inspection.provider}`);
      console.log(`Model:    ${inspection.model}`);
      console.log(`Suite:    ${inspection.suiteVersion}`);
      console.log(`Found:    ${inspection.found}`);
      console.log(`Eligible: ${inspection.eligible}${inspection.reason ? ` (${inspection.reason})` : ''}`);
      if (inspection.phase) console.log(`Phase:    ${inspection.phase}`);
      if (inspection.certifiedAt) console.log(`Certified: ${inspection.certifiedAt}`);
      if (inspection.expiresAt) console.log(`Expires:  ${inspection.expiresAt}`);
      if (inspection.artifactPath) console.log(`Path:     ${inspection.artifactPath}`);
      if (inspection.liveCanary) {
        const canary = inspection.liveCanary;
        const detail = canary.status
          ? `${canary.status}${canary.isLive === false ? ' (non-live)' : ''}${canary.failureReason ? ` reason=${canary.failureReason}` : ''}${canary.ranAt ? ` ranAt=${canary.ranAt}` : ''}`
          : 'missing';
        console.log(`Live coding canary: ${detail}${canary.eligible ? '' : ` — ineligible (${canary.reason ?? 'missing'})`}`);
        console.log(`Coding eligible: ${inspection.codingEligible === true}`);
      }
      if (inspection.scenarios.length > 0) {
        console.log('Scenarios:');
        for (const scenario of inspection.scenarios) {
          console.log(`  ${scenario.passed ? 'PASS' : 'FAIL'} ${scenario.scenarioId}${scenario.failureMessage ? `: ${scenario.failureMessage}` : ''}`);
        }
      }
    },
  }, argv);
}

if (import.meta.main) {
  await runInspectCommand();
}
