#!/usr/bin/env -S npx tsx

/**
 * Backfill per-stage model attribution onto eval records that have a parseable
 * routingDecision.decisionRationale but no taskDescriptor.stages attribution.
 *
 * Without stage attribution the KNN router falls back to record.modelId (the
 * coder/solutionModel) when scoring planner candidates, which mis-attributes
 * plan quality to whoever happened to be the coder. Populating stages.planner
 * .model from the rationale string fixes this for records where we saved a
 * rationale but not a structured stage map.
 *
 * For records where the metadata.stageScores contain per-stage scores, we
 * also copy them into the matching stages.<role>.score field so the router's
 * stage-specific score path sees them without needing the metadata fallback.
 *
 * Rationale format:
 *   "Routing: planner=X, coder=Y, reviewer=Z; planDepth=..., codeDepth=..."
 *
 * Usage:
 *   npx tsx tools/backfill-stage-attribution.ts --dry-run
 *   npx tsx tools/backfill-stage-attribution.ts
 *   npx tsx tools/backfill-stage-attribution.ts --file path/to/file.jsonl
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runTool } from '../shared/lib/tool-runner.ts';

interface StageBlock {
  model: string;
  score?: number;
  cost_usd?: number;
  time_minutes?: number;
}

interface EvalRecord {
  id?: string;
  issueId?: string;
  modelId?: string;
  workflowTokenUsage?: Record<string, { costUsd?: number }>;
  metadata?: {
    stageScores?: Record<string, { score?: number } | undefined>;
  };
  routingDecision?: {
    decisionRationale?: string;
  };
  taskDescriptor?: {
    stages?: Record<string, StageBlock>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const ROLE_TO_SCORE_KEY: Record<'planner' | 'coder' | 'reviewer', string> = {
  planner: 'plan',
  coder: 'implementation',
  reviewer: 'review',
};

const RATIONALE_PATTERN = /planner=(\S+?),\s*coder=(\S+?),\s*reviewer=([^;\s]+)/;

function parseRationale(
  rationale: string | undefined,
): { planner: string; coder: string; reviewer: string } | null {
  if (!rationale) return null;
  const match = rationale.match(RATIONALE_PATTERN);
  if (!match) return null;
  const [, planner, coder, reviewer] = match;
  const clean = (s: string) => s.trim().replace(/[;,]$/, '');
  return { planner: clean(planner), coder: clean(coder), reviewer: clean(reviewer) };
}

function hasStageAttribution(record: EvalRecord): boolean {
  const stages = record.taskDescriptor?.stages;
  if (!stages) return false;
  const planner = stages.planner?.model;
  return typeof planner === 'string' && planner.length > 0;
}

function buildStageBlock(
  role: 'planner' | 'coder' | 'reviewer',
  model: string,
  record: EvalRecord,
): StageBlock {
  const block: StageBlock = { model };
  const scoreKey = ROLE_TO_SCORE_KEY[role];
  const stageScore = record.metadata?.stageScores?.[scoreKey]?.score;
  if (typeof stageScore === 'number') {
    block.score = stageScore;
  }
  const tokenUsage = record.workflowTokenUsage?.[model]?.costUsd;
  if (typeof tokenUsage === 'number') {
    block.cost_usd = tokenUsage;
  }
  return block;
}

function applyBackfill(record: EvalRecord): boolean {
  if (hasStageAttribution(record)) return false;
  const parsed = parseRationale(record.routingDecision?.decisionRationale);
  if (!parsed) return false;

  const stages: Record<string, StageBlock> = {
    planner: buildStageBlock('planner', parsed.planner, record),
    coder: buildStageBlock('coder', parsed.coder, record),
    reviewer: buildStageBlock('reviewer', parsed.reviewer, record),
  };

  if (!record.taskDescriptor || typeof record.taskDescriptor !== 'object') {
    // Create a minimal descriptor skeleton. Downstream consumers treat missing
    // signals/constraints as undefined, which is acceptable for legacy records.
    record.taskDescriptor = { schema_version: '1.0', stages } as EvalRecord['taskDescriptor'];
  } else {
    record.taskDescriptor.stages = stages;
  }

  return true;
}

function processFile(filePath: string, dryRun: boolean): { total: number; changed: number } {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  let changed = 0;
  const out: string[] = [];

  for (const line of lines) {
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    let record: EvalRecord;
    try {
      record = JSON.parse(line);
    } catch {
      out.push(line);
      continue;
    }
    if (applyBackfill(record)) {
      changed += 1;
      out.push(JSON.stringify(record));
    } else {
      out.push(line);
    }
  }

  if (!dryRun && changed > 0) {
    writeFileSync(filePath, out.join('\n'), 'utf-8');
  }

  return { total: lines.filter((l) => l.trim()).length, changed };
}

const DEFAULT_TARGETS = [
  '/Users/timothyogilvie/Dropbox/wavemill/.wavemill/evals/evals.jsonl',
  '/Users/timothyogilvie/Dropbox/wavemill/.wavemill/evals/aggregated-evals.jsonl',
  '/Users/timothyogilvie/Dropbox/Hokusai/hokusai-infrastructure/.wavemill/evals/evals.jsonl',
];

runTool({
  name: 'backfill-stage-attribution',
  description:
    'Parse routingDecision.decisionRationale to populate taskDescriptor.stages on legacy records',
  options: {
    file: { type: 'string', description: 'Specific JSONL file (otherwise backfills built-in defaults)' },
    'dry-run': { type: 'boolean', description: 'Report what would change without writing' },
  },
  examples: [
    'npx tsx tools/backfill-stage-attribution.ts --dry-run',
    'npx tsx tools/backfill-stage-attribution.ts',
    'npx tsx tools/backfill-stage-attribution.ts --file path/to/evals.jsonl',
  ],
  run({ args }) {
    const dryRun = Boolean(args['dry-run']);
    const targets = args.file ? [resolve(args.file as string)] : DEFAULT_TARGETS;

    let totalRecords = 0;
    let totalChanged = 0;
    for (const target of targets) {
      if (!existsSync(target)) {
        console.log(`[skip] ${target} (not found)`);
        continue;
      }
      const { total, changed } = processFile(target, dryRun);
      totalRecords += total;
      totalChanged += changed;
      const prefix = dryRun ? '[dry-run]' : '[updated]';
      console.log(`${prefix} ${target}: ${changed}/${total} records backfilled`);
    }

    console.log('');
    console.log(`${dryRun ? 'Would backfill' : 'Backfilled'} ${totalChanged} of ${totalRecords} records.`);
  },
});
