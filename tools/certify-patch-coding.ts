#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
  writePatchCodingCertification,
  type PatchCodingCertification,
  type PatchCodingProviderResult,
} from '../shared/lib/native-agent/coding-certification.ts';
import {
  PATCH_CODING_SMOKE_SUITE_REVISION,
  SMOKE_PROVIDERS,
  runNativeAgentDryRun,
  runNativeAgentLive,
  type SmokeProvider,
} from '../shared/lib/native-agent/smoke.ts';

export interface ProviderModelPair {
  provider: SmokeProvider;
  model: string;
}

export interface CertificationReport {
  certified: boolean;
  smokeSuiteRevision: string;
  artifactPath?: string;
  providers: PatchCodingProviderResult[];
}

export interface CertifyPatchCodingOptions {
  repoDir: string;
  pairs: ProviderModelPair[];
  dryRun?: boolean;
  runDrySmoke?: typeof runNativeAgentDryRun;
  runLiveSmoke?: typeof runNativeAgentLive;
  writeCertification?: typeof writePatchCodingCertification;
  now?: () => Date;
}

export function parseProviderModelPairs(args: { provider?: string[]; providers?: string | undefined }): ProviderModelPair[] {
  const entries = [
    ...(args.provider ?? []),
    ...((args.providers ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)),
  ];

  return entries.map((entry) => {
    const [provider, ...modelParts] = entry.split(':');
    const model = modelParts.join(':').trim();
    if (!(SMOKE_PROVIDERS as readonly string[]).includes(provider) || model.length === 0) {
      throw new Error(
        `Invalid provider/model pair "${entry}". Expected one of ${SMOKE_PROVIDERS.join(', ')} with format provider:model.`,
      );
    }
    return { provider: provider as SmokeProvider, model };
  });
}

export function ensureDistinctMinimum(pairs: ProviderModelPair[]): void {
  const distinct = new Set(pairs.map((pair) => `${pair.provider}::${pair.model}`));
  if (distinct.size !== pairs.length) {
    throw new Error('Duplicate provider/model pairs are not allowed in patch coding certification.');
  }
  if (distinct.size < 2) {
    throw new Error('Patch coding certification requires at least two distinct provider/model pairs.');
  }
}

export async function certifyPatchCoding(options: CertifyPatchCodingOptions): Promise<CertificationReport> {
  ensureDistinctMinimum(options.pairs);

  const runDrySmoke = options.runDrySmoke ?? runNativeAgentDryRun;
  const runLiveSmoke = options.runLiveSmoke ?? runNativeAgentLive;
  const writeCertification = options.writeCertification ?? writePatchCodingCertification;
  const now = options.now ?? (() => new Date());

  const providerResults: PatchCodingProviderResult[] = [];
  for (const pair of options.pairs) {
    const smokeResult = options.dryRun === true
      ? await runDrySmoke({
        provider: pair.provider,
        phase: 'coding',
        repoDir: options.repoDir,
        _modelIdOverride: pair.model,
        _certificationMode: true,
      })
      : await runLiveSmoke({
        provider: pair.provider,
        phase: 'coding',
        repoDir: options.repoDir,
        _modelIdOverride: pair.model,
        _certificationMode: true,
      });

    providerResults.push({
      provider: pair.provider,
      model: pair.model,
      passed: smokeResult.outcome === 'ok',
      transcriptPath: smokeResult.transcriptPath || undefined,
      skipReason: smokeResult.skipReason,
    });
  }

  const allPassed = providerResults.every((result) => result.passed);
  const report: CertificationReport = {
    certified: allPassed && options.dryRun !== true,
    smokeSuiteRevision: PATCH_CODING_SMOKE_SUITE_REVISION,
    providers: providerResults,
  };

  if (report.certified) {
    const certification: PatchCodingCertification = {
      schemaVersion: PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
      certified: true,
      smokeSuiteRevision: PATCH_CODING_SMOKE_SUITE_REVISION,
      providers: providerResults,
      certifiedAt: now().toISOString(),
    };
    report.artifactPath = writeCertification(options.repoDir, certification);
  }

  return report;
}

if (import.meta.main) {
  runTool({
    name: 'certify-patch-coding',
    description: 'Run native coding smoke against exact provider/model pairs and write the patch-coding certification artifact on success.',
    options: {
      provider: {
        type: 'string',
        multiple: true,
        description: 'Repeatable provider:model pair, for example --provider openai:gpt-4o',
      },
      providers: {
        type: 'string',
        description: 'Comma-separated provider:model pairs.',
      },
      repo: {
        type: 'string',
        description: 'Repository directory. Defaults to current working directory.',
      },
      json: {
        type: 'boolean',
        description: 'Emit machine-readable JSON.',
      },
      'dry-run': {
        type: 'boolean',
        description: 'Run dry smoke only. Does not write a valid certification artifact.',
      },
    },
    examples: [
      'npx tsx tools/certify-patch-coding.ts --provider openai:gpt-4o --provider openrouter:openai/gpt-4o-mini',
      'npx tsx tools/certify-patch-coding.ts --providers openai:gpt-4o,openrouter:openai/gpt-4o-mini --json',
    ],
    async run({ args }) {
      const repoDir = (args.repo as string | undefined) || process.cwd();
      const pairs = parseProviderModelPairs({
        provider: args.provider as string[] | undefined,
        providers: args.providers as string | undefined,
      });

      const report = await certifyPatchCoding({
        repoDir,
        pairs,
        dryRun: args['dry-run'] === true,
      });

      if (args.json === true) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(`Smoke suite revision: ${report.smokeSuiteRevision}`);
        for (const result of report.providers) {
          console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.provider}:${result.model}`);
          if (result.skipReason) {
            console.log(`  reason: ${result.skipReason}`);
          }
          if (result.transcriptPath) {
            console.log(`  transcript: ${result.transcriptPath}`);
          }
        }
        if (report.artifactPath) {
          console.log(`Certification artifact: ${report.artifactPath}`);
        }
      }

      if (!report.certified) {
        const dryRunPassed =
          args['dry-run'] === true && report.providers.every((provider) => provider.passed);
        if (dryRunPassed) {
          return;
        }
        throw new Error(
          args['dry-run'] === true
            ? 'Dry-run completed. Certification artifact not written.'
            : 'Patch coding certification failed. No valid certification artifact was written.',
        );
      }
    },
  });
}
