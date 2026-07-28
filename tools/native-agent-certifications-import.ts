#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import {
  buildGlobalCertificationPath,
  checkIdentity,
  evaluateEligibility,
  listCertifications,
  readCertification,
  resolveCertificationStorageIdentity,
  writeGlobalCertification,
} from '../shared/lib/native-agent/certification/index.ts';

export interface ImportCertificationSummary {
  scanned: number;
  imported: Array<{ path: string; artifactPath: string; provider: string; model: string; suiteVersion: string }>;
  skipped: Array<{ path: string; reason: string }>;
  dryRun: boolean;
}

export function importLegacyCertifications(opts: {
  repoDir: string;
  provider?: string;
  model?: string;
  dryRun?: boolean;
  now?: Date;
}): ImportCertificationSummary {
  const paths = listCertifications(opts.repoDir);
  const summary: ImportCertificationSummary = {
    scanned: paths.length,
    imported: [],
    skipped: [],
    dryRun: opts.dryRun === true,
  };

  for (const path of paths) {
    const read = readCertification(path);
    if (!read.ok) {
      summary.skipped.push({ path, reason: read.error.code });
      continue;
    }

    const storageIdentity = resolveCertificationStorageIdentity(read.artifact.provider, read.artifact.model);
    if (opts.provider && storageIdentity.provider !== opts.provider && read.artifact.provider !== opts.provider) {
      summary.skipped.push({ path, reason: 'provider-filter' });
      continue;
    }
    if (opts.model && storageIdentity.model !== opts.model && read.artifact.model !== opts.model) {
      summary.skipped.push({ path, reason: 'model-filter' });
      continue;
    }

    const identityError = checkIdentity(read.artifact, storageIdentity.provider, storageIdentity.model);
    if (identityError) {
      summary.skipped.push({ path, reason: `identity-${identityError}` });
      continue;
    }

    const eligibility = evaluateEligibility(
      read.artifact,
      read.artifact.suiteVersion,
      read.artifact.phase,
      opts.now ?? new Date(),
    );
    if (!eligibility.eligible) {
      summary.skipped.push({ path, reason: eligibility.reason });
      continue;
    }

    const artifactPath = opts.dryRun === true
      ? buildGlobalCertificationPath(storageIdentity.provider, storageIdentity.model, read.artifact.suiteVersion)
      : writeGlobalCertification(read.artifact);
    summary.imported.push({
      path,
      artifactPath,
      provider: read.artifact.provider,
      model: read.artifact.model,
      suiteVersion: read.artifact.suiteVersion,
    });
  }

  return summary;
}

if (import.meta.main) {
  runTool({
    name: 'native-agent-certifications-import',
    description: 'Import valid legacy repo-local native-agent certification artifacts into shared Wavemill storage.',
    options: {
      repo: {
        type: 'string',
        description: 'Repository directory to scan. Defaults to current working directory.',
      },
      provider: {
        type: 'string',
        description: 'Optional provider filter.',
      },
      model: {
        type: 'string',
        description: 'Optional storage-model filter.',
      },
      'dry-run': {
        type: 'boolean',
        description: 'Validate and report without writing shared artifacts.',
      },
      json: {
        type: 'boolean',
        description: 'Emit machine-readable JSON.',
      },
    },
    examples: [
      'npx tsx tools/native-agent-certifications-import.ts --repo /path/to/repo',
      'npx tsx tools/native-agent-certifications-import.ts --dry-run --json',
    ],
    async run({ args }) {
      const summary = importLegacyCertifications({
        repoDir: (args.repo as string | undefined) || process.cwd(),
        provider: args.provider as string | undefined,
        model: args.model as string | undefined,
        dryRun: args['dry-run'] === true,
      });

      if (args.json === true) {
        console.log(JSON.stringify(summary, null, 2));
        return;
      }

      console.log(`Scanned:  ${summary.scanned}`);
      console.log(`Imported: ${summary.imported.length}${summary.dryRun ? ' (dry-run)' : ''}`);
      console.log(`Skipped:  ${summary.skipped.length}`);
      for (const entry of summary.imported) {
        console.log(`  imported ${entry.provider}/${entry.model}/${entry.suiteVersion}${entry.artifactPath ? ` -> ${entry.artifactPath}` : ''}`);
      }
      for (const entry of summary.skipped) {
        console.log(`  skipped ${entry.path}: ${entry.reason}`);
      }
    },
  });
}
