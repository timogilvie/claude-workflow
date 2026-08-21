import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChallengeComparison } from './challenge-comparison.ts';
import { resolveEvalsDir } from './evals-paths.ts';
import type { EvalRecord } from './eval-schema.ts';
import { readJsonlFile, readTransformWrite } from './jsonl-utils.ts';
import {
  computeHarnessId,
  resolveManifestDir,
  type ResourceManifest,
} from './resource-manifest.ts';

export interface BackfillHarnessIdsOptions {
  repoDir?: string;
  dryRun?: boolean;
}

export interface BackfillTargetSummary {
  processed: number;
  changed: number;
  unmapped: number;
  malformed: number;
  skipped?: number;
}

export interface BackfillHarnessIdsSummary {
  manifests: BackfillTargetSummary;
  evals: BackfillTargetSummary;
  challenges: BackfillTargetSummary;
  routeArtifacts: BackfillTargetSummary & { reason: string };
}

function emptySummary(): BackfillTargetSummary {
  return { processed: 0, changed: 0, unmapped: 0, malformed: 0 };
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.harness-backfill-${randomUUID()}.tmp`);
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, path);
}

function backfillManifests(repoDir?: string, dryRun?: boolean): BackfillTargetSummary {
  const summary = emptySummary();
  const manifestDir = resolveManifestDir(repoDir);
  if (!existsSync(manifestDir)) {
    return summary;
  }

  for (const file of readdirSync(manifestDir).sort()) {
    if (!file.endsWith('.json')) {
      continue;
    }
    const path = join(manifestDir, file);
    summary.processed += 1;
    let manifest: ResourceManifest;
    try {
      manifest = JSON.parse(readFileSync(path, 'utf-8')) as ResourceManifest;
    } catch (error) {
      summary.malformed += 1;
      console.warn(`[backfill-harness-ids] Skipping malformed manifest ${path}: ${(error as Error).message}`);
      continue;
    }

    if (manifest.harnessId) {
      continue;
    }
    manifest.harnessId = computeHarnessId(manifest.resources || []);
    summary.changed += 1;
    if (!dryRun) {
      atomicWriteJson(path, manifest);
    }
  }
  return summary;
}

function loadManifestHarnessIndex(repoDir?: string): Map<string, string> {
  const index = new Map<string, string>();
  const manifestDir = resolveManifestDir(repoDir);
  if (!existsSync(manifestDir)) {
    return index;
  }
  for (const file of readdirSync(manifestDir).sort()) {
    if (!file.endsWith('.json')) {
      continue;
    }
    try {
      const manifest = JSON.parse(readFileSync(join(manifestDir, file), 'utf-8')) as ResourceManifest;
      index.set(manifest.sessionId || file.slice(0, -'.json'.length), manifest.harnessId ?? computeHarnessId(manifest.resources || []));
    } catch {
      // Malformed manifests are counted by backfillManifests and ignored here.
    }
  }
  return index;
}

function backfillEvalRecords(evalsPath: string, manifestHarnessBySession: Map<string, string>, dryRun?: boolean): BackfillTargetSummary {
  const summary = emptySummary();
  if (!existsSync(evalsPath)) {
    return summary;
  }

  const result = readTransformWrite<EvalRecord>(evalsPath, (record) => {
    summary.processed += 1;
    if (record.harnessId) {
      return { record, changed: false };
    }
    const sessionId = record.manifestRef?.sessionId;
    if (!sessionId) {
      summary.unmapped += 1;
      return { record, changed: false };
    }
    const harnessId = manifestHarnessBySession.get(sessionId);
    if (!harnessId) {
      summary.unmapped += 1;
      return { record, changed: false };
    }
    return {
      record: { ...record, harnessId },
      changed: true,
    };
  }, { dryRun });

  summary.changed = result.recordsChanged;
  summary.malformed = result.malformedLines;
  return summary;
}

interface PrHarnessIndexEntry {
  harnessId?: string;
  count: number;
}

function buildPrHarnessIndex(evalsPath: string): Map<string, PrHarnessIndexEntry> {
  const index = new Map<string, PrHarnessIndexEntry>();
  if (!existsSync(evalsPath)) {
    return index;
  }
  for (const record of readJsonlFile<EvalRecord>(evalsPath)) {
    if (!record.prUrl) {
      continue;
    }
    const existing = index.get(record.prUrl) ?? { count: 0 };
    existing.count += 1;
    if (record.harnessId && (!existing.harnessId || existing.harnessId === record.harnessId)) {
      existing.harnessId = record.harnessId;
    } else if (record.harnessId && existing.harnessId !== record.harnessId) {
      existing.harnessId = undefined;
    }
    index.set(record.prUrl, existing);
  }
  return index;
}

function uniqueHarnessForPr(index: Map<string, PrHarnessIndexEntry>, prUrl: string): string | null {
  const entry = index.get(prUrl);
  if (!entry || entry.count !== 1 || !entry.harnessId) {
    return null;
  }
  return entry.harnessId;
}

function backfillChallengeRecords(challengePath: string, evalsPath: string, dryRun?: boolean): BackfillTargetSummary {
  const summary = emptySummary();
  if (!existsSync(challengePath)) {
    return summary;
  }
  const prHarnessIndex = buildPrHarnessIndex(evalsPath);

  const result = readTransformWrite<ChallengeComparison>(challengePath, (record) => {
    summary.processed += 1;
    let changed = false;
    const next: ChallengeComparison = { ...record };
    if (!next.primaryHarnessId) {
      const harnessId = uniqueHarnessForPr(prHarnessIndex, next.primaryPrUrl);
      if (harnessId) {
        next.primaryHarnessId = harnessId;
        changed = true;
      } else {
        summary.unmapped += 1;
      }
    }
    if (!next.challengerHarnessId) {
      const harnessId = uniqueHarnessForPr(prHarnessIndex, next.challengerPrUrl);
      if (harnessId) {
        next.challengerHarnessId = harnessId;
        changed = true;
      } else {
        summary.unmapped += 1;
      }
    }
    return { record: next, changed };
  }, { dryRun });

  summary.changed = result.recordsChanged;
  summary.malformed = result.malformedLines;
  return summary;
}

export function backfillHarnessIds(options: BackfillHarnessIdsOptions = {}): BackfillHarnessIdsSummary {
  const repoDir = options.repoDir ? resolve(options.repoDir) : undefined;
  const evalsDir = resolveEvalsDir(undefined, repoDir).dir;
  const evalsPath = join(evalsDir, 'evals.jsonl');
  const challengePath = join(evalsDir, 'challenge-records.jsonl');

  const manifests = backfillManifests(repoDir, options.dryRun);
  const manifestHarnessBySession = loadManifestHarnessIndex(repoDir);
  const evals = backfillEvalRecords(evalsPath, manifestHarnessBySession, options.dryRun);
  const challenges = backfillChallengeRecords(challengePath, evalsPath, options.dryRun);

  return {
    manifests,
    evals,
    challenges,
    routeArtifacts: {
      processed: 0,
      changed: 0,
      unmapped: 0,
      malformed: 0,
      skipped: 1,
      reason: 'Archived route artifacts have no stable session key; not backfilled.',
    },
  };
}
