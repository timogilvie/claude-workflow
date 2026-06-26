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

interface ProviderModelPair {
  provider: SmokeProvider;
  model: string;
}

interface CertificationReport {
  certified: boolean;
  smokeSuiteRevision: string;
  artifactPath?: string;
  providers: PatchCodingProviderResult[];
}

function parseProviderModelPairs(args: { provider?: string[]; providers?: string | undefined }): ProviderModelPair[] {
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

function ensureDistinctMinimum(pairs: ProviderModelPair[]): void {
  const distinct = new Set(pairs.map((pair) => `${pair.provider}::${pair.model}`));
  if (distinct.size < 2) {
    throw new Error('Patch coding certification requires at least two distinct provider/model pairs.');
  }
  if (distinct.size !== pairs.length) {
    throw new Error('Duplicate provider/model pairs are not allowed in patch coding certification.');
  }
}

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
    ensureDistinctMinimum(pairs);

    const providerResults: PatchCodingProviderResult[] = [];
    for (const pair of pairs) {
      const smokeResult = args['dry-run'] === true
        ? await runNativeAgentDryRun({
          provider: pair.provider,
          phase: 'coding',
          repoDir,
          _modelIdOverride: pair.model,
          _certificationMode: true,
        })
        : await runNativeAgentLive({
          provider: pair.provider,
          phase: 'coding',
          repoDir,
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
      certified: allPassed && args['dry-run'] !== true,
      smokeSuiteRevision: PATCH_CODING_SMOKE_SUITE_REVISION,
      providers: providerResults,
    };

    if (report.certified) {
      const certification: PatchCodingCertification = {
        schemaVersion: PATCH_CODING_CERTIFICATION_SCHEMA_VERSION,
        certified: true,
        smokeSuiteRevision: PATCH_CODING_SMOKE_SUITE_REVISION,
        providers: providerResults,
        certifiedAt: new Date().toISOString(),
      };
      report.artifactPath = writePatchCodingCertification(repoDir, certification);
    }

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
      throw new Error(
        args['dry-run'] === true
          ? 'Dry-run completed. Certification artifact not written.'
          : 'Patch coding certification failed. No valid certification artifact was written.',
      );
    }
  },
});
