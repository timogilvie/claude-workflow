#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  checkGlobalCertificationEligibility,
  DEFAULT_CERTIFICATION_SUITE_VERSION,
  resolveCertificationSubject,
  type CertificationPhase,
} from '../shared/lib/native-agent/certification/index.ts';
import { getEffectiveRegistry, type ModelRegistry } from '../shared/lib/model-registry.ts';

export interface CertificationVerification {
  ok: boolean;
  provider: string;
  model: string;
  suiteVersion: string;
  requiredPhase: CertificationPhase;
  reason?: string;
  artifactPath?: string;
}

export function verifyGlobalCertification(opts: {
  provider: string;
  model: string;
  suiteVersion: string;
  requiredPhase: CertificationPhase;
  now?: Date;
  registry?: ModelRegistry;
  repoDir?: string;
}): CertificationVerification {
  const registry = opts.registry ?? getEffectiveRegistry(opts.repoDir);
  const resolved = resolveCertificationSubject({
    provider: opts.provider,
    model: opts.model,
    registry,
  });
  const eligibility = checkGlobalCertificationEligibility(
    resolved.storageIdentity.provider,
    resolved.storageIdentity.model,
    opts.suiteVersion,
    opts.requiredPhase,
    opts.now,
    {},
    resolved.subject,
  );
  if (!eligibility.eligible) {
    return {
      ok: false,
      provider: resolved.storageIdentity.provider,
      model: resolved.storageIdentity.model,
      suiteVersion: opts.suiteVersion,
      requiredPhase: opts.requiredPhase,
      reason: eligibility.reason,
      artifactPath: eligibility.artifactPath,
    };
  }

  return {
    ok: true,
    provider: resolved.storageIdentity.provider,
    model: resolved.storageIdentity.model,
    suiteVersion: opts.suiteVersion,
    requiredPhase: opts.requiredPhase,
    artifactPath: eligibility.artifactPath,
  };
}

export function runVerifyCommand(argv = process.argv.slice(2)): Promise<void> {
  return runTool({
    name: 'native-agent-certifications verify',
    description: 'Verify a global native-agent certification without running live scenarios.',
    options: {
      provider: { type: 'string', description: 'Provider or canonical storage provider.' },
      model: { type: 'string', description: 'Model alias, OpenRouter ID, or canonical storage model.' },
      suite: { type: 'string', description: 'Required suite version.', default: DEFAULT_CERTIFICATION_SUITE_VERSION },
      phase: { type: 'string', description: 'Required phase.', default: 'patch' },
      json: { type: 'boolean', description: 'Emit machine-readable JSON.' },
    },
    examples: [
      'wavemill native-agent certifications verify --provider openrouter --model qwen-3-coder',
      'wavemill native-agent certifications verify --provider z-ai --model glm-5.2 --phase workflow --json',
    ],
    async run({ args }) {
      const provider = args.provider as string | undefined;
      const model = args.model as string | undefined;
      if (!provider || !model) {
        console.error('Error: --provider and --model are required');
        process.exit(2);
      }
      const result = verifyGlobalCertification({
        provider,
        model,
        suiteVersion: (args.suite as string | undefined) ?? DEFAULT_CERTIFICATION_SUITE_VERSION,
        requiredPhase: ((args.phase as string | undefined) ?? 'patch') as CertificationPhase,
      });
      if (args.json === true) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`${result.ok ? 'OK' : 'REJECTED'} ${result.provider}/${result.model}/${result.suiteVersion} phase=${result.requiredPhase}${result.reason ? ` reason=${result.reason}` : ''}`);
        if (result.artifactPath) console.log(result.artifactPath);
      }
      if (!result.ok) process.exit(1);
    },
  }, argv);
}

if (import.meta.main) {
  await runVerifyCommand();
}
