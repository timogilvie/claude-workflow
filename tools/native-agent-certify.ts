#!/usr/bin/env -S npx tsx

/**
 * native-agent-certify — run the certification scenario harness for a
 * specific provider/model/phase combination.
 *
 * On success (non-dry-run, live-certifiable), persists a
 * NativeCertificationArtifact to disk.
 *
 * Exit codes:
 *   0 — harness passed (dry-run or live certification written)
 *   1 — harness failed or model unsupported
 *   2 — invalid input (unknown phase, provider, or missing required flags)
 */

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  PHASE_ORDER,
  CERTIFICATION_SCHEMA_VERSION,
  type CertificationPhase,
  type NativeCertificationArtifact,
} from '../shared/lib/native-agent/certification/schema.ts';
import {
  getDefaultScenarios,
  DEFAULT_CERTIFICATION_SUITE_VERSION,
} from '../shared/lib/native-agent/certification/scenarios.ts';
import {
  runScenarios,
  toArtifactScenario,
  type RunScenariosOptions,
} from '../shared/lib/native-agent/certification/scenario-runner.ts';
import { writeCertification } from '../shared/lib/native-agent/certification/store.ts';
import { getEffectiveRegistry, type ModelRegistry, type NativeProviderName } from '../shared/lib/model-registry.ts';

const NATIVE_PROVIDERS: NativeProviderName[] = ['openai', 'openrouter'];

export interface CertifyOptions {
  provider: NativeProviderName;
  model: string;
  phase: CertificationPhase;
  repoDir: string;
  dryRun?: boolean;
  registry?: ModelRegistry;
  runScenariosFn?: typeof runScenarios;
  writeCertificationFn?: typeof writeCertification;
  now?: () => Date;
}

export interface CertifyResult {
  provider: string;
  model: string;
  phase: CertificationPhase;
  suiteVersion: string;
  dryRun: boolean;
  harnessPassed: boolean;
  liveCertifiable: boolean;
  artifactPath?: string;
  scenarios: Array<{ scenarioId: string; status: string; detail?: string }>;
  knownLimitations: string[];
}

export async function certifyNativeAgent(opts: CertifyOptions): Promise<CertifyResult> {
  const runScenariosFn = opts.runScenariosFn ?? runScenarios;
  const writeCertificationFn = opts.writeCertificationFn ?? writeCertification;
  const now = opts.now ?? (() => new Date());
  const dryRun = opts.dryRun ?? false;

  const registry = opts.registry ?? getEffectiveRegistry(opts.repoDir);
  const modelEntry = registry.models[opts.model];
  const nativeCapability = modelEntry?.nativeCapability;

  if (!nativeCapability || nativeCapability.readOnlyNative === 'unsupported') {
    throw Object.assign(
      new Error(`Model "${opts.model}" with provider "${opts.provider}" is not supported for native certification (readOnlyNative: ${nativeCapability?.readOnlyNative ?? 'unregistered'}).`),
      { exitCode: 1 },
    );
  }

  if (nativeCapability.nativeProvider !== opts.provider) {
    throw Object.assign(
      new Error(`Model "${opts.model}" is registered with provider "${nativeCapability.nativeProvider}", not "${opts.provider}".`),
      { exitCode: 1 },
    );
  }

  const transport = nativeCapability.piTransportKind;
  const suiteVersion = DEFAULT_CERTIFICATION_SUITE_VERSION;

  // Filter scenarios to those whose phase is satisfied by the requested phase
  const allScenarios = getDefaultScenarios();
  const phaseScenarios = allScenarios.filter(s => opts.phase === s.phase || PHASE_ORDER.indexOf(s.phase) <= PHASE_ORDER.indexOf(opts.phase));

  const runOpts: RunScenariosOptions = {
    provider: opts.provider,
    model: opts.model,
    transport,
    scenarios: phaseScenarios,
    registry,
    dryRun,
  };

  const report = await runScenariosFn(runOpts);

  let artifactPath: string | undefined;

  if (report.liveCertifiable && !dryRun) {
    const artifact: NativeCertificationArtifact = {
      schemaVersion: CERTIFICATION_SCHEMA_VERSION,
      provider: opts.provider,
      model: opts.model,
      phase: opts.phase,
      suiteVersion,
      certifiedAt: now().toISOString(),
      scenarios: report.results.map(toArtifactScenario),
      ...(report.knownLimitations.length > 0 ? { knownLimitations: report.knownLimitations } : {}),
    };
    artifactPath = writeCertificationFn(opts.repoDir, artifact);
  }

  return {
    provider: opts.provider,
    model: opts.model,
    phase: opts.phase,
    suiteVersion,
    dryRun,
    harnessPassed: report.harnessPassed,
    liveCertifiable: report.liveCertifiable,
    artifactPath,
    scenarios: report.results.map(r => ({
      scenarioId: r.scenarioId,
      status: r.status,
      ...(r.detail ? { detail: r.detail } : {}),
    })),
    knownLimitations: report.knownLimitations,
  };
}

