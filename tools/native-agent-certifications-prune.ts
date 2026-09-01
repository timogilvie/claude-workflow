#!/usr/bin/env -S npx tsx

import { runTool } from '../shared/lib/tool-runner.ts';
import { getEffectiveRegistry, type ModelRegistry } from '../shared/lib/model-registry.ts';
import {
  deleteGlobalCertification,
  evaluateSuiteCoverage,
  resolveCertificationStorage,
} from '../shared/lib/native-agent/certification/index.ts';

export interface PruneCandidate {
  provider: string;
  model: string;
  suiteVersion: string;
  path: string;
}

export interface PruneSummary {
  candidates: PruneCandidate[];
  pruned: PruneCandidate[];
  failures: Array<PruneCandidate & { reason: string }>;
  dryRun: boolean;
}

export function pruneOrphanCertifications(opts: {
  repoDir: string;
  root?: string;
  dryRun?: boolean;
  registry?: ModelRegistry;
}): PruneSummary {
  const root = resolveCertificationStorage({ scope: 'global', root: opts.root }).root;
  const registry = opts.registry ?? getEffectiveRegistry(opts.repoDir);
  const candidates = evaluateSuiteCoverage({ repoDir: opts.repoDir, registry, root }).orphanArtifacts;
  const dryRun = opts.dryRun !== false;
  const summary: PruneSummary = {
    candidates,
    pruned: [],
    failures: [],
    dryRun,
  };

  if (dryRun) {
    return summary;
  }

  for (const candidate of candidates) {
    try {
      deleteGlobalCertification({ ...candidate, root });
      summary.pruned.push(candidate);
    } catch (err) {
      summary.failures.push({
        ...candidate,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return summary;
}

export function renderPruneSummary(summary: PruneSummary): string {
  const action = summary.dryRun ? 'would prune' : 'pruned';
  const lines = [
    `${summary.candidates.length} orphan artifacts ${summary.dryRun ? 'found' : 'processed'}.`,
  ];
  for (const candidate of summary.dryRun ? summary.candidates : summary.pruned) {
    lines.push(`  ${action}: ${candidate.provider}/${candidate.model}/${candidate.suiteVersion} ${candidate.path}`);
  }
  for (const failure of summary.failures) {
    lines.push(`  failed: ${failure.provider}/${failure.model}/${failure.suiteVersion} - ${failure.reason}`);
  }
  return `${lines.join('\n')}\n`;
}

export function runPruneCommand(argv = process.argv.slice(2)): Promise<void> {
  return runTool({
    name: 'native-agent-certifications prune',
    description: 'Report and optionally remove orphaned global native-agent certification artifacts.',
    options: {
      repo: {
        type: 'string',
        description: 'Repository directory. Defaults to current working directory.',
      },
      'dry-run': {
        type: 'boolean',
        description: 'Report orphan artifacts without deleting them. This is the default.',
      },
      yes: {
        type: 'boolean',
        description: 'Delete orphan artifacts.',
      },
      json: {
        type: 'boolean',
        description: 'Emit machine-readable JSON.',
      },
    },
    examples: [
      'wavemill native-agent certifications prune',
      'wavemill native-agent certifications prune --yes',
      'wavemill native-agent certifications prune --json',
    ],
    async run({ args }) {
      const summary = pruneOrphanCertifications({
        repoDir: (args.repo as string | undefined) || process.cwd(),
        dryRun: args.yes !== true,
      });
      if (args.json === true) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        process.stdout.write(renderPruneSummary(summary));
      }
      if (summary.failures.length > 0) {
        process.exit(1);
      }
    },
  }, argv);
}

if (import.meta.main) {
  await runPruneCommand();
}
