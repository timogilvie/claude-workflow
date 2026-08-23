#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  CERTIFICATION_TTL_DAYS,
  evaluateEligibility,
  loadGlobalCertification,
  resolveCertificationSubject,
  type CertificationPhase,
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
  };
}

export function runInspectCommand(argv = process.argv.slice(2)): Promise<void> {
  return runTool({
    name: 'native-agent-certifications inspect',
    description: 'Inspect one global native-agent certification artifact.',
    options: {
      provider: { type: 'string', description: 'Provider or canonical storage provider.' },
      model: { type: 'string', description: 'Model alias, OpenRouter ID, or canonical storage model.' },
      suite: { type: 'string', description: 'Required suite version.', default: 'v2' },
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
        suiteVersion: (args.suite as string | undefined) ?? 'v2',
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
