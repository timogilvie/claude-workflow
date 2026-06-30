#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  runCertification,
  formatCertifyText,
} from '../shared/lib/native-agent/certification/certify-command.ts';
import { PHASE_ORDER } from '../shared/lib/native-agent/certification/schema.ts';
import type { NativeProviderName } from '../shared/lib/model-registry.ts';
import type { CertificationPhase } from '../shared/lib/native-agent/certification/schema.ts';

const VALID_PROVIDERS: readonly NativeProviderName[] = ['openai', 'openrouter'];

if (import.meta.main) {
  runTool({
    name: 'native-agent-certify',
    description: 'Run the deterministic certification scenario harness for a native-agent provider/model. Dry-run by default (no paid calls, no artifact written). Pass --write to run live and persist the artifact on success.',
    options: {
      provider: {
        type: 'string',
        description: `Native provider to certify. One of: ${VALID_PROVIDERS.join(', ')}.`,
      },
      model: {
        type: 'string',
        description: 'Model identifier to certify (e.g. gpt-4o).',
      },
      phase: {
        type: 'string',
        description: `Certification phase to target. One of: ${PHASE_ORDER.join(', ')}. Defaults to read-only.`,
        default: 'read-only',
      },
      repo: {
        type: 'string',
        description: 'Repository directory. Defaults to current working directory.',
      },
      json: {
        type: 'boolean',
        description: 'Emit machine-readable JSON instead of human-readable output.',
      },
      write: {
        type: 'boolean',
        description: 'Perform a live run and write the certification artifact on success. Without this flag the run is a dry-run (no paid API calls, no artifact written).',
      },
    },
    examples: [
      'npx tsx tools/native-agent-certify.ts --provider openai --model gpt-4o',
      'npx tsx tools/native-agent-certify.ts --provider openrouter --model openai/gpt-4o-mini --phase read-only --json',
      'npx tsx tools/native-agent-certify.ts --provider openai --model gpt-4o --write',
    ],
    async run({ args }) {
      const repoDir = (args.repo as string | undefined) ?? process.cwd();

      const provider = args.provider as string | undefined;
      if (!provider) {
        throw new Error('--provider is required. Valid values: ' + VALID_PROVIDERS.join(', '));
      }
      if (!(VALID_PROVIDERS as readonly string[]).includes(provider)) {
        throw new Error(
          `Invalid --provider "${provider}". Valid values: ${VALID_PROVIDERS.join(', ')}`,
        );
      }

      const model = args.model as string | undefined;
      if (!model || model.trim().length === 0) {
        throw new Error('--model is required (e.g. --model gpt-4o)');
      }

      const phaseArg = (args.phase as string | undefined) ?? 'read-only';
      if (!(PHASE_ORDER as readonly string[]).includes(phaseArg)) {
        throw new Error(
          `Invalid --phase "${phaseArg}". Valid values: ${PHASE_ORDER.join(', ')}`,
        );
      }
      const phase = phaseArg as CertificationPhase;

      const write = args.write === true;
      const dryRun = !write;

      const result = await runCertification({
        repoDir,
        provider: provider as NativeProviderName,
        model: model.trim(),
        phase,
        dryRun,
      });

      if (args.json === true) {
        const output = {
          provider: result.report.provider,
          model: result.report.model,
          transport: result.report.transport,
          phase,
          dryRun: result.report.dryRun,
          harnessPassed: result.report.harnessPassed,
          liveCertifiable: result.report.liveCertifiable,
          wrote: result.wrote,
          artifactPath: result.artifactPath ?? null,
          scenarios: result.report.results.map((r) => ({
            scenarioId: r.scenarioId,
            status: r.status,
            detail: r.detail ?? null,
            attempts: r.attempts ?? null,
            knownLimitation: r.knownLimitation ?? null,
          })),
          knownLimitations: result.report.knownLimitations,
          countsByStatus: result.report.countsByStatus,
        };
        console.log(JSON.stringify(output, null, 2));
      } else {
        console.log(formatCertifyText(result));
      }

      // Non-zero exit when harness didn't pass
      // (matches certify-patch-coding.ts exit semantics)
      if (!result.report.harnessPassed) {
        const isDryRun = result.report.dryRun;
        throw new Error(
          isDryRun
            ? `Certification dry-run failed: one or more scenarios did not pass (provider=${provider}, model=${model}, phase=${phase}).`
            : `Certification failed: no artifact was written (provider=${provider}, model=${model}, phase=${phase}).`,
        );
      }
    },
  });
}