if (import.meta.main) {
runTool({
  name: 'native-agent-certify',
  description: 'Run the certification scenario harness for a native provider/model/phase and persist the artifact on success.',
  options: {
    provider: {
      type: 'string',
      description: `Provider to certify. One of: ${NATIVE_PROVIDERS.join(', ')}.`,
    },
    model: {
      type: 'string',
      description: 'Model ID to certify (e.g. gpt-4o).',
    },
    phase: {
      type: 'string',
      description: `Certification phase. One of: ${PHASE_ORDER.join(', ')}.`,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Run scenarios without persisting a certification artifact.',
    },
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON.',
    },
    repo: {
      type: 'string',
      description: 'Repository directory. Defaults to current working directory.',
    },
  },
  examples: [
    'npx tsx tools/native-agent-certify.ts --provider openai --model gpt-4o --phase read-only --dry-run',
    'npx tsx tools/native-agent-certify.ts --provider openai --model gpt-4o --phase read-only',
    'npx tsx tools/native-agent-certify.ts --provider openrouter --model openai/gpt-4o --phase read-only --json',
  ],
  async run({ args }) {
    const repoDir = (args.repo as string | undefined) || process.cwd();
    const rawProvider = args.provider as string | undefined;
    const rawModel = args.model as string | undefined;
    const rawPhase = args.phase as string | undefined;
    const dryRun = args['dry-run'] === true;

    // Validate required flags
    if (!rawProvider) {
      console.error('Error: --provider is required');
      process.exit(2);
    }
    if (!rawModel) {
      console.error('Error: --model is required');
      process.exit(2);
    }
    if (!rawPhase) {
      console.error('Error: --phase is required');
      process.exit(2);
    }

    // Validate phase
    if (!(PHASE_ORDER as readonly string[]).includes(rawPhase)) {
      console.error(`Error: invalid --phase "${rawPhase}". Must be one of: ${PHASE_ORDER.join(', ')}`);
      process.exit(2);
    }

    // Validate provider
    if (!(NATIVE_PROVIDERS as readonly string[]).includes(rawProvider)) {
      console.error(`Error: invalid --provider "${rawProvider}". Must be one of: ${NATIVE_PROVIDERS.join(', ')}`);
      process.exit(2);
    }

    const phase = rawPhase as CertificationPhase;
    const provider = rawProvider as NativeProviderName;

    let result: CertifyResult;
    try {
      result = await certifyNativeAgent({ provider, model: rawModel, phase, repoDir, dryRun });
    } catch (err: unknown) {
      const exitCode = (err as { exitCode?: number }).exitCode;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(exitCode === 1 ? 1 : 2);
    }

    if (args.json === true) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const prefix = dryRun ? '[dry-run] ' : '';
      console.log(`${prefix}Provider: ${result.provider}`);
      console.log(`${prefix}Model:    ${result.model}`);
      console.log(`${prefix}Phase:    ${result.phase}`);
      console.log(`${prefix}Suite:    ${result.suiteVersion}`);
      console.log('');
      for (const s of result.scenarios) {
        const statusLabel = s.status.toUpperCase().padEnd(12);
        console.log(`  ${statusLabel} ${s.scenarioId}${s.detail ? ` — ${s.detail}` : ''}`);
      }
      if (result.knownLimitations.length > 0) {
        console.log('');
        console.log('Known limitations:');
        for (const lim of result.knownLimitations) {
          console.log(`  - ${lim}`);
        }
      }
      console.log('');
      if (result.harnessPassed) {
        if (dryRun) {
          console.log('Dry-run PASSED. No artifact written.');
        } else if (result.artifactPath) {
          console.log(`CERTIFIED. Artifact: ${result.artifactPath}`);
        } else {
          console.log('Passed (not live-certifiable — no artifact written).');
        }
      } else {
        console.log('FAILED. Certification not written.');
      }
    }

    if (!result.harnessPassed) {
      process.exit(1);
    }
  },
});
}
