#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  checkGlobalCertificationEligibility,
  resolveCertificationStorageIdentity,
  type CertificationPhase,
} from '../shared/lib/native-agent/certification/index.ts';
import { checkIdentity } from '../shared/lib/native-agent/certification/validator.ts';

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
}): CertificationVerification {
  const identity = resolveCertificationStorageIdentity(opts.provider, opts.model);
  const eligibility = checkGlobalCertificationEligibility(
    opts.provider,
    opts.model,
    opts.suiteVersion,
    opts.requiredPhase,
    opts.now,
  );
  if (!eligibility.eligible) {
    return {
      ok: false,
      provider: identity.provider,
      model: identity.model,
      suiteVersion: opts.suiteVersion,
      requiredPhase: opts.requiredPhase,
      reason: eligibility.reason,
      artifactPath: eligibility.artifactPath,
    };
  }

  const identityError = checkIdentity(eligibility.artifact, identity.provider, identity.model);
  if (identityError) {
    return {
      ok: false,
      provider: identity.provider,
      model: identity.model,
      suiteVersion: opts.suiteVersion,
      requiredPhase: opts.requiredPhase,
      reason: `identity-${identityError}`,
      artifactPath: eligibility.artifactPath,
    };
  }

  return {
    ok: true,
    provider: identity.provider,
    model: identity.model,
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
      suite: { type: 'string', description: 'Required suite version.', default: 'v2' },
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
        suiteVersion: (args.suite as string | undefined) ?? 'v2',
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
