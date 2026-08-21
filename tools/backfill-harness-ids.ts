#!/usr/bin/env -S npx tsx
import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';
import { readEvalRecords } from '../shared/lib/eval-persistence.ts';
import { resolveEvalsDir } from '../shared/lib/evals-paths.ts';
import { readTransformWrite } from '../shared/lib/jsonl-utils.ts';
import {
  computeHarnessId,
  getManifest,
  resolveHarnessId,
  saveManifest,
} from '../shared/lib/resource-manifest.ts';
import { deriveChallengeHarnessIds, type ChallengeComparison } from '../shared/lib/challenge-comparison.ts';
import type { EvalRecord } from '../shared/lib/eval-schema.ts';

interface CountSummary {
  scanned: number;
  updated: number;
  alreadySet: number;
  unmapped: number;
}

runTool({
  name: 'backfill-harness-ids',
  description: 'Best-effort backfill of harnessId on manifests, eval records, and challenge records',
  options: {
    'repo-dir': { type: 'string', description: 'Repository directory override' },
    'dry-run': { type: 'boolean', description: 'Report changes without writing them' },
  },
  async run({ args }) {
    const repoDir = args['repo-dir'] as string | undefined;
    const dryRun = Boolean(args['dry-run']);
    const evalsDir = resolveEvalsDir(undefined, repoDir).dir;

    const manifestSummary = backfillManifests(repoDir, dryRun);
    const evalSummary = backfillEvals(evalsDir, repoDir, dryRun);
    const evalRecords = readEvalRecords({ dir: evalsDir });
    const challengeSummary = backfillChallenges(evalsDir, evalRecords, dryRun);
    const routeSummary = backfillRoutes(evalsDir);

    console.log(JSON.stringify({
      manifests: manifestSummary,
      evals: evalSummary,
      challenges: challengeSummary,
      routes: routeSummary,
    }, null, 2));
  },
});

function backfillManifests(repoDir: string | undefined, dryRun: boolean): CountSummary {
  const summary: CountSummary = { scanned: 0, updated: 0, alreadySet: 0, unmapped: 0 };
  const dir = resolve((repoDir || process.cwd()), '.wavemill', 'manifests');
  if (!existsSync(dir)) {
    return summary;
  }

  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const sessionId = entry.slice(0, -5);
    summary.scanned++;
    const manifest = getManifest(sessionId, repoDir);
    if (!manifest) {
      summary.unmapped++;
      console.warn(`[backfill-harness-ids] Skipping unparsable manifest ${entry}`);
      continue;
    }
    if (manifest.harnessId) {
      summary.alreadySet++;
      continue;
    }
    manifest.harnessId = computeHarnessId(manifest.resources);
    if (!dryRun) {
      saveManifest(manifest, repoDir);
    }
    summary.updated++;
  }

  return summary;
}

function backfillEvals(evalsDir: string, repoDir: string | undefined, dryRun: boolean): CountSummary {
  const summary: CountSummary = { scanned: 0, updated: 0, alreadySet: 0, unmapped: 0 };
  const path = `${evalsDir}/evals.jsonl`;
  if (!existsSync(path)) {
    return summary;
  }

  readTransformWrite<Record<string, unknown>>(path, (record) => {
    summary.scanned++;
    if ((record as EvalRecord).harnessId) {
      summary.alreadySet++;
      return { record, changed: false };
    }
    const sessionId = resolveEvalSessionId(record);
    if (!sessionId) {
      summary.unmapped++;
      return { record, changed: false };
    }
    const harnessId = resolveHarnessId(sessionId, repoDir);
    if (!harnessId) {
      summary.unmapped++;
      return { record, changed: false };
    }
    summary.updated++;
    return {
      record: { ...record, harnessId },
      changed: true,
    };
  }, { dryRun });

  return summary;
}

function backfillChallenges(evalsDir: string, evalRecords: EvalRecord[], dryRun: boolean): CountSummary {
  const summary: CountSummary = { scanned: 0, updated: 0, alreadySet: 0, unmapped: 0 };
  const path = `${evalsDir}/challenge-records.jsonl`;
  if (!existsSync(path)) {
    return summary;
  }

  readTransformWrite<Record<string, unknown>>(path, (record) => {
    summary.scanned++;
    const cast = record as Partial<ChallengeComparison>;
    if (cast.primaryHarnessId || cast.challengerHarnessId || cast.harnessId) {
      summary.alreadySet++;
      return { record, changed: false };
    }
    const pairId = cast.challengePairId;
    const primaryPrUrl = cast.primaryPrUrl;
    const challengerPrUrl = cast.challengerPrUrl;
    if (!pairId || !primaryPrUrl || !challengerPrUrl) {
      summary.unmapped++;
      return { record, changed: false };
    }
    const primaryEval = evalRecords.find((r) => r.challengePairId === pairId && r.prUrl === primaryPrUrl);
    const challengerEval = evalRecords.find((r) => r.challengePairId === pairId && r.prUrl === challengerPrUrl);
    const ids = deriveChallengeHarnessIds(primaryEval, challengerEval);
    if (!ids.primaryHarnessId && !ids.challengerHarnessId) {
      summary.unmapped++;
      return { record, changed: false };
    }
    summary.updated++;
    return {
      record: { ...record, ...ids },
      changed: true,
    };
  }, { dryRun });

  return summary;
}

function backfillRoutes(evalsDir: string): { scanned: number; unmapped: number } {
  const summary = { scanned: 0, unmapped: 0 };
  const dir = resolve(evalsDir, 'artifacts');
  if (!existsSync(dir)) {
    return summary;
  }
  for (const entry of readdirSync(dir)) {
    const issueDir = resolve(dir, entry);
    if (!existsSync(issueDir)) {
      continue;
    }
    for (const file of readdirSync(issueDir)) {
      if (file.endsWith('.json')) {
        summary.scanned++;
      }
    }
  }
  summary.unmapped = summary.scanned; // route artifacts carry no session id; leave untouched
  return summary;
}

function resolveEvalSessionId(record: Record<string, unknown>): string | undefined {
  const cast = record as Record<string, unknown> & { metadata?: Record<string, unknown> };
  return (cast.sessionId as string | undefined)
    || (cast.manifestRef as { sessionId?: string } | undefined)?.sessionId
    || (cast.metadata?.sessionId as string | undefined);
}
