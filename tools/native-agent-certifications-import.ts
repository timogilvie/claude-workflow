#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { evaluateEligibility } from '../shared/lib/native-agent/certification/loader.ts';
import { parseCertificationPath } from '../shared/lib/native-agent/certification/loader.ts';
import {
  listLegacyCertifications,
  readCertification,
  writeCertification,
} from '../shared/lib/native-agent/certification/store.ts';
import { checkIdentity } from '../shared/lib/native-agent/certification/validator.ts';
import type { NativeCertificationArtifact } from '../shared/lib/native-agent/certification/schema.ts';

export interface ImportCertificationResult {
  sourcePath: string;
  imported: boolean;
  skipped: boolean;
  reason?: string;
  artifactPath?: string;
}

export interface ImportCertificationsOptions {
  repoDir: string;
  provider?: string;
  model?: string;
  suite?: string;
  dryRun?: boolean;
  now?: Date;
}

export function importLegacyCertifications(opts: ImportCertificationsOptions): ImportCertificationResult[] {
  const now = opts.now ?? new Date();
  const paths = listLegacyCertifications(opts.repoDir);
  const results: ImportCertificationResult[] = [];

  for (const sourcePath of paths) {
    const identity = parseCertificationPath(sourcePath);
    if (!identity) {
      results.push({ sourcePath, imported: false, skipped: true, reason: 'unrecognized-path' });
      continue;
    }
    if (opts.provider && identity.provider !== opts.provider) continue;
    if (opts.model && identity.model !== opts.model) continue;
    if (opts.suite && identity.suiteVersion !== opts.suite) continue;

    const read = readCertification(sourcePath);
    if (!read.ok) {
      results.push({ sourcePath, imported: false, skipped: true, reason: read.error.code });
      continue;
    }

    const validationReason = validateImportableArtifact(read.artifact, identity, now);
    if (validationReason) {
      results.push({ sourcePath, imported: false, skipped: true, reason: validationReason });
      continue;
    }

    const artifactPath = opts.dryRun ? undefined : writeCertification(opts.repoDir, read.artifact);
    results.push({
      sourcePath,
      imported: opts.dryRun !== true,
      skipped: opts.dryRun === true,
      reason: opts.dryRun ? 'dry-run' : undefined,
      artifactPath,
    });
  }

  return results;
}

function validateImportableArtifact(
  artifact: NativeCertificationArtifact,
  identity: { provider: string; model: string; suiteVersion: string },
  now: Date,
): string | undefined {
  const identityError = checkIdentity(artifact, identity.provider, identity.model);
  if (identityError) {
    return 'identity-mismatch';
  }
  const eligibility = evaluateEligibility(artifact, identity.suiteVersion, artifact.phase, now);
  return eligibility.eligible ? undefined : eligibility.reason;
}

if (import.meta.main) {
  runTool({
    name: 'native-agent-certifications-import',
    description: 'Import valid legacy repo-local native provider/model certifications into shared Wavemill storage.',
    options: {
      repo: {
        type: 'string',
        description: 'Repository directory containing legacy .wavemill/native-agent-certifications artifacts. Defaults to cwd.',
      },
      provider: {
        type: 'string',
        description: 'Optional provider filter.',
      },
      model: {
        type: 'string',
        description: 'Optional model filter.',
      },
      suite: {
        type: 'string',
        description: 'Optional suite version filter.',
      },
      'dry-run': {
        type: 'boolean',
        description: 'Validate import candidates without writing shared artifacts.',
      },
      json: {
        type: 'boolean',
        description: 'Emit machine-readable JSON.',
      },
    },
    examples: [
      'npx tsx tools/native-agent-certifications-import.ts --repo /path/to/repo --dry-run --json',
      'npx tsx tools/native-agent-certifications-import.ts --provider openrouter --suite v2',
    ],
    async run({ args }) {
      const results = importLegacyCertifications({
        repoDir: (args.repo as string | undefined) || process.cwd(),
        provider: args.provider as string | undefined,
        model: args.model as string | undefined,
        suite: args.suite as string | undefined,
        dryRun: args['dry-run'] === true,
      });

      if (args.json === true) {
        console.log(JSON.stringify({ results }, null, 2));
        return;
      }

      for (const result of results) {
        const status = result.imported ? 'IMPORTED' : result.skipped ? 'SKIPPED' : 'FAILED';
        console.log(`${status} ${result.sourcePath}${result.reason ? ` (${result.reason})` : ''}${result.artifactPath ? ` -> ${result.artifactPath}` : ''}`);
      }
    },
  });
}
